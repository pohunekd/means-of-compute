// Settle tests: the close race, the grant-close drain and settle
// determinism across restarts of section 4.6.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadMeterConfig, resolveMeterEnv } from "../../src/meter/config.js";
import type { MeterConfig } from "../../src/meter/config.js";
import { startMeter, type Meter } from "../../src/meter/meter.js";
import { startLoopback } from "../../src/providers/loopback.js";
import { resetProvidersCache } from "../../src/providers/config.js";

interface Rig {
  readonly meter: Meter;
  readonly logPath: string;
  readonly token: string;
  readonly stop: () => Promise<void>;
}

async function startRig(
  recordingsPath: string,
  meterOverrides: Partial<MeterConfig> = {},
): Promise<Rig> {
  const secret = randomBytes(32).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "meter-settle-"));
  const hostsFile = join(dir, "hosts.json");
  const logPath = join(dir, "usage.jsonl");
  await Bun.write(hostsFile, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
  const loopback = await startLoopback(recordingsPath);
  resetProvidersCache();
  process.env.META_API_KEY = "test-meta-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  const base = await loadMeterConfig();
  const config: MeterConfig = { ...base, usageLogPath: logPath, ...meterOverrides };
  const env = await resolveMeterEnv(config, {
    MOC_METER_LISTEN: "127.0.0.1:0",
    MOC_METER_SECRET: secret,
    MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
  });
  const { getProviders } = await import("../../src/providers/config.js");
  const providers = await getProviders();
  const meter = await startMeter({ config, env, providers, now: () => new Date(), log: () => {} });
  await meter.openGrant({
    requestId: "w1-demo:0",
    workItemId: "w1-demo",
    hostAlias: "laptop-a",
    providerId: "meta-api",
    model: "muse-spark-1.3-contributor",
  });
  await meter.bindGrant("w1-demo:0", "sess-1");
  return {
    meter,
    logPath,
    token: meter.tokenFor("w1-demo:0"),
    stop: async () => {
      await meter.close();
      await loopback.stop();
      resetProvidersCache();
      delete process.env.PROVIDER_META_API_BASE_URL;
      delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
      delete process.env.META_API_KEY;
      delete process.env.NVIDIA_API_KEY;
      delete process.env.LOCAL_MODEL_BASE_URL;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function chatBody(): Record<string, unknown> {
  return { model: "moc-session", messages: [{ role: "user", content: "hi" }], stream: true };
}

test("close race: concurrent calls are either counted or refused", async () => {
  const rig = await startRig("tests/meter/recordings/stream-slow-chunks.json", {
    maxInFlightPerSession: 32,
    idleTimeoutMs: 60000,
    totalTimeoutMs: 60000,
  });
  try {
    const url = `http://127.0.0.1:${String(rig.meter.port)}/v1/chat/completions`;
    const calls = Array.from({ length: 20 }, () =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${rig.token}` },
        body: JSON.stringify(chatBody()),
      }),
    );
    // Let the call-starts land before the grant closes.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settlePromise = rig.meter.settle("sess-1", "finished");
    const responses = await Promise.all(calls);
    const usage = await settlePromise;
    let ok = 0;
    for (const resp of responses) {
      if (resp.status === 200) {
        ok += 1;
        await resp.text().catch(() => "");
      } else {
        // Refused either by the closed grant or by the concurrency limit.
        expect([403, 429].includes(resp.status)).toBe(true);
        await resp.text().catch(() => "");
      }
    }
    // Every call either has its call-start before grant-close and is in the
    // join, or got 403 and is absent.
    const text = await Bun.file(rig.logPath).text();
    const starts = text.split("\n").filter((l) => l.includes('"kind":"call-start"')).length;
    expect(usage?.tokens[0]?.requests).toBe(starts);
    expect(usage?.tokens[0]?.requests).toBe(ok);
    expect(starts).toBeGreaterThan(0);
  } finally {
    await rig.stop().catch(() => {});
  }
});

test("drain: settle aborts a slow call and waits for its end", async () => {
  const rig = await startRig("tests/meter/recordings/stream-slow-chunks.json", {
    drainTimeoutMs: 100,
    idleTimeoutMs: 60000,
    totalTimeoutMs: 60000,
  });
  try {
    const url = `http://127.0.0.1:${String(rig.meter.port)}/v1/chat/completions`;
    const pending = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rig.token}` },
      body: JSON.stringify(chatBody()),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const usage = await rig.meter.settle("sess-1", "finished");
    const resp = await pending;
    await resp.text().catch(() => "");
    expect(usage?.tokens[0]?.requests).toBe(1);
    expect(usage?.tokens[0]?.inputTokens).toBeNull();
    const text = await Bun.file(rig.logPath).text();
    const endLine = text.split("\n").find((l) => l.includes('"kind":"call-end"')) ?? "{}";
    expect((JSON.parse(endLine) as { outcome: string }).outcome).toBe("closed-abort");
  } finally {
    await rig.stop().catch(() => {});
  }
});

test("determinism: settle twice, restart, settle again", async () => {
  const secret = randomBytes(32).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "meter-restart-"));
  const hostsFile = join(dir, "hosts.json");
  const logPath = join(dir, "usage.jsonl");
  await Bun.write(hostsFile, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
  const loopback = await startLoopback("tests/meter/recordings/stream-ok.json");
  resetProvidersCache();
  process.env.META_API_KEY = "test-meta-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  const events: unknown[] = [];
  try {
    const base = await loadMeterConfig();
    const config: MeterConfig = { ...base, usageLogPath: logPath };
    const envOf = async (): Promise<Awaited<ReturnType<typeof resolveMeterEnv>>> =>
      resolveMeterEnv(config, {
        MOC_METER_LISTEN: "127.0.0.1:0",
        MOC_METER_SECRET: secret,
        MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
      });
    const { getProviders } = await import("../../src/providers/config.js");
    const providers = await getProviders();
    const first = await startMeter({
      config,
      env: await envOf(),
      providers,
      now: () => new Date(),
      log: () => {},
    });
    await first.openGrant({
      requestId: "w1-demo:0",
      workItemId: "w1-demo",
      hostAlias: "laptop-a",
      providerId: "meta-api",
      model: "muse-spark-1.3-contributor",
    });
    await first.bindGrant("w1-demo:0", "sess-1");
    const token = first.tokenFor("w1-demo:0");
    const resp = await fetch(`http://127.0.0.1:${String(first.port)}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(chatBody()),
    });
    expect(resp.status).toBe(200);
    await resp.text();
    const once = await first.settle("sess-1", "finished");
    const twice = await first.settle("sess-1", "finished");
    expect(twice).toEqual(once);
    await first.close();
    const second = await startMeter({
      config,
      env: await envOf(),
      providers,
      now: () => new Date(),
      log: () => {},
    });
    try {
      const again = await second.settle("sess-1", "finished");
      expect(again).toEqual(once);
      expect(events).toEqual([]);
    } finally {
      await second.close();
    }
  } finally {
    await loopback.stop();
    resetProvidersCache();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.META_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.LOCAL_MODEL_BASE_URL;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Proxy tests: one row per section 9 rule of design sections 1.5, 3.2, 3.3,
// 3.5, 3.7 and 5.3.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadMeterConfig, resolveMeterEnv } from "../../src/meter/config.js";
import type { MeterConfig } from "../../src/meter/config.js";
import { startMeter } from "../../src/meter/meter.js";
import { startLoopback } from "../../src/providers/loopback.js";
import { resetProvidersCache } from "../../src/providers/config.js";
import { meterUrl, openBoundGrant, readLogLines, withMeter } from "./helpers.js";

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "moc-session",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    ...overrides,
  };
}

async function post(
  meter: { readonly port: number },
  token: string | null,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(meterUrl(meter), { method: "POST", headers, body: JSON.stringify(body) });
}

test("auth order: no token gives 401 and the loopback sees nothing", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter }) => {
    const resp = await fetch(meterUrl(meter), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatBody()),
    });
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });
});

test("auth order: a token for an unknown grant gives 403", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter, tokenFor }) => {
    const resp = await post(meter, tokenFor("w9-unknown:0"), chatBody());
    expect(resp.status).toBe(403);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("no-grant");
  });
});

test("wrong host gives 403", async () => {
  const secret = randomBytes(32).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "meter-wronghost-"));
  const hostsFile = join(dir, "hosts.json");
  const logPath = join(dir, "usage.jsonl");
  await Bun.write(hostsFile, JSON.stringify({ "laptop-a": ["127.0.0.2"] }));
  const loopback = await startLoopback("tests/meter/recordings/stream-ok.json");
  resetProvidersCache();
  process.env.META_API_KEY = "test-meta-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  try {
    const base = await loadMeterConfig();
    const config: MeterConfig = { ...base, usageLogPath: logPath };
    const env = await resolveMeterEnv(config, {
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: secret,
      MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
    });
    const { getProviders } = await import("../../src/providers/config.js");
    const providers = await getProviders();
    const meter = await startMeter({
      config,
      env,
      providers,
      now: () => new Date(),
      log: () => {},
    });
    try {
      await meter.openGrant({
        requestId: "w1-demo:0",
        workItemId: "w1-demo",
        hostAlias: "laptop-a",
        providerId: "meta-api",
        model: "muse-spark-1.3-contributor",
      });
      await meter.bindGrant("w1-demo:0", "sess-1");
      const resp = await post(meter, meter.tokenFor("w1-demo:0"), chatBody());
      expect(resp.status).toBe(403);
      expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("wrong-host");
      expect(loopback.requests().length).toBe(0);
    } finally {
      await meter.close();
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

test("unbound grant past TTL gives 403, then 200 after bind", async () => {
  const openedAt = new Date("2026-10-27T10:00:00.000Z");
  let now = openedAt;
  const secret = randomBytes(32).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "meter-ttl-"));
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
  try {
    const base = await loadMeterConfig();
    const config: MeterConfig = { ...base, usageLogPath: logPath, unboundGrantTtlMs: 1000 };
    const env = await resolveMeterEnv(config, {
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: secret,
      MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
    });
    const { getProviders } = await import("../../src/providers/config.js");
    const providers = await getProviders();
    const meter = await startMeter({ config, env, providers, now: () => now, log: () => {} });
    try {
      await meter.openGrant({
        requestId: "w1-demo:0",
        workItemId: "w1-demo",
        hostAlias: "laptop-a",
        providerId: "meta-api",
        model: "muse-spark-1.3-contributor",
      });
      now = new Date(openedAt.getTime() + 2000);
      const denied = await post(meter, meter.tokenFor("w1-demo:0"), chatBody());
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
        "grant-unbound",
      );
      await meter.bindGrant("w1-demo:0", "sess-1");
      const allowed = await post(meter, meter.tokenFor("w1-demo:0"), chatBody());
      expect(allowed.status).toBe(200);
      await allowed.text();
    } finally {
      await meter.close();
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

test("caller model is rejected and the grant model is forwarded", async () => {
  await withMeter("tests/meter/recordings/json-ok.json", async ({ meter, tokenFor }) => {
    const { requestId } = await openBoundGrant(meter);
    const bad = await post(
      meter,
      tokenFor(requestId),
      chatBody({ model: "meta/muse-glimmer-30b" }),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("model-mismatch");
  });
});

test("key handling: upstream sees the provider key, never the caller token", async () => {
  const secret = randomBytes(32).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "meter-key-"));
  const hostsFile = join(dir, "hosts.json");
  const logPath = join(dir, "usage.jsonl");
  await Bun.write(hostsFile, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
  const loopback = await startLoopback("tests/meter/recordings/json-ok.json");
  resetProvidersCache();
  process.env.META_API_KEY = "test-meta-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  try {
    const base = await loadMeterConfig();
    const config: MeterConfig = { ...base, usageLogPath: logPath };
    const env = await resolveMeterEnv(config, {
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: secret,
      MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
    });
    const { getProviders } = await import("../../src/providers/config.js");
    const providers = await getProviders();
    const events: { level: string; event: string }[] = [];
    const meter = await startMeter({
      config,
      env,
      providers,
      now: () => new Date(),
      log: (e) => events.push(e),
    });
    try {
      const { token } = await openBoundGrant(meter);
      const resp = await post(meter, token, chatBody({ stream: false }), { "X-Caller-Probe": "1" });
      expect(resp.status).toBe(200);
      await resp.text();
      const seen = loopback.requests();
      expect(seen.length).toBe(1);
      const first = seen[0];
      expect(first).toBeDefined();
      expect(first?.headers["authorization"]).toBe("Bearer test-meta-key");
      expect(first?.headers["x-caller-probe"]).toBeUndefined();
      const bodies = await readLogLines(logPath);
      for (const line of [...bodies, JSON.stringify(events)]) {
        expect(line.includes("test-meta-key")).toBe(false);
        expect(line.includes(token)).toBe(false);
      }
    } finally {
      await meter.close();
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

test("include_usage is forced on streamed calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meter-include-"));
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
  try {
    const base = await loadMeterConfig();
    const config: MeterConfig = { ...base, usageLogPath: logPath };
    const env = await resolveMeterEnv(config, {
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: randomBytes(32).toString("base64"),
      MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
    });
    const { getProviders } = await import("../../src/providers/config.js");
    const providers = await getProviders();
    const meter = await startMeter({
      config,
      env,
      providers,
      now: () => new Date(),
      log: () => {},
    });
    try {
      const { token } = await openBoundGrant(meter);
      const resp = await post(meter, token, chatBody({ stream_options: { include_usage: false } }));
      expect(resp.status).toBe(200);
      await resp.text();
      const sent = JSON.parse(loopback.requests()[0]?.body ?? "{}") as Record<string, unknown>;
      expect((sent["stream_options"] as Record<string, unknown>)["include_usage"]).toBe(true);
    } finally {
      await meter.close();
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

test("no failover and no budget import: 429 passes through unbilled", async () => {
  const { readFileSync } = await import("node:fs");
  const proxySource = readFileSync("src/meter/proxy.ts", "utf8");
  expect(proxySource.includes("callWithFallback")).toBe(false);
  expect(proxySource.includes("src/budget")).toBe(false);
  expect(proxySource.includes("@/budget")).toBe(false);
  await withMeter(
    "tests/meter/recordings/upstream-429.json",
    async ({ meter, tokenFor, logPath }) => {
      const { requestId } = await openBoundGrant(meter, { providerId: "meta-api" });
      const resp = await post(meter, tokenFor(requestId), chatBody());
      expect(resp.status).toBe(429);
      await resp.text();
      const lines = await readLogLines(logPath);
      const end = JSON.parse(lines.find((l) => l.includes('"kind":"call-end"')) ?? "{}") as Record<
        string,
        unknown
      >;
      expect(end["outcome"]).toBe("upstream-status");
      expect(end["billed"]).toBe(false);
    },
  );
});

test("first-byte timeout is billed with null counts", async () => {
  await withMeter(
    "tests/meter/recordings/stream-slow-first-byte.json",
    async ({ meter, tokenFor, logPath }) => {
      const { requestId } = await openBoundGrant(meter);
      const resp = await post(meter, tokenFor(requestId), chatBody());
      expect(resp.status).toBe(504);
      expect(((await resp.json()) as { error: { code: string } }).error.code).toBe(
        "upstream-timeout",
      );
      const lines = await readLogLines(logPath);
      const end = JSON.parse(lines.find((l) => l.includes('"kind":"call-end"')) ?? "{}") as Record<
        string,
        unknown
      >;
      expect(end["outcome"]).toBe("first-byte-timeout");
      expect(end["billed"]).toBe(true);
      expect(end["inputTokens"]).toBeNull();
    },
    { firstByteTimeoutMs: 50 },
  );
});

test("idle timeout aborts a slow stream", async () => {
  await withMeter(
    "tests/meter/recordings/stream-slow-chunks.json",
    async ({ meter, tokenFor, logPath }) => {
      const { requestId } = await openBoundGrant(meter);
      const resp = await post(meter, tokenFor(requestId), chatBody());
      expect(resp.status).toBe(200);
      await resp.text().catch(() => "");
      const lines = await readLogLines(logPath);
      const end = JSON.parse(lines.find((l) => l.includes('"kind":"call-end"')) ?? "{}") as Record<
        string,
        unknown
      >;
      expect(end["outcome"]).toBe("idle-timeout");
      expect(end["billed"]).toBe(true);
    },
    { idleTimeoutMs: 50, firstByteTimeoutMs: 60000 },
  );
});

test("connection failure gives 502 and is not billed", async () => {
  const secret = randomBytes(32).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "meter-conn-"));
  const hostsFile = join(dir, "hosts.json");
  const logPath = join(dir, "usage.jsonl");
  await Bun.write(hostsFile, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
  resetProvidersCache();
  process.env.META_API_KEY = "test-meta-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_META_API_BASE_URL = "http://127.0.0.1:9";
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = "http://127.0.0.1:9";
  try {
    const base = await loadMeterConfig();
    const config: MeterConfig = { ...base, usageLogPath: logPath };
    const env = await resolveMeterEnv(config, {
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: secret,
      MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
    });
    const { getProviders } = await import("../../src/providers/config.js");
    const providers = await getProviders();
    const meter = await startMeter({
      config,
      env,
      providers,
      now: () => new Date(),
      log: () => {},
    });
    try {
      const { token } = await openBoundGrant(meter);
      const resp = await post(meter, token, chatBody());
      expect(resp.status).toBe(502);
      const lines = await readLogLines(logPath);
      const end = JSON.parse(lines.find((l) => l.includes('"kind":"call-end"')) ?? "{}") as Record<
        string,
        unknown
      >;
      expect(end["outcome"]).toBe("upstream-unreachable");
      expect(end["billed"]).toBe(false);
    } finally {
      await meter.close();
    }
  } finally {
    resetProvidersCache();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.META_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.LOCAL_MODEL_BASE_URL;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrency limit rejects without a call-start", async () => {
  await withMeter(
    "tests/meter/recordings/stream-slow-chunks.json",
    async ({ meter, logPath }) => {
      const { token } = await openBoundGrant(meter);
      const slow = await post(meter, token, chatBody());
      expect(slow.status).toBe(200);
      const slowBody = slow.text();
      const second = await post(meter, token, chatBody());
      expect(second.status).toBe(429);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
        "session-concurrency",
      );
      await slowBody;
      const lines = await readLogLines(logPath);
      expect(lines.filter((l) => l.includes('"kind":"call-start"')).length).toBe(1);
    },
    { maxInFlightPerSession: 1, idleTimeoutMs: 60000, totalTimeoutMs: 60000 },
  );
});

test("caller disconnect still records usage with clientGone", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter, logPath }) => {
    const { token } = await openBoundGrant(meter);
    const resp = await fetch(meterUrl(meter), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(chatBody()),
    });
    expect(resp.status).toBe(200);
    const reader = resp.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lines = await readLogLines(logPath);
    const end = JSON.parse(lines.find((l) => l.includes('"kind":"call-end"')) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(end["clientGone"]).toBe(true);
    expect(end["outcome"]).toBe("ok");
    expect(end["inputTokens"]).toBe(1200);
  });
});

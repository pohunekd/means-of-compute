// Config tests: one case per rule of design sections 2.1 and 2.2.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMeterConfig, resolveMeterEnv } from "../../src/meter/config.js";
import type { MeterConfig } from "../../src/meter/config.js";

function baseConfig(overrides: Partial<MeterConfig> = {}): MeterConfig {
  return {
    listenEnv: "MOC_METER_LISTEN",
    listenAlias: "factory",
    secretEnv: "MOC_METER_SECRET",
    hostAddressesFileEnv: "MOC_METER_HOST_ADDRESSES_FILE",
    usageLogPath: "logs/meter-usage.jsonl",
    sessionModelId: "moc-session",
    maxRequestBytes: 16777216,
    maxUsageScanBytes: 4194304,
    clientIdleTimeoutSec: 30,
    firstByteTimeoutMs: 300000,
    idleTimeoutMs: 120000,
    totalTimeoutMs: 1800000,
    drainTimeoutMs: 30000,
    unboundGrantTtlMs: 120000,
    maxInFlightPerSession: 4,
    ...overrides,
  };
}

const SECRET_32 = Buffer.from("x".repeat(32)).toString("base64");

function envWith(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    MOC_METER_LISTEN: "127.0.0.1:0",
    MOC_METER_SECRET: SECRET_32,
    MOC_METER_HOST_ADDRESSES_FILE: "/nonexistent",
    ...overrides,
  };
}

async function configFromObject(value: unknown): Promise<MeterConfig> {
  const dir = mkdtempSync(join(tmpdir(), "meter-config-"));
  const path = join(dir, "meter.json");
  try {
    await Bun.write(path, JSON.stringify(value));
    return await loadMeterConfig(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loads the committed config", async () => {
  const config = await loadMeterConfig();
  expect(config.listenEnv).toBe("MOC_METER_LISTEN");
  expect(config.sessionModelId).toBe("moc-session");
  expect(config.clientIdleTimeoutSec).toBe(30);
});

test("missing key fails", async () => {
  const raw = baseConfig() as unknown as Record<string, unknown>;
  delete raw["clientIdleTimeoutSec"];
  let message = "";
  try {
    await configFromObject(raw);
  } catch (error: unknown) {
    message = (error as Error).message;
  }
  expect(message).toContain('missing key "clientIdleTimeoutSec"');
});

test("extra key fails", async () => {
  let message = "";
  try {
    await configFromObject({ ...baseConfig(), extraKey: 1 });
  } catch (error: unknown) {
    message = (error as Error).message;
  }
  expect(message).toContain('unexpected key "extraKey"');
});

test("clientIdleTimeoutSec above 255 fails", async () => {
  let message = "";
  try {
    await configFromObject(baseConfig({ clientIdleTimeoutSec: 256 }));
  } catch (error: unknown) {
    message = (error as Error).message;
  }
  expect(message).toContain('"clientIdleTimeoutSec"');
});

test("totalTimeoutMs below firstByteTimeoutMs fails", async () => {
  let message = "";
  try {
    await configFromObject(baseConfig({ firstByteTimeoutMs: 5000, totalTimeoutMs: 1000 }));
  } catch (error: unknown) {
    message = (error as Error).message;
  }
  expect(message).toContain('"totalTimeoutMs"');
});

test("listen wildcard refused", async () => {
  for (const listen of ["0.0.0.0:8787", "[::]:8787"]) {
    const dir = mkdtempSync(join(tmpdir(), "meter-hosts-"));
    const file = join(dir, "hosts.json");
    await Bun.write(file, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
    try {
      let message = "";
      try {
        await resolveMeterEnv(
          baseConfig(),
          envWith({ MOC_METER_LISTEN: listen, MOC_METER_HOST_ADDRESSES_FILE: file }),
        );
      } catch (error: unknown) {
        message = (error as Error).message;
      }
      expect(message).toContain("must not be a wildcard");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("short secret refused", async () => {
  const short = Buffer.from("too-short").toString("base64");
  let message = "";
  try {
    await resolveMeterEnv(baseConfig(), envWith({ MOC_METER_SECRET: short }));
  } catch (error: unknown) {
    message = (error as Error).message;
  }
  expect(message).toContain("at least 32 bytes");
});

test("mapped address entry refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meter-hosts-"));
  const file = join(dir, "hosts.json");
  await Bun.write(file, JSON.stringify({ "laptop-a": ["::ffff:127.0.0.1"] }));
  try {
    let message = "";
    try {
      await resolveMeterEnv(baseConfig(), envWith({ MOC_METER_HOST_ADDRESSES_FILE: file }));
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain("mapped address");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared address refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meter-hosts-"));
  const file = join(dir, "hosts.json");
  await Bun.write(file, JSON.stringify({ "laptop-a": ["127.0.0.1"], "laptop-b": ["127.0.0.1"] }));
  try {
    let message = "";
    try {
      await resolveMeterEnv(baseConfig(), envWith({ MOC_METER_HOST_ADDRESSES_FILE: file }));
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain("shared by aliases");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no error text contains the env value", async () => {
  const probe = "probe-value-abcdef";
  let message = "";
  try {
    await resolveMeterEnv(baseConfig(), envWith({ MOC_METER_LISTEN: probe }));
  } catch (error: unknown) {
    message = (error as Error).message;
  }
  expect(message.length).toBeGreaterThan(0);
  expect(message.includes(probe)).toBe(false);
});

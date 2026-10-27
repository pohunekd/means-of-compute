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
  for (const listen of [
    "0.0.0.0:8787",
    "[::]:8787",
    "[::ffff:0.0.0.0]:8787",
    "[0:0:0:0:0:ffff:0.0.0.0]:8787",
    "[::0.0.0.0]:8787",
    "[::ffff:127.0.0.1]:8787",
  ]) {
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
      expect(message.includes(listen)).toBe(false);
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

test("listen port below 1 and above 65535 refused", async () => {
  // M5: the listen port comes from the env, not the config file: port
  // 0 is the test wildcard and both edges refuse without echoing.
  for (const listen of ["127.0.0.1:-1", "127.0.0.1:65536"]) {
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
      expect(message.length).toBeGreaterThan(0);
      expect(message.includes(listen)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("non-canonical base64 secret refused", async () => {
  // M5: trailing `=` dropped from a padded encoding stays valid
  // base64 but re-encodes with the padding back, so it refuses on
  // the strict check with the padding restored.
  const strict = Buffer.from("x".repeat(32)).toString("base64");
  const nonCanonical = strict.replace(/=+$/, "");
  const dir = mkdtempSync(join(tmpdir(), "meter-hosts-"));
  const file = join(dir, "hosts.json");
  await Bun.write(file, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
  let message = "";
  try {
    await resolveMeterEnv(
      baseConfig(),
      envWith({ MOC_METER_SECRET: nonCanonical, MOC_METER_HOST_ADDRESSES_FILE: file }),
    );
  } catch (error: unknown) {
    message = (error as Error).message;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(message).toContain("strict base64");
  expect(message.includes(nonCanonical)).toBe(false);
});

test("every 2.1 integer key refused at min-1 and max+1", async () => {
  // M5: one refusal per edge of every integer rule in section 2.1.
  const edges: Array<{ key: keyof MeterConfig; min: number; max: number }> = [
    { key: "maxRequestBytes", min: 1024, max: 67108864 },
    { key: "maxUsageScanBytes", min: 1024, max: 67108864 },
    { key: "clientIdleTimeoutSec", min: 1, max: 255 },
    { key: "firstByteTimeoutMs", min: 1, max: 600000 },
    { key: "idleTimeoutMs", min: 1, max: 600000 },
    { key: "totalTimeoutMs", min: 1, max: 86400000 },
    { key: "drainTimeoutMs", min: 0, max: 600000 },
    { key: "unboundGrantTtlMs", min: 1000, max: 3600000 },
    { key: "maxInFlightPerSession", min: 1, max: 64 },
  ];
  for (const { key, min, max } of edges) {
    for (const value of [min - 1, max + 1]) {
      let message = "";
      try {
        await configFromObject(baseConfig({ [key]: value } as Partial<MeterConfig>));
      } catch (error: unknown) {
        message = (error as Error).message;
      }
      expect(message).toContain(`"${key}"`);
    }
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

test("secret values stay out of config errors", async () => {
  // M04: echoing the secret in its error would leak it. One secret
  // fails the strict base64 check, the other decodes to 16 bytes.
  for (const secret of ["not-base64-SECRETMARK", "c2hvcnQtU0VDUkVUTUFSSw=="]) {
    let message = "";
    let name = "";
    try {
      await resolveMeterEnv(baseConfig(), envWith({ MOC_METER_SECRET: secret }));
    } catch (error: unknown) {
      message = (error as Error).message;
      name = (error as Error).name;
    }
    expect(name).toBe("MeterConfigError");
    expect(message.includes(secret)).toBe(false);
    expect(message.includes("SECRETMARK")).toBe(false);
  }
});

test("invalid IP refused", async () => {
  // M06: dropping the invalid-IP check would accept these.
  let listenMessage = "";
  try {
    await resolveMeterEnv(baseConfig(), envWith({ MOC_METER_LISTEN: "999.1.1.1:8787" }));
  } catch (error: unknown) {
    listenMessage = (error as Error).message;
  }
  expect(listenMessage).toContain("invalid IP");
  expect(listenMessage.includes("999.1.1.1")).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), "meter-hosts-"));
  const file = join(dir, "hosts.json");
  await Bun.write(file, JSON.stringify({ "laptop-a": ["not-an-ip"] }));
  try {
    let hostsMessage = "";
    try {
      await resolveMeterEnv(baseConfig(), envWith({ MOC_METER_HOST_ADDRESSES_FILE: file }));
    } catch (error: unknown) {
      hostsMessage = (error as Error).message;
    }
    expect(hostsMessage).toContain("holds an invalid IP");
    expect(hostsMessage.includes("not-an-ip")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate address in one alias refused", async () => {
  // M07: dropping the in-alias duplicate check would accept this.
  const dir = mkdtempSync(join(tmpdir(), "meter-hosts-"));
  const file = join(dir, "hosts.json");
  await Bun.write(file, JSON.stringify({ "laptop-a": ["127.0.0.1", "127.0.0.1"] }));
  try {
    let message = "";
    try {
      await resolveMeterEnv(baseConfig(), envWith({ MOC_METER_HOST_ADDRESSES_FILE: file }));
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain("duplicate address");
    expect(message.includes("127.0.0.1")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

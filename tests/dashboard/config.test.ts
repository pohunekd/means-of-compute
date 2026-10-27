// Dashboard config tests. Every expected value comes from the design
// section 2.1 rules and the section 11 mutation list, never from the code
// under test.
import { describe, expect, test } from "bun:test";
import {
  loadDashboardConfig,
  readDashboardNow,
  resolveDashboardListen,
  type DashboardConfig,
} from "../../src/dashboard/config.js";

function validConfig(): Record<string, unknown> {
  return {
    listenEnv: "MOC_DASHBOARD_LISTEN",
    listenAlias: "dashboard",
    logPath: "logs/dashboard.jsonl",
    maxRequestBytes: 1024,
    idleTimeoutSec: 10,
    workRowLimit: 50,
    baselines: { frontierTokens: null, cloudSandboxHour: null, ownedHostHour: null },
  };
}

async function writeTempConfig(value: unknown): Promise<string> {
  const path = `${import.meta.dir}/.tmp-config-${String(Math.random()).slice(2)}.json`;
  await Bun.write(path, `${JSON.stringify(value)}\n`);
  return path;
}

async function loadTemp(value: unknown): Promise<DashboardConfig> {
  const path = await writeTempConfig(value);
  try {
    return await loadDashboardConfig(path);
  } finally {
    await Bun.file(path).delete();
  }
}

function configWithEnv(value: string): { config: DashboardConfig; env: Record<string, string> } {
  const config: DashboardConfig = {
    listenEnv: "MOC_DASHBOARD_LISTEN",
    listenAlias: "dashboard",
    logPath: "logs/dashboard.jsonl",
    maxRequestBytes: 1024,
    idleTimeoutSec: 10,
    workRowLimit: 50,
    baselines: { frontierTokens: null, cloudSandboxHour: null, ownedHostHour: null },
  };
  return { config, env: { MOC_DASHBOARD_LISTEN: value } };
}

describe("dashboard listen bind rule", () => {
  for (const value of ["127.0.0.1:0", "[::1]:0", "127.255.255.255:8080"]) {
    test(`accepts ${value} (mutation: accept any non-wildcard IP)`, () => {
      const { config, env } = configWithEnv(value);
      expect(resolveDashboardListen(config, env).port).toBeGreaterThanOrEqual(0);
    });
  }

  for (const value of [
    "0.0.0.0:8080",
    "[::]:8080",
    "[0:0:0:0:0:0:0:1]:8080",
    "198.51.100.10:8080",
    "127.1:8080",
    "localhost:8080",
  ]) {
    test(`refuses ${value} without echoing the value (mutation: echo the value)`, () => {
      const { config, env } = configWithEnv(value);
      let message = "";
      try {
        resolveDashboardListen(config, env);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(value);
      expect(message).toContain("MOC_DASHBOARD_LISTEN");
      expect(message).toContain("dashboard");
    });
  }

  test("127.0.0.1:0 resolves the loopback host and the ephemeral port", () => {
    const { config, env } = configWithEnv("127.0.0.1:0");
    expect(resolveDashboardListen(config, env)).toEqual({ host: "127.0.0.1", port: 0 });
  });

  test("unset variable exits 2 naming the variable (mutation: default a value)", () => {
    const { config } = configWithEnv("127.0.0.1:0");
    expect(() => resolveDashboardListen(config, {})).toThrow("MOC_DASHBOARD_LISTEN");
  });
});

describe("dashboard config keys", () => {
  test("loads the committed config with null baselines", async () => {
    const config = await loadDashboardConfig();
    expect(config.listenEnv).toBe("MOC_DASHBOARD_LISTEN");
    expect(config.baselines.frontierTokens).toBeNull();
    expect(config.baselines.cloudSandboxHour).toBeNull();
    expect(config.baselines.ownedHostHour).toBeNull();
  });

  test("missing key throws naming the key (mutation: default a missing key)", async () => {
    const raw = validConfig();
    delete raw["workRowLimit"];
    let message = "";
    try {
      await loadTemp(raw);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("workRowLimit");
  });

  test("deleted baselines.frontierTokens key throws naming the key (mutation: default a missing baseline)", async () => {
    const raw = validConfig();
    delete (raw["baselines"] as Record<string, unknown>)["frontierTokens"];
    let message = "";
    try {
      await loadTemp(raw);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("frontierTokens");
  });

  test("extra key throws (mutation: allow extra keys)", async () => {
    const raw = { ...validConfig(), extra: 1 };
    let message = "";
    try {
      await loadTemp(raw);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("extra");
  });

  test("out-of-range integer throws naming the key", async () => {
    const raw = { ...validConfig(), maxRequestBytes: 65537 };
    let message = "";
    try {
      await loadTemp(raw);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("maxRequestBytes");
  });

  test("baseline without source throws (mutation: skip the source check)", async () => {
    const raw = validConfig();
    (raw["baselines"] as Record<string, unknown>)["frontierTokens"] = {
      label: "frontier",
      inputPer1M: 3,
      outputPer1M: 15,
      asOf: "2026-10-01",
    };
    let message = "";
    try {
      await loadTemp(raw);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("source");
  });

  test("impossible asOf date 2026-02-30 throws", async () => {
    const raw = validConfig();
    (raw["baselines"] as Record<string, unknown>)["frontierTokens"] = {
      label: "frontier",
      inputPer1M: 3,
      outputPer1M: 15,
      source: "synthetic test value, not a price",
      asOf: "2026-02-30",
    };
    let message = "";
    try {
      await loadTemp(raw);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("asOf");
  });

  test("inputPer1M with more than 9 decimals throws", async () => {
    const raw = validConfig();
    (raw["baselines"] as Record<string, unknown>)["frontierTokens"] = {
      label: "frontier",
      inputPer1M: 0.0000001,
      outputPer1M: 15,
      source: "synthetic test value, not a price",
      asOf: "2026-10-01",
    };
    let message = "";
    try {
      await loadTemp(raw);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("inputPer1M");
  });

  test("extra key inside a baseline throws", async () => {
    const raw = validConfig();
    (raw["baselines"] as Record<string, unknown>)["ownedHostHour"] = {
      label: "owned",
      perHour: 0.05,
      source: "synthetic test value, not a price",
      asOf: "2026-10-01",
      extra: true,
    };
    let message = "";
    try {
      await loadTemp(raw);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("extra");
  });

  test("valid baselines parse to nano-USD BigInt", async () => {
    const raw = validConfig();
    (raw["baselines"] as Record<string, unknown>)["frontierTokens"] = {
      label: "synthetic frontier",
      inputPer1M: 3,
      outputPer1M: 15,
      source: "synthetic test value, not a price",
      asOf: "2026-10-01",
    };
    const config = await loadTemp(raw);
    expect(config.baselines.frontierTokens?.inputNanoPer1M).toBe(3_000_000_000n);
    expect(config.baselines.frontierTokens?.outputNanoPer1M).toBe(15_000_000_000n);
  });
});

describe("dashboard pinned clock", () => {
  test("unset gives null", () => {
    expect(readDashboardNow({})).toBeNull();
  });

  test("impossible MOC_DASHBOARD_NOW throws (mutation: parse with new Date only)", () => {
    expect(() => readDashboardNow({ MOC_DASHBOARD_NOW: "2026-02-30T00:00:00Z" })).toThrow(
      "MOC_DASHBOARD_NOW",
    );
  });

  test("valid pin round-trips", () => {
    expect(readDashboardNow({ MOC_DASHBOARD_NOW: "2026-10-27T12:00:00.000Z" })?.toISOString()).toBe(
      "2026-10-27T12:00:00.000Z",
    );
  });
});

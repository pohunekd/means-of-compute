import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../factory-probe.ts";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const probe = join(repoRoot, "factory-probe.ts");

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function runProbe(env: Record<string, string>, factsPath: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", probe, "--facts", factsPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode: proc.exitCode ?? 1, stdout, stderr };
}

async function withFacts(
  facts: Record<string, unknown>,
  fn: (factsPath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "probe-facts-"));
  try {
    const factsPath = join(dir, "facts.json");
    await Bun.write(factsPath, JSON.stringify(facts));
    await fn(factsPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const allDayFacts = {
  secondsSinceInput: 3600,
  cpuCores: 4,
  cpuLoad1m: 0.1,
  memoryTotalMb: 8192,
  memoryFreeMb: 4096,
  gpuPresent: false,
  gpuName: null,
  gpuFreeMb: null,
  localModelsReachable: false,
  localModels: [],
  hostAlias: "desktop",
  policyAllowedWindowStart: "00:00",
  policyAllowedWindowEnd: "00:00",
  timestamp: "2026-10-27T12:00:00.000Z",
};

const validConfig = {
  idleMinutes: 15,
  batteryThreshold: 50,
  sysfsRoot: "/sys",
  localModelsBaseUrl: "",
  localModelsTimeoutMs: 2000,
  policy: {
    allowedWindowStart: "09:00",
    allowedWindowEnd: "17:00",
    maxConcurrentAgents: 2,
  },
};

async function withConfig(
  mutate: (cfg: Record<string, unknown>) => void,
  fn: (configPath: string) => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "probe-config-"));
  try {
    const cfg = JSON.parse(JSON.stringify(validConfig)) as Record<string, unknown>;
    mutate(cfg);
    const configPath = join(dir, "probe.json");
    await Bun.write(configPath, JSON.stringify(cfg));
    fn(configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadConfig validation", () => {
  test("missing sysfsRoot key throws naming the key", async () => {
    await withConfig(
      (cfg) => {
        delete cfg["sysfsRoot"];
      },
      (p) => {
        expect(() => loadConfig(p)).toThrow("config probe.json: invalid sysfsRoot");
      },
    );
  });

  test("relative sysfsRoot throws naming the key", async () => {
    await withConfig(
      (cfg) => {
        cfg["sysfsRoot"] = "tests/fixtures/sysfs/type-unreadable";
      },
      (p) => {
        expect(() => loadConfig(p)).toThrow("config probe.json: invalid sysfsRoot");
      },
    );
  });

  test("non-existent sysfsRoot throws naming the key", async () => {
    await withConfig(
      (cfg) => {
        cfg["sysfsRoot"] = "/no-such-sysfs-root";
      },
      (p) => {
        expect(() => loadConfig(p)).toThrow("config probe.json: invalid sysfsRoot");
      },
    );
  });

  test("directory without class/ throws naming the key", async () => {
    await withConfig(
      (cfg) => {
        cfg["sysfsRoot"] = tmpdir();
      },
      (p) => {
        expect(() => loadConfig(p)).toThrow("config probe.json: invalid sysfsRoot");
      },
    );
  });

  test("allowedWindowStart 80:00 throws naming the key", async () => {
    await withConfig(
      (cfg) => {
        (cfg["policy"] as Record<string, unknown>)["allowedWindowStart"] = "80:00";
      },
      (p) => {
        expect(() => loadConfig(p)).toThrow("config probe.json: invalid policy.allowedWindowStart");
      },
    );
  });

  test("batteryThreshold 150 throws naming the key", async () => {
    await withConfig(
      (cfg) => {
        cfg["batteryThreshold"] = 150;
      },
      (p) => {
        expect(() => loadConfig(p)).toThrow("config probe.json: invalid batteryThreshold");
      },
    );
  });
});

describe.skipIf(process.platform !== "linux")("sysfsRoot validation", () => {
  test("relative path fails with exit 1 and no document", async () => {
    await withFacts(
      { ...allDayFacts, sysfsRoot: "tests/fixtures/sysfs/type-unreadable" },
      async (p) => {
        const r = await runProbe({}, p);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("sysfsRoot");
      },
    );
  });

  test("non-existent path fails with exit 1 and no document", async () => {
    await withFacts({ ...allDayFacts, sysfsRoot: "/no-such-sysfs-root" }, async (p) => {
      const r = await runProbe({}, p);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("sysfsRoot");
    });
  });

  test("missing key falls back to config sysfsRoot", async () => {
    await withFacts({ ...allDayFacts }, async (p) => {
      const r = await runProbe({}, p);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('"hostAlias":"desktop"');
    });
  });

  test("unreadable BAT0/type fixture gives power unknown, not idle", async () => {
    await withFacts(
      {
        ...allDayFacts,
        sysfsRoot: join(repoRoot, "tests/fixtures/sysfs/type-unreadable"),
      },
      async (p) => {
        const r = await runProbe({}, p);
        expect(r.exitCode).toBe(0);
        const doc = JSON.parse(r.stdout) as { idle: boolean; idleReason: string };
        expect(doc.idle).toBe(false);
        expect(doc.idleReason).toContain("BAT0/type");
        expect(doc.idleReason).toContain("EISDIR");
      },
    );
  });
});

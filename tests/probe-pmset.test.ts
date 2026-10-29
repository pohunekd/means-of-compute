import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const darwinProbe = join(repoRoot, "tests/fixtures/darwin-probe.ts");
const preload = join(repoRoot, "tests/fixtures/darwin-preload.ts");
const pmsetBin = join(repoRoot, "tests/fixtures/pmset/bin");

type RunResult = { exitCode: number; stdout: string; stderr: string };

// Runs the probe as a darwin host: the preload shadows process.platform and
// the temp config points macosTools.pmset at the double answering from the
// fixture file named by MOC_PMSET_FIXTURE. The window is evaluated in host
// local time; pin the zone so the tests hold on machines in any time zone.
async function runDarwinProbe(fixture: string, factsPath: string): Promise<RunResult> {
  const configDir = mkdtempSync(join(tmpdir(), "probe-config-"));
  try {
    cpSync(join(repoRoot, "config/probe.json"), join(configDir, "probe.json"));
    const raw = JSON.parse(readFileSync(join(configDir, "probe.json"), "utf-8")) as {
      macosTools: Record<string, string>;
    };
    raw.macosTools["pmset"] = join(pmsetBin, "pmset");
    writeFileSync(join(configDir, "probe.json"), JSON.stringify(raw));
    const proc = Bun.spawn(
      ["bun", "--preload", preload, darwinProbe, configDir, factsPath],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          TZ: "UTC",
          MOC_PMSET_FIXTURE: join(repoRoot, "tests/fixtures/pmset", fixture, "output.txt"),
        },
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode: proc.exitCode ?? 1, stdout, stderr };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
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

// Power is left to the pmset double; everything else is fixed by facts.
// The timestamp pins the evaluation instant for the window check.
function darwinFacts(extra: Record<string, unknown>): Record<string, unknown> {
  return {
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
    ...extra,
  };
}

describe("macos pmset parsing", () => {
  test("a battery line without a percent is power unknown, not idle", async () => {
    await withFacts(darwinFacts({}), async (p) => {
      const r = await runDarwinProbe("no-percent", p);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as { idle: boolean; idleReason: string };
      expect(doc.idle).toBe(false);
      expect(doc.idleReason).toContain("power unknown: pmset battery unparsable");
    });
  });

  test("a battery line at 30 percent fails the battery floor", async () => {
    await withFacts(darwinFacts({}), async (p) => {
      const r = await runDarwinProbe("low-battery", p);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as { idle: boolean; idleReason: string };
      expect(doc.idle).toBe(false);
      expect(doc.idleReason).toBe("battery at 30 percent, at or below the 50 percent floor");
    });
  });

  test("AC with no battery line takes the desktop path", async () => {
    await withFacts(darwinFacts({}), async (p) => {
      const r = await runDarwinProbe("desktop", p);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as {
        idle: boolean;
        idleReason: string;
        batteryPercent: number | null;
      };
      expect(doc.idle).toBe(true);
      expect(doc.idleReason).toBe("no user input for 60 minutes, on AC power");
      expect(doc.batteryPercent).toBeNull();
    });
  });
});

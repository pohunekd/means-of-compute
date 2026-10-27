import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const probe = join(repoRoot, "factory-probe.ts");

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function runProbe(factsPath: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", probe, "--facts", factsPath], {
    stdout: "pipe",
    stderr: "pipe",
    // The window is evaluated in host local time; pin the zone so the
    // tests hold on machines in any time zone.
    env: { ...process.env, TZ: "UTC" },
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

// Every fact is fixed; only the fact under test varies. The timestamp pins
// the evaluation instant for the window check.
function baseFacts(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    secondsSinceInput: 3600,
    acPower: true,
    batteryPercent: null,
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

async function expectFactsError(result: RunResult, key: string): Promise<void> {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  const lines = result.stderr.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  expect(lines[0]?.startsWith("facts ")).toBe(true);
  expect(lines[0]).toContain(`: ${key}:`);
}

describe.skipIf(process.platform !== "linux")("facts validation", () => {
  test("string noLocalUserSession exits 1 naming the key (mutation: drop the schema check)", async () => {
    for (const bad of ["true", "yes", 1]) {
      await withFacts(baseFacts({ noLocalUserSession: bad }), async (p) => {
        await expectFactsError(await runProbe(p), "noLocalUserSession");
      });
    }
  });

  test("unknown key exits 1 naming it (mutation: additionalProperties: true)", async () => {
    await withFacts(baseFacts({ idleOverride: true }), async (p) => {
      await expectFactsError(await runProbe(p), "idleOverride");
    });
  });

  test("batteryPercent 101 exits 1 (mutation: drop maximum)", async () => {
    await withFacts(baseFacts({ batteryPercent: 101 }), async (p) => {
      await expectFactsError(await runProbe(p), "batteryPercent");
    });
  });

  test("secondsSinceInput -1 exits 1 (mutation: drop minimum)", async () => {
    await withFacts(baseFacts({ secondsSinceInput: -1 }), async (p) => {
      await expectFactsError(await runProbe(p), "secondsSinceInput");
    });
  });

  test("impossible timestamp exits 1 (mutation: drop the code date check)", async () => {
    await withFacts(baseFacts({ timestamp: "2026-13-01T00:00:00.000Z" }), async (p) => {
      await expectFactsError(await runProbe(p), "timestamp");
    });
  });

  test("logged-out facts without input time exit 1 naming it (mutation: leave the check in runProbe)", async () => {
    // No hostAlias: the check in validateFactsValue runs before loadConfig
    // and the host map, so their errors cannot mask the facts line.
    await withFacts({ noLocalUserSession: true }, async (p) => {
      await expectFactsError(await runProbe(p), "secondsSinceInput");
    });
  });
});

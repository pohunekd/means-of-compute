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

// The final idle rule: insideWindow AND on AC AND battery above the
// threshold (or no battery) AND (nobody logged in OR input at least
// idleMinutes ago). Outside the window the host is never idle; recent
// input is never ignored. The timestamp pins the evaluation instant.
const baseFacts = {
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
  timestamp: "2026-10-27T12:00:00.000Z",
};

async function idleOf(facts: Record<string, unknown>): Promise<{
  idle: boolean;
  idleReason: string;
}> {
  let doc = { idle: false, idleReason: "" };
  await withFacts(facts, async (p) => {
    const r = await runProbe(p);
    expect(r.exitCode).toBe(0);
    doc = JSON.parse(r.stdout) as typeof doc;
  });
  return doc;
}

// insideWindow is derived from the pinned timestamp: 09:00-10:00 excludes
// noon, 00:00-00:00 is the all-day window.
describe.skipIf(process.platform !== "linux")("final idle rule", () => {
  test("input 0 s ago, inside the window: not idle", async () => {
    const doc = await idleOf({
      ...baseFacts,
      secondsSinceInput: 0,
      policyAllowedWindowStart: "00:00",
      policyAllowedWindowEnd: "00:00",
    });
    expect(doc.idle).toBe(false);
    expect(doc.idleReason).toBe("user input 0 seconds ago");
  });

  test("input 20 min ago, inside the window: idle", async () => {
    const doc = await idleOf({
      ...baseFacts,
      secondsSinceInput: 1200,
      policyAllowedWindowStart: "00:00",
      policyAllowedWindowEnd: "00:00",
    });
    expect(doc.idle).toBe(true);
    expect(doc.idleReason).toBe("no user input for 20 minutes, on AC power");
  });
});

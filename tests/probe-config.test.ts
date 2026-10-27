import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("sysfsRoot validation", () => {
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

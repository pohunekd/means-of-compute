import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const probe = join(repoRoot, "factory-probe.ts");
const doubleBin = join(repoRoot, "tests/fixtures/loginctl/bin");

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function runProbe(fixture: string, factsPath: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", probe, "--facts", factsPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // The window is evaluated in host local time; pin the zone so the
      // tests hold on machines in any time zone.
      TZ: "UTC",
      PATH: `${doubleBin}:${process.env["PATH"] ?? ""}`,
      MOC_LOGINCTL_FIXTURE: join(repoRoot, "tests/fixtures/loginctl", fixture),
    },
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

// Power and the window are fixed by facts; the session rule under test is the
// only thing the double decides. The timestamp pins the evaluation instant
// (hint age and window), so the tests never depend on the wall clock.
const sessionFacts = {
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
};

async function readUptimeSecs(): Promise<number> {
  const first = (await Bun.file("/proc/uptime").text()).split(/\s+/)[0];
  return Math.floor(Number(first));
}

async function loggedOutSecs(
  fixture: string,
): Promise<{ idle: boolean; idleReason: string; secondsSinceInput: number }> {
  let doc = { idle: false, idleReason: "", secondsSinceInput: 0 };
  await withFacts({ ...sessionFacts }, async (p) => {
    const r = await runProbe(fixture, p);
    expect(r.exitCode).toBe(0);
    doc = JSON.parse(r.stdout) as typeof doc;
    expect(doc.idle).toBe(true);
    expect(doc.idleReason).toBe("no user logged in, on AC power");
  });
  return doc;
}

describe.skipIf(process.platform !== "linux")("loginctl session rule", () => {
  test("user-early on tty1 is logged in without a graphical session, not idle", async () => {
    await withFacts({ ...sessionFacts }, async (p) => {
      const r = await runProbe("user-early-tty", p);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as { idle: boolean; idleReason: string };
      expect(doc.idle).toBe(false);
      expect(doc.idleReason).toContain("logged in without an active graphical session");
    });
  });

  test("missing Class line is unknown, not idle", async () => {
    await withFacts({ ...sessionFacts }, async (p) => {
      const r = await runProbe("missing-class", p);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as { idle: boolean; idleReason: string };
      expect(doc.idle).toBe(false);
      expect(doc.idleReason).toContain("has no Class or Remote");
    });
  });

  test("missing IdleHint line is unknown, not idle", async () => {
    await withFacts({ ...sessionFacts }, async (p) => {
      const r = await runProbe("idlehint-missing", p);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as { idle: boolean; idleReason: string };
      expect(doc.idle).toBe(false);
      expect(doc.idleReason).toContain("has no IdleHint");
    });
  });

  test("non-numeric IdleSinceHint is unknown, not idle", async () => {
    await withFacts({ ...sessionFacts }, async (p) => {
      const r = await runProbe("idlesincehint-garbage", p);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as { idle: boolean; idleReason: string };
      expect(doc.idle).toBe(false);
      expect(doc.idleReason).toContain("has no numeric IdleSinceHint");
    });
  });

  test("greeter-only takes the logged-out path", async () => {
    await withFacts({ ...sessionFacts }, async (p) => {
      const r = await runProbe("greeter-only", p);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as {
        idle: boolean;
        idleReason: string;
        secondsSinceInput: number;
      };
      expect(doc.idle).toBe(true);
      expect(doc.idleReason).toBe("no user logged in, on AC power");
      // The pinned timestamp (2026-10-27T12:00:00Z, epoch 1793102400) minus
      // the fixture hint (1793082023.347 s) is 20376 s; a wall-clock age
      // would drift away from this value.
      expect(doc.secondsSinceInput).toBe(20376);
    });
  });

  test("ssh-only takes the logged-out path", async () => {
    await withFacts({ ...sessionFacts }, async (p) => {
      const r = await runProbe("ssh-only", p);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as {
        idle: boolean;
        idleReason: string;
        secondsSinceInput: number;
      };
      expect(doc.idle).toBe(true);
      expect(doc.idleReason).toBe("no user logged in, on AC power");
      expect(doc.secondsSinceInput).toBeGreaterThan(0);
    });
  });

  test("missing manager file falls back to /proc/uptime", async () => {
    const { secondsSinceInput } = await loggedOutSecs("logged-out-no-manager");
    const uptime = await readUptimeSecs();
    expect(secondsSinceInput).toBeGreaterThan(uptime - 5);
    expect(secondsSinceInput).toBeLessThan(uptime + 5);
  });

  test("zero manager hint falls back to /proc/uptime", async () => {
    const { secondsSinceInput } = await loggedOutSecs("logged-out-hint-zero");
    const uptime = await readUptimeSecs();
    expect(secondsSinceInput).toBeGreaterThan(uptime - 5);
    expect(secondsSinceInput).toBeLessThan(uptime + 5);
  });
});

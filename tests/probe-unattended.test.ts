import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const hostProbe = join(repoRoot, "tests", "fixtures", "host-probe.ts");
const fixturesDir = join(repoRoot, "tests", "fixtures", "loginctl");

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function runHostProbe(
  configDir: string,
  factsPath: string,
  hostFile: string,
  loginctlDir: string,
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", hostProbe, configDir, factsPath, hostFile], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TZ: "UTC",
      PATH: `${loginctlDir}:${process.env["PATH"] ?? ""}`,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode: proc.exitCode ?? 1, stdout, stderr };
}

function writeRun(
  doubleName: string,
  hostContent: string,
): { configDir: string; factsPath: string; hostFile: string; loginctlDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "probe-unattended-"));
  const configDir = join(dir, "config");
  cpSync(join(repoRoot, "config", "probe.json"), join(configDir, "probe.json"), {
    // cpSync creates the destination directory when copying a file into it.
    recursive: true,
  });
  const facts = {
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
    timestamp: "2026-10-27T12:00:00.000Z",
  };
  const factsPath = join(dir, "facts.json");
  writeFileSync(factsPath, JSON.stringify(facts));
  const hostFile = join(dir, "host.json");
  writeFileSync(hostFile, hostContent);
  return { configDir, factsPath, hostFile, loginctlDir: join(fixturesDir, doubleName) };
}

describe.skipIf(process.platform !== "linux")("unattended window", () => {
  test("U1 tty-only inside the whole-day window reports logind idle time", async () => {
    const run = writeRun(
      "tty-only",
      JSON.stringify({ hostAlias: "laptop-b", unattended: { start: "00:00", end: "00:00" } }),
    );
    try {
      const r = await runHostProbe(run.configDir, run.factsPath, run.hostFile, run.loginctlDir);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as {
        hostAlias: string;
        idle: boolean;
        idleReason: string;
        secondsSinceInput: number;
      };
      expect(doc.hostAlias).toBe("laptop-b");
      expect(doc.idle).toBe(true);
      expect(doc.idleReason).toBe(
        "unattended window 00:00-00:00: no input on the local session for 720 minutes, on AC power",
      );
      expect(doc.secondsSinceInput).toBe(43200);
    } finally {
      rmSync(join(run.configDir, ".."), { recursive: true, force: true });
    }
  });

  test("U2 tty-only outside the window keeps activity unknown", async () => {
    const run = writeRun(
      "tty-only",
      JSON.stringify({ hostAlias: "laptop-b", unattended: { start: "00:00", end: "07:00" } }),
    );
    try {
      const r = await runHostProbe(run.configDir, run.factsPath, run.hostFile, run.loginctlDir);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as {
        idle: boolean;
        idleReason: string;
        secondsSinceInput: number;
      };
      expect(doc.idle).toBe(false);
      expect(doc.idleReason).toBe(
        "user activity unknown: logged in without an active graphical session",
      );
      expect(doc.secondsSinceInput).toBe(0);
    } finally {
      rmSync(join(run.configDir, ".."), { recursive: true, force: true });
    }
  });

  test("U3 an active graphical session overrides the window", async () => {
    const run = writeRun(
      "wayland-active",
      JSON.stringify({ hostAlias: "laptop-b", unattended: { start: "00:00", end: "00:00" } }),
    );
    try {
      const r = await runHostProbe(run.configDir, run.factsPath, run.hostFile, run.loginctlDir);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as {
        idle: boolean;
        idleReason: string;
        secondsSinceInput: number;
      };
      expect(doc.idle).toBe(false);
      expect(doc.idleReason).toBe("user input 0 seconds ago");
      expect(doc.secondsSinceInput).toBe(0);
    } finally {
      rmSync(join(run.configDir, ".."), { recursive: true, force: true });
    }
  });

  test("U4 a bad window fails fast", async () => {
    const run = writeRun(
      "tty-only",
      JSON.stringify({ hostAlias: "laptop-b", unattended: { start: "24:00", end: "07:00" } }),
    );
    try {
      const r = await runHostProbe(run.configDir, run.factsPath, run.hostFile, run.loginctlDir);
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`host file ${run.hostFile}: invalid unattended`);
    } finally {
      rmSync(join(run.configDir, ".."), { recursive: true, force: true });
    }
  });
});

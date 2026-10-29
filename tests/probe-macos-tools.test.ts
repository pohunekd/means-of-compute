import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const darwinProbe = join(repoRoot, "tests/fixtures/darwin-probe.ts");
const preload = join(repoRoot, "tests/fixtures/darwin-preload.ts");
const toolsBin = join(repoRoot, "tests/fixtures/macos-tools/bin");
const shadowBin = join(repoRoot, "tests/fixtures/macos-tools/shadow");

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function runDarwinProbe(configDir: string, factsPath: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "--preload", preload, darwinProbe, configDir, factsPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TZ: "UTC",
      PATH: `${shadowBin}:${process.env["PATH"] ?? ""}`,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode: proc.exitCode ?? 1, stdout, stderr };
}

async function writeTempConfig(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "probe-config-"));
  cpSync(join(repoRoot, "config/probe.json"), join(dir, "probe.json"));
  const raw = JSON.parse(readFileSync(join(dir, "probe.json"), "utf-8")) as {
    macosTools: Record<string, string>;
  };
  raw.macosTools["stat"] = join(toolsBin, "stat");
  raw.macosTools["ioreg"] = join(toolsBin, "ioreg");
  await Bun.write(join(dir, "probe.json"), JSON.stringify(raw));
  return dir;
}

function writeFacts(dir: string): string {
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
    policyAllowedWindowStart: "00:00",
    policyAllowedWindowEnd: "00:00",
    timestamp: "2026-10-27T12:00:00.000Z",
  };
  const factsPath = join(dir, "facts.json");
  writeFileSync(factsPath, JSON.stringify(facts));
  return factsPath;
}

describe("macos tool paths", () => {
  test("the configured stat and ioreg doubles answer instead of PATH", async () => {
    const configDir = await writeTempConfig();
    try {
      const factsPath = writeFacts(configDir);
      const r = await runDarwinProbe(configDir, factsPath);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as {
        idle: boolean;
        idleReason: string;
        secondsSinceInput: number;
      };
      expect(doc.idle).toBe(true);
      expect(doc.idleReason).toBe("no user input for 60 minutes, on AC power");
      expect(doc.secondsSinceInput).toBe(3600);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

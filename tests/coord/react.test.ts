// Watch run tests (X1, M4): the D3 react flow and the seed demo-dir guard.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import { readCoordCalls } from "../../src/coord/calls.js";
import { createCoordTestEnv, type CoordTestEnv } from "./env.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "coord", "fake");
const D3_DIR = join(process.cwd(), "tests", "fixtures", "coord", "d3");

function checkoutLogNames(): string[] {
  try {
    return readdirSync(join(process.cwd(), "logs")).sort();
  } catch {
    return [];
  }
}

let checkoutBefore: string[] = [];

beforeAll(() => {
  checkoutBefore = checkoutLogNames();
});

afterAll(() => {
  expect(checkoutLogNames()).toEqual(checkoutBefore);
});

afterEach(() => {
  const names = checkoutLogNames();
  for (const name of names) {
    if (!checkoutBefore.includes(name)) {
      throw new Error(`checkout logs changed: ${name}`);
    }
  }
});

async function listRunDirs(runsDir: string): Promise<string[]> {
  const entries = await readdir(runsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function waitExit(proc: ReturnType<typeof Bun.spawn>): Promise<number> {
  const deadline = Date.now() + 25000;
  for (;;) {
    const rc = proc.exitCode;
    if (rc !== null) {
      return rc;
    }
    if (typeof proc.signalCode === "string") {
      let alive = true;
      try {
        process.kill(proc.pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        const table: Record<string, number | undefined> = { ...constants.signals };
        const offset = table[proc.signalCode];
        return typeof offset === "number" ? 128 + offset : 1;
      }
    }
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error("spawned main.ts did not exit in time");
    }
    await Bun.sleep(50);
  }
}

async function spawnWatch(env: CoordTestEnv): Promise<{
  readonly run: Spawned;
  readonly configPath: string;
}> {
  symlinkSync(join(process.cwd(), "tests"), join(env.checkoutDir, "tests"));
  symlinkSync(join(process.cwd(), ".agents"), join(env.checkoutDir, ".agents"));
  const gateAdmitPath = join(env.dir, "gate-admit.json");
  await Bun.write(
    gateAdmitPath,
    '{"command":["bun","run","budget:check","--spend","0.00","--day-cap","12","--total-cap","140"],"timeoutMs":30000}',
  );
  const base = (await Bun.file(join(D3_DIR, "coordinator.json")).json()) as Record<string, unknown>;
  const d3watch = base["watch"] as Record<string, unknown>;
  const configJson: Record<string, unknown> = {
    ...base,
    museCommand: env.configJson["museCommand"],
    envPassthrough: env.configJson["envPassthrough"],
    runsDir: env.runsDir,
    budgetGateConfigPath: gateAdmitPath,
    killGraceMs: 200,
    watch: { ...d3watch, pollMs: 1000, deadlineMs: 8000 },
  };
  const configPath = join(env.dir, "coordinator-d3.json");
  await Bun.write(configPath, `${JSON.stringify(configJson)}\n`);
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      join(env.checkoutDir, "src/coord/main.ts"),
      "--goal",
      join(D3_DIR, "goal.json"),
      "--phase",
      "watch",
      "--config",
      configPath,
    ],
    {
      cwd: env.checkoutDir,
      env: {
        PATH: process.env["PATH"],
        FAKE_MUSE_RECORD: env.recordPath,
        FAKE_MUSE_SCRIPT: join(FAKE_DIR, "react-d3.json"),
        META_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    run: {
      proc,
      stdoutText: (): Promise<string> => new Response(proc.stdout).text(),
      stderrText: (): Promise<string> => new Response(proc.stderr).text(),
      waitExit: (): Promise<number> => waitExit(proc),
    },
    configPath,
  };
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  const line = lines[lines.length - 1];
  if (line === undefined) {
    throw new Error("spawned run printed no output");
  }
  return line;
}

test("X1 the D3 react run files one followup then hits the deadline", async () => {
  const env = await createCoordTestEnv();
  const { run } = await spawnWatch(env);
  const rc = await run.waitExit();
  const stdout = await run.stdoutText();
  expect(rc).toBe(0);
  expect(lastLine(stdout)).toMatch(/stop=deadline submitted=1 items=4 followups=1/);
  const dirs = await listRunDirs(env.runsDir);
  expect(dirs.length).toBe(1);
  const runDir = join(env.runsDir, dirs[0] as string);
  const report = (await Bun.file(join(runDir, "report.json")).json()) as {
    readonly sessions: readonly {
      readonly kind: string;
      readonly k: number;
      readonly attentionKeys: readonly string[];
    }[];
    readonly followups: readonly string[];
    readonly unresolved: readonly string[] | null;
    readonly items: readonly { readonly id: string; readonly stranded: boolean }[] | null;
  };
  expect(report.sessions.length).toBe(1);
  expect(report.sessions[0]?.kind).toBe("react");
  expect(report.sessions[0]?.k).toBe(1);
  expect(report.sessions[0]?.attentionKeys).toEqual(["followup:d3-writer"]);
  expect(report.followups).toEqual(["d3-writer-fu"]);
  expect(report.unresolved).toEqual([]);
  const stranded = (report.items ?? []).find((item) => item.id === "d3-report");
  expect(stranded?.stranded).toBe(true);
  const coordLines = (await Bun.file(join(runDir, "coord.jsonl")).text()).trim().split("\n");
  const attentions = coordLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["event"] === "attention");
  expect(attentions.length).toBe(1);
  expect(attentions[0]?.["keys"]).toEqual(["followup:d3-writer"]);
  const calls = await readCoordCalls(join(runDir, "mcp-calls.jsonl"));
  const auditIndex = calls?.findIndex((call) => call.tool === "audit_results");
  const submitIndex = calls?.findIndex((call) => call.tool === "submit_work");
  expect(auditIndex).toBeGreaterThanOrEqual(0);
  expect(submitIndex).toBeGreaterThanOrEqual(0);
  expect((auditIndex as number) < (submitIndex as number)).toBe(true);
  const submit = calls?.[submitIndex as number];
  expect(submit?.outcome).toBe("ok");
  const summary = submit?.summary as { readonly itemIds?: readonly string[] } | null;
  expect(summary?.itemIds).toEqual(["d3-writer-fu"]);
  const marker = join(env.checkoutDir, "logs", "coord-d3", ".coord-demo");
  expect(await Bun.file(marker).exists()).toBe(true);
}, 30000);

test("M4 a non-demo state dir refuses the run and keeps the sentinel", async () => {
  const env = await createCoordTestEnv();
  const stateDir = join(env.checkoutDir, "logs", "coord-d3");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "sentinel.txt"), "keep\n");
  const { run } = await spawnWatch(env);
  const rc = await run.waitExit();
  const stderr = await run.stderrText();
  expect(rc).toBe(2);
  expect(stderr).toContain("coord: logs/coord-d3 is not a coordinator demo dir");
  expect(await Bun.file(join(stateDir, "sentinel.txt")).exists()).toBe(true);
  expect(await listRunDirs(env.runsDir)).toEqual([]);
}, 30000);

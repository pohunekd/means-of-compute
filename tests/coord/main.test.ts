// Coordinator plan-run tests (M1, M16, M20): plan smoke, gate key isolation,
// failed-probe stop.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { constants } from "node:os";
import { readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readCoordCalls } from "../../src/coord/calls.js";
import { sha256Hex } from "../../src/work/canonical.js";
import { createCoordTestEnv, type CoordTestEnv } from "./env.js";

const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "coord", "fake");

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

interface Spawned {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly stdoutText: () => Promise<string>;
  readonly stderrText: () => Promise<string>;
  readonly waitExit: () => Promise<number>;
}

async function spawnMain(
  env: CoordTestEnv,
  goalFile: string,
  phase: string,
  extra: readonly string[],
  overrides: Record<string, unknown> = {},
  fakeScript = "plan-notes.json",
): Promise<{
  readonly run: Spawned;
  readonly configJson: Record<string, unknown>;
  readonly configPath: string;
}> {
  const gateAdmitPath = join(env.dir, "gate-admit.json");
  const gateRefusePath = join(env.dir, "gate-refuse.json");
  await Bun.write(
    gateAdmitPath,
    '{"command":["bun","run","budget:check","--spend","0.00","--day-cap","12","--total-cap","140"],"timeoutMs":30000}',
  );
  await Bun.write(
    gateRefusePath,
    '{"command":["bun","run","budget:check","--spend","12.00","--day-cap","12","--total-cap","140"],"timeoutMs":30000}',
  );
  const configJson: Record<string, unknown> = {
    ...env.configJson,
    skillDir: join(process.cwd(), ".agents/skills/factory-coord"),
    budgetGateConfigPath: gateAdmitPath,
    killGraceMs: 200,
    ...overrides,
  };
  const configPath = join(env.dir, "coordinator-main.json");
  await Bun.write(configPath, `${JSON.stringify(configJson)}\n`);
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      join(env.checkoutDir, "src/coord/main.ts"),
      "--goal",
      join(process.cwd(), goalFile),
      "--phase",
      phase,
      "--config",
      configPath,
      ...extra,
    ],
    {
      cwd: env.checkoutDir,
      env: {
        PATH: process.env["PATH"],
        FAKE_MUSE_RECORD: env.recordPath,
        FAKE_MUSE_SCRIPT: join(FAKE_DIR, fakeScript),
        META_API_KEY: "test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutText = async (): Promise<string> => new Response(proc.stdout).text();
  const stderrText = async (): Promise<string> => new Response(proc.stderr).text();
  const waitExit = async (): Promise<number> => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const rc = proc.exitCode;
      if (rc !== null) {
        return rc;
      }
      // Bun withholds exitCode while an orphaned grandchild holds a stdio pipe
      // open, so a signal death that orphans the session would hang the poll.
      // The signal code is still reported: when the process is verifiably gone,
      // derive the exit code the same way the shell does.
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
  };
  return { run: { proc, stdoutText, stderrText, waitExit }, configJson, configPath };
}

async function listRunDirs(runsDir: string): Promise<string[]> {
  const entries = await readdir(runsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

test("a plan run submits the DAG and reports plan-done (M1)", async () => {
  const env = await createCoordTestEnv();
  const { run, configPath } = await spawnMain(
    env,
    "tests/fixtures/coord/goals/notes.json",
    "plan",
    [],
  );
  const [rc, stdout, stderr] = await Promise.all([
    run.waitExit(),
    run.stdoutText(),
    run.stderrText(),
  ]);
  expect(rc).toBe(0);
  expect(stderr.includes("mcp: serving as mcp-call")).toBe(true);
  const lines = stdout.trim().split("\n");
  const last = lines[lines.length - 1] as string;
  expect(last).toMatch(
    /^coord: run \S+ stop=plan-done submitted=1 items=3 followups=0 report=\S+\/report\.md$/,
  );
  const dirs = await listRunDirs(env.runsDir);
  expect(dirs.length).toBe(1);
  const runDir = join(env.runsDir, dirs[0] as string);
  for (const name of ["session-1-export.json", "probe-1-export.json"]) {
    expect(statSync(join(runDir, name)).mode & 0o777).toBe(0o600);
  }
  const report = (await Bun.file(join(runDir, "report.json")).json()) as {
    readonly submissions: readonly unknown[];
    readonly configSha256: string;
  };
  expect(report.submissions).toEqual([
    {
      submissionId: "sub-d724f6ec4f035058",
      itemIds: ["notes-parse", "notes-store", "notes-cli"],
      replayed: false,
    },
  ]);
  const calls = await readCoordCalls(join(runDir, "mcp-calls.jsonl"));
  expect(calls?.length).toBe(1);
  expect(calls?.[0]?.tool).toBe("submit_work");
  expect(calls?.[0]?.outcome).toBe("ok");
  const coordLines = (await Bun.file(join(runDir, "coord.jsonl")).text()).trim().split("\n");
  const events = coordLines.map((line) => (JSON.parse(line) as { event: string }).event);
  expect(events).toEqual([
    "run-start",
    "gate",
    "surface",
    "session-start",
    "session-end",
    "export",
    "surface",
    "report",
    "run-end",
  ]);
  const surfaces = coordLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["event"] === "surface");
  expect(surfaces.length).toBe(2);
  for (const entry of surfaces) {
    expect(entry["ok"]).toBe(true);
    expect(entry["reason"]).toBe(null);
  }
  expect(report.configSha256).toBe(sha256Hex(await Bun.file(configPath).text()));
  expect(await Bun.file(join(env.runsDir, "coordinator-session.json")).exists()).toBe(false);
  const tree: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        tree.push(full);
      }
    }
  }
  await walk(runDir);
  for (const file of tree) {
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    expect(text.includes("test-key")).toBe(false);
  }
}, 30000);
test("a failed probe stops before the session (M20)", async () => {
  const env = await createCoordTestEnv();
  const { run } = await spawnMain(
    env,
    "tests/fixtures/coord/goals/notes.json",
    "plan",
    [],
    {},
    "surface-echo-extra.json",
  );
  const [rc, stdout] = await Promise.all([run.waitExit(), run.stdoutText()]);
  await run.stderrText();
  expect(rc).toBe(3);
  expect(stdout.trim().split("\n").at(-1)).toMatch(/^coord: run \S+ stop=tool-surface submitted=0/);
  const dirs = await listRunDirs(env.runsDir);
  expect(dirs.length).toBe(1);
  const runDir = join(env.runsDir, dirs[0] as string);
  const report = (await Bun.file(join(runDir, "report.json")).json()) as {
    readonly sessions: readonly unknown[];
  };
  expect(report.sessions).toEqual([]);
  expect(await Bun.file(env.recordPath).exists()).toBe(false);
  const coordLines = (await Bun.file(join(runDir, "coord.jsonl")).text()).trim().split("\n");
  const events = coordLines.map((line) => (JSON.parse(line) as { event: string }).event);
  expect(events).toEqual(["run-start", "gate", "surface", "report", "run-end"]);
  const entry = JSON.parse(coordLines[2] as string) as Record<string, unknown>;
  expect(entry["event"]).toBe("surface");
  expect(entry["k"]).toBe(1);
  expect(entry["stage"]).toBe("probe");
  expect(entry["ok"]).toBe(false);
  expect(entry["reason"]).toBe("tools");
  expect(entry["extra"]).toEqual(["read_file"]);
  expect(entry["missing"]).toEqual([]);
}, 30000);
test("the gate child never sees the key while the session still gets it (M16)", async () => {
  const env = await createCoordTestEnv();
  const probeOut = join(env.dir, "gate-key-state");
  const probeConfigPath = join(env.dir, "gate-probe.json");
  await Bun.write(
    probeConfigPath,
    JSON.stringify({
      command: [
        "bun",
        join(process.cwd(), "tests", "fixtures", "coord", "gate-env-probe.ts"),
        probeOut,
      ],
      timeoutMs: 30000,
    }),
  );
  const spawned = await spawnMain(env, "tests/fixtures/coord/goals/notes.json", "plan", [], {
    budgetGateConfigPath: probeConfigPath,
  });
  const [rc, stdout] = await Promise.all([spawned.run.waitExit(), spawned.run.stdoutText()]);
  await spawned.run.stderrText();
  expect(rc).toBe(0);
  expect(stdout.trim().split("\n").at(-1)).toMatch(/^coord: run \S+ stop=plan-done /);
  expect(await Bun.file(probeOut).text()).toBe("unset\n");
  const record = (await Bun.file(env.recordPath).json()) as { readonly stdinSha256: string };
  expect(record.stdinSha256).toBe(sha256Hex("test-key\n"));
}, 30000);

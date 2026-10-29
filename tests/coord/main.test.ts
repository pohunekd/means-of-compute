// Coordinator plan-run tests (M1-M15): arg parsing, startup checks,
// dry run, session, report and exit codes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { constants } from "node:os";
import { readdirSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadCoordConfig } from "../../src/coord/config.js";
import { museArgv } from "../../src/coord/argv.js";
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

async function waitGrandchildGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    let code: string | null = null;
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      code = (error as NodeJS.ErrnoException).code ?? null;
    }
    if (code === "ESRCH") {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`grandchild ${String(pid)} still runs`);
    }
    await Bun.sleep(20);
  }
}

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
    "session-start",
    "session-end",
    "export",
    "report",
    "run-end",
  ]);
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

test("an empty submission reports no-submission (M2)", async () => {
  const env = await createCoordTestEnv();
  const { run } = await spawnMain(
    env,
    "tests/fixtures/coord/goals/notes.json",
    "plan",
    [],
    {},
    "no-submit.json",
  );
  const [rc, stdout] = await Promise.all([run.waitExit(), run.stdoutText()]);
  await run.stderrText();
  expect(rc).toBe(3);
  expect(stdout.trim().split("\n").at(-1)).toMatch(
    /^coord: run \S+ stop=no-submission submitted=0/,
  );
  const dirs = await listRunDirs(env.runsDir);
  expect(dirs.length).toBe(1);
  const runDir = join(env.runsDir, dirs[0] as string);
  const report = (await Bun.file(join(runDir, "report.json")).json()) as {
    readonly calls: Record<
      string,
      { readonly ok: number; readonly refused: number; readonly error: number }
    >;
  };
  expect(report.calls["submit_work"]).toEqual({ ok: 0, refused: 0, error: 0 });
}, 30000);

test("a refused gate reports budget-refused without spawning (M3)", async () => {
  const env = await createCoordTestEnv();
  const gateRefusePath = join(env.dir, "gate-refuse.json");
  const { run } = await spawnMain(env, "tests/fixtures/coord/goals/notes.json", "plan", [], {
    budgetGateConfigPath: gateRefusePath,
  });
  const [rc, stdout] = await Promise.all([run.waitExit(), run.stdoutText()]);
  await run.stderrText();
  expect(rc).toBe(3);
  expect(stdout.trim().split("\n").at(-1)).toMatch(/^coord: run \S+ stop=budget-refused /);
  const dirs = await listRunDirs(env.runsDir);
  expect(dirs.length).toBe(1);
  const runDir = join(env.runsDir, dirs[0] as string);
  const report = (await Bun.file(join(runDir, "report.json")).json()) as {
    readonly gates: readonly unknown[];
    readonly sessions: readonly unknown[];
  };
  expect(report.gates).toEqual([{ k: 1, admit: false, reason: "daily cap reached" }]);
  expect(report.sessions).toEqual([]);
  expect(await Bun.file(env.recordPath).exists()).toBe(false);
}, 30000);

test("an existing prefix refuses the second run (M6)", async () => {
  const env = await createCoordTestEnv();
  const first = await spawnMain(env, "tests/fixtures/coord/goals/notes.json", "plan", []);
  const [rc1] = await Promise.all([first.run.waitExit(), first.run.stdoutText()]);
  await first.run.stderrText();
  expect(rc1).toBe(0);
  await rmForce(env.recordPath);
  const second = await spawnMain(env, "tests/fixtures/coord/goals/notes.json", "plan", []);
  const [rc2, , stderr2] = await Promise.all([
    second.run.waitExit(),
    second.run.stdoutText(),
    second.run.stderrText(),
  ]);
  expect(rc2).toBe(2);
  expect(stderr2).toContain("coord: goal notes already planned (ids with prefix notes- exist)");
  expect((await listRunDirs(env.runsDir)).length).toBe(1);
}, 30000);

async function rmForce(path: string): Promise<void> {
  try {
    const { rm } = await import("node:fs/promises");
    await rm(path, { force: true });
  } catch {
    // The record may already be gone.
  }
}

test("four runs today refuse the fifth with run-cap (M7)", async () => {
  const env = await createCoordTestEnv();
  const { mkdir } = await import("node:fs/promises");
  const now = new Date();
  const dayStamp = (date: Date): string => date.toISOString().slice(0, 10).replaceAll("-", "");
  const today = dayStamp(now);
  const tomorrow = dayStamp(new Date(now.getTime() + 86400000));
  for (const day of [today, tomorrow]) {
    for (let i = 1; i <= 4; i += 1) {
      await mkdir(join(env.runsDir, `${day}T000000Z-notes-00000${String(i)}`), {
        recursive: true,
      });
    }
    await mkdir(join(env.runsDir, `${day}T000000Z-notes-000005-dry`), { recursive: true });
  }
  const before = (await listRunDirs(env.runsDir)).sort();
  const { run } = await spawnMain(env, "tests/fixtures/coord/goals/notes.json", "plan", []);
  const [rc, , stderr] = await Promise.all([run.waitExit(), run.stdoutText(), run.stderrText()]);
  expect(rc).toBe(3);
  expect(stderr).toContain("coord: run-cap 4 runs today");
  expect((await listRunDirs(env.runsDir)).sort()).toEqual(before);
}, 30000);

test("a held run lock refuses the run (M8)", async () => {
  const env = await createCoordTestEnv();
  const holderPath = join(env.runsDir, "coordinator");
  const holder = Bun.spawn(
    [process.execPath, join(process.cwd(), "tests", "work", "lock-holder.case.ts")],
    {
      cwd: process.cwd(),
      env: { ...process.env, WORK_STORE_TEST_PATH: holderPath },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const holderReader = holder.stdout.getReader();
  const holderDecoder = new TextDecoder();
  let holderSeen = "";
  const holderDeadline = Date.now() + 5000;
  for (;;) {
    const chunk = await holderReader.read();
    if (chunk.done) {
      break;
    }
    holderSeen += holderDecoder.decode(chunk.value, { stream: true });
    if (holderSeen.includes("holder ready")) {
      break;
    }
    if (Date.now() > holderDeadline) {
      throw new Error("lock holder did not become ready in time");
    }
  }
  holderReader.releaseLock();
  const { run } = await spawnMain(env, "tests/fixtures/coord/goals/notes.json", "plan", []);
  const [rc, , stderr] = await Promise.all([run.waitExit(), run.stdoutText(), run.stderrText()]);
  expect(rc).toBe(2);
  expect(stderr).toContain("coord: another coordinator run is active");
  expect(await listRunDirs(env.runsDir)).toEqual([]);
  holder.kill("SIGKILL");
  await holder.exited.catch(() => {});
}, 30000);

test("a dry run prints the spawn plan without gating or spawning (M9)", async () => {
  for (const phase of ["plan", "full"] as const) {
    const env = await createCoordTestEnv();
    const gateRefusePath = join(env.dir, "gate-refuse.json");
    const spawned = await spawnMain(
      env,
      "tests/fixtures/coord/goals/notes.json",
      phase,
      ["--dry-run"],
      { budgetGateConfigPath: gateRefusePath },
    );
    const [rc, stdout, stderr] = await Promise.all([
      spawned.run.waitExit(),
      spawned.run.stdoutText(),
      spawned.run.stderrText(),
    ]);
    expect(rc).toBe(0);
    expect(stderr).toBe("");
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["argv", "covers", "cwd", "phase", "runDir"]);
    expect(parsed["phase"]).toBe(phase);
    expect(parsed["covers"]).toBe("plan");
    const runDir = parsed["runDir"] as string;
    expect(basenameOf(runDir).endsWith("-dry")).toBe(true);
    expect(parsed["cwd"]).toBe(join(runDir, "workspace"));
    const { config } = await loadCoordConfig(spawned.configPath);
    const sessionId = (parsed["argv"] as readonly string[])[
      (parsed["argv"] as readonly string[]).indexOf("--session-id") + 1
    ] as string;
    expect(parsed["argv"]).toEqual(
      museArgv(config, {
        kind: "plan",
        k: 1,
        sessionId,
        runDir,
        checkoutDir: realpathSync(env.checkoutDir),
        bunPath: process.execPath,
      }),
    );
    const names = (await readdir(runDir)).sort();
    expect(names).toEqual(["home", "mcp.json", "prompt-1.md", "workspace"]);
  }
}, 30000);

function basenameOf(path: string): string {
  return path.split("/").at(-1) as string;
}

test("a bad muse command reports muse-unavailable (M10)", async () => {
  const env = await createCoordTestEnv();
  const { run } = await spawnMain(env, "tests/fixtures/coord/goals/notes.json", "plan", [], {
    museCommand: ["/nonexistent/muse"],
  });
  const [rc, stdout] = await Promise.all([run.waitExit(), run.stdoutText()]);
  await run.stderrText();
  expect(rc).toBe(3);
  const last = stdout.trim().split("\n").at(-1) as string;
  expect(last).toMatch(/stop=muse-unavailable/);
  const dirs = await listRunDirs(env.runsDir);
  expect(dirs.length).toBe(1);
  const runDir = join(env.runsDir, dirs[0] as string);
  const report = (await Bun.file(join(runDir, "report.json")).json()) as {
    readonly sessions: readonly { readonly outcome: unknown }[];
  };
  expect(report.sessions[0]?.outcome).toEqual({
    kind: "spawn-failed",
    stage: "exec",
    code: "ENOENT",
  });
}, 30000);

test("watch with dry-run is rejected (M11)", async () => {
  const env = await createCoordTestEnv();
  const gateRefusePath = join(env.dir, "gate-refuse.json");
  const spawned = await spawnMain(
    env,
    "tests/fixtures/coord/goals/notes.json",
    "watch",
    ["--dry-run"],
    { budgetGateConfigPath: gateRefusePath },
  );
  const [rc, , stderr] = await Promise.all([
    spawned.run.waitExit(),
    spawned.run.stdoutText(),
    spawned.run.stderrText(),
  ]);
  expect(rc).toBe(2);
  expect(stderr).toBe("coord: --dry-run needs --phase plan or full\n");
  expect(await listRunDirs(env.runsDir)).toEqual([]);
}, 30000);

test("a live session record refuses the run, a dead one is cleared (M12)", async () => {
  const env = await createCoordTestEnv();
  const recordPath = join(env.runsDir, "coordinator-session.json");
  const sleeper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = sleeper.pid;
  try {
    await Bun.write(
      recordPath,
      JSON.stringify({ runId: "20261028T100000Z-notes-abcdef", k: 1, pid }),
    );
    const gateRefusePath = join(env.dir, "gate-refuse.json");
    const first = await spawnMain(
      env,
      "tests/fixtures/coord/goals/notes.json",
      "plan",
      ["--dry-run"],
      { budgetGateConfigPath: gateRefusePath },
    );
    const [rc1, , stderr1] = await Promise.all([
      first.run.waitExit(),
      first.run.stdoutText(),
      first.run.stderrText(),
    ]);
    expect(rc1).toBe(2);
    expect(stderr1).toContain(`may still be running (process group ${String(pid)})`);
    expect(await Bun.file(recordPath).text()).toBe(
      JSON.stringify({ runId: "20261028T100000Z-notes-abcdef", k: 1, pid }),
    );
    expect((): void => {
      process.kill(-pid, 0);
    }).not.toThrow();
    expect(await listRunDirs(env.runsDir)).toEqual([]);
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group may already be gone.
    }
    await sleeper.exited.catch(() => {});
  }
  const gateRefusePath = join(env.dir, "gate-refuse.json");
  const second = await spawnMain(
    env,
    "tests/fixtures/coord/goals/notes.json",
    "plan",
    ["--dry-run"],
    { budgetGateConfigPath: gateRefusePath },
  );
  const [rc2, , stderr2] = await Promise.all([
    second.run.waitExit(),
    second.run.stdoutText(),
    second.run.stderrText(),
  ]);
  expect(rc2).toBe(0);
  expect(stderr2).toContain("ended without its launcher");
  expect(await Bun.file(recordPath).exists()).toBe(false);
}, 30000);

test("SIGTERM during the session reports signal (M13)", async () => {
  const env = await createCoordTestEnv();
  const spawned = await spawnMain(
    env,
    "tests/fixtures/coord/goals/notes.json",
    "plan",
    [],
    {},
    "hang.json",
  );
  const stdoutPromise = spawned.run.stdoutText();
  const stderrPromise = spawned.run.stderrText();
  const exitPromise = spawned.run.waitExit();
  const recordPath = join(env.runsDir, "coordinator-session.json");
  const waitForStart = async (): Promise<{
    readonly runDir: string;
    readonly sessionPid: number;
  }> => {
    const deadline = Date.now() + 10000;
    for (;;) {
      const found = await listRunDirs(env.runsDir);
      if (found.length === 1) {
        const candidate = join(env.runsDir, found[0] as string);
        const coordPath = join(candidate, "coord.jsonl");
        if (await Bun.file(coordPath).exists()) {
          const text = await Bun.file(coordPath).text();
          if (text.includes("session-start") && (await Bun.file(recordPath).exists())) {
            if (!(await Bun.file(env.recordPath).exists())) {
              await Bun.sleep(20);
              continue;
            }
            const parsed = JSON.parse(await Bun.file(recordPath).text()) as { pid: number };
            expect((): void => {
              process.kill(-parsed.pid, 0);
            }).not.toThrow();
            return { runDir: candidate, sessionPid: parsed.pid };
          }
        }
      }
      if (Date.now() > deadline) {
        spawned.run.proc.kill("SIGKILL");
        throw new Error("session did not start in time");
      }
      await Bun.sleep(20);
    }
  };
  const { runDir, sessionPid } = await waitForStart();
  try {
    spawned.run.proc.kill("SIGTERM");
    const [rc, stdout] = await Promise.all([exitPromise, stdoutPromise]);
    expect(rc).toBe(0);
    await stderrPromise;
    expect(stdout.trim().split("\n").at(-1)).toMatch(/stop=signal/);
    const report = (await Bun.file(join(runDir, "report.json")).json()) as {
      readonly sessions: readonly { readonly outcome: unknown }[];
    };
    expect(report.sessions[0]?.outcome).toEqual({ kind: "aborted" });
    const record = (await Bun.file(env.recordPath).json()) as { readonly grandchildPid: number };
    await waitGrandchildGone(record.grandchildPid);
    expect(await Bun.file(recordPath).exists()).toBe(false);
  } finally {
    try {
      process.kill(-sessionPid, "SIGKILL");
    } catch {
      // The group is gone when the mutation is absent.
    }
  }
}, 30000);

test("the d1 fixture resolves to the demo store (M14)", async () => {
  const { config } = await loadCoordConfig("tests/fixtures/coord/d1/coordinator.json");
  const committed = (await Bun.file("config/coordinator.json").json()) as Record<string, unknown>;
  const expected: Record<string, unknown> = {
    ...committed,
    mcpConfigPath: "tests/fixtures/mcp/demo/mcp.json",
    runsDir: (config as unknown as Record<string, unknown>)["runsDir"],
  };
  expect({ ...(config as unknown as Record<string, unknown>) }).toEqual(expected);
}, 30000);

test("arg errors name the flag (M15)", async () => {
  const env = await createCoordTestEnv();
  const configPath = join(env.dir, "coordinator-main.json");
  await Bun.write(configPath, `${JSON.stringify(env.configJson)}\n`);
  const direct = Bun.spawn(
    [
      process.execPath,
      "run",
      join(env.checkoutDir, "src/coord/main.ts"),
      "--goal",
      "a",
      "--goal",
      "b",
      "--phase",
      "plan",
    ],
    { cwd: env.checkoutDir, stdout: "pipe", stderr: "pipe" },
  );
  const [rc1, stderr1] = await Promise.all([
    (async (): Promise<number> => {
      const code = await direct.exited;
      return code;
    })(),
    new Response(direct.stderr).text(),
  ]);
  await new Response(direct.stdout).text();
  expect(rc1).toBe(2);
  expect(stderr1).toContain("coord: --goal given more than once");
  const bogus = Bun.spawn(
    [process.execPath, "run", join(env.checkoutDir, "src/coord/main.ts"), "--bogus"],
    { cwd: env.checkoutDir, stdout: "pipe", stderr: "pipe" },
  );
  const [rc2, stderr2] = await Promise.all([
    (async (): Promise<number> => bogus.exited)(),
    new Response(bogus.stderr).text(),
  ]);
  await new Response(bogus.stdout).text();
  expect(rc2).toBe(2);
  expect(stderr2).toContain("coord: unknown argument --bogus");
}, 30000);

test("a missing goal file refuses the run, a missing key refuses without a run dir (M18)", async () => {
  const env = await createCoordTestEnv();
  const missing = await spawnMain(env, "tests/fixtures/coord/goals/missing.json", "plan", []);
  const [missingRc, , missingStderr] = await Promise.all([
    missing.run.waitExit(),
    missing.run.stdoutText(),
    missing.run.stderrText(),
  ]);
  expect(missingRc).toBe(2);
  expect(missingStderr).toContain("coord: ");
  expect(await listRunDirs(env.runsDir)).toEqual([]);
  const keylessConfigPath = join(env.dir, "coordinator-keyless.json");
  await Bun.write(
    keylessConfigPath,
    `${JSON.stringify({
      ...env.configJson,
      skillDir: join(process.cwd(), ".agents/skills/factory-coord"),
    })}\n`,
  );
  const keyless = Bun.spawn(
    [
      process.execPath,
      "run",
      join(env.checkoutDir, "src/coord/main.ts"),
      "--goal",
      join(process.cwd(), "tests/fixtures/coord/goals/notes.json"),
      "--phase",
      "plan",
      "--config",
      keylessConfigPath,
    ],
    {
      cwd: env.checkoutDir,
      env: {
        PATH: process.env["PATH"],
        FAKE_MUSE_RECORD: env.recordPath,
        FAKE_MUSE_SCRIPT: join(FAKE_DIR, "plan-notes.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [keylessRc, , keylessStderr] = await Promise.all([
    (async (): Promise<number> => keyless.exited)(),
    new Response(keyless.stdout).text(),
    new Response(keyless.stderr).text(),
  ]);
  expect(keylessRc).toBe(2);
  expect(keylessStderr).toContain("coord: META_API_KEY is not set");
  expect(await listRunDirs(env.runsDir)).toEqual([]);
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

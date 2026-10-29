// Muse session tests (S1-S11): env isolation, tools/call round trip,
// process-group kill, export gating, env failures and log shapes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { realpath, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CallLog } from "../../src/mcp/call-log.js";
import { readCoordCalls } from "../../src/coord/calls.js";
import { museArgv, type MuseSession } from "../../src/coord/argv.js";
import { loadCoordConfig } from "../../src/coord/config.js";
import {
  museEnv,
  runMuseSession,
  SessionEnvError,
  type MuseSessionDeps,
  type MuseSessionOpts,
} from "../../src/coord/session.js";
import { sha256Hex } from "../../src/work/canonical.js";
import { createCoordTestEnv, createRunDir, type CoordTestEnv } from "./env.js";

const RUN_ID = "20261028T100000Z-notes-abcdef";
const SESSION_ID = "0b7e6f52-3c1d-4e8a-9f20-6a5d4c3b2a19";
const FAKE_DIR = join(process.cwd(), "tests", "fixtures", "coord", "fake");

function scriptPath(name: string): string {
  return join(FAKE_DIR, name);
}

interface Setup {
  env: CoordTestEnv;
  runDir: string;
  session: MuseSession;
  entries: Record<string, unknown>[];
  deps: MuseSessionDeps;
  opts: MuseSessionOpts;
  controller: AbortController;
}

async function setupEnv(script: string): Promise<Setup> {
  const env = await createCoordTestEnv();
  const runDir = await createRunDir(env, RUN_ID);
  const { config } = await loadCoordConfig(env.configPath);
  const session: MuseSession = {
    kind: "plan",
    k: 1,
    sessionId: SESSION_ID,
    runDir,
    checkoutDir: env.checkoutDir,
    bunPath: process.execPath,
  };
  const entries: Record<string, unknown>[] = [];
  const log: CallLog = {
    append(entry: Record<string, unknown>): Promise<void> {
      entries.push(entry);
      return Promise.resolve();
    },
  };
  const deps: MuseSessionDeps = {
    env: {
      PATH: process.env["PATH"],
      FAKE_MUSE_RECORD: env.recordPath,
      FAKE_MUSE_SCRIPT: scriptPath(script),
      META_API_KEY: "test-key",
    },
    log,
    now: () => new Date(),
    onSpawn: () => {},
  };
  const controller = new AbortController();
  const opts: MuseSessionOpts = {
    config,
    session,
    apiKeyEnv: "META_API_KEY",
    timeoutMs: 60000,
    killGraceMs: 200,
    signal: controller.signal,
  };
  return { env, runDir, session, entries, deps, opts, controller };
}

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

async function setupEnvFresh(
  env: CoordTestEnv,
  runDir: string,
  script: string,
): Promise<{
  opts: MuseSessionOpts;
  deps: MuseSessionDeps;
  entries: Record<string, unknown>[];
}> {
  const { config } = await loadCoordConfig(env.configPath);
  const session: MuseSession = {
    kind: "plan",
    k: 1,
    sessionId: SESSION_ID,
    runDir,
    checkoutDir: env.checkoutDir,
    bunPath: process.execPath,
  };
  const scriptName = script.includes("/") || script.includes("\\") ? script : scriptPath(script);
  const entries: Record<string, unknown>[] = [];
  const deps: MuseSessionDeps = {
    env: {
      PATH: process.env["PATH"],
      FAKE_MUSE_RECORD: env.recordPath,
      FAKE_MUSE_SCRIPT: scriptName,
      META_API_KEY: "test-key",
    },
    log: {
      append(entry: Record<string, unknown>): Promise<void> {
        entries.push(entry);
        return Promise.resolve();
      },
    },
    now: () => new Date(),
    onSpawn: () => {},
  };
  const controller = new AbortController();
  return {
    opts: {
      config,
      session,
      apiKeyEnv: "META_API_KEY",
      timeoutMs: 60000,
      killGraceMs: 200,
      signal: controller.signal,
    },
    deps,
    entries,
  };
}

async function listTreeFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    const names = await readdir(current, { withFileTypes: true });
    for (const entry of names) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        found.push(full);
      }
    }
  }
  await walk(dir);
  return found;
}

test("the exec env carries only passthrough names plus the isolated home (S1)", async () => {
  const { env, runDir, entries, deps, opts } = await setupEnv("fleet.json");
  const result = await runMuseSession(opts, deps);
  expect(result.outcome).toEqual({ kind: "exited", rc: 0 });
  const recordS1 = (await Bun.file(env.recordPath).json()) as {
    readonly envKeys: readonly string[];
    readonly home: string;
    readonly cwd: string;
    readonly stdinSha256: string;
  };
  expect(recordS1.envKeys).toEqual([
    "FAKE_MUSE_RECORD",
    "FAKE_MUSE_SCRIPT",
    "HOME",
    "PATH",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]);
  expect(recordS1.home).toBe(join(runDir, "home"));
  expect(await realpath(recordS1.cwd)).toBe(await realpath(join(runDir, "workspace")));
  expect(recordS1.stdinSha256).toBe(sha256Hex("test-key\n"));
  const files = await listTreeFiles(env.dir);
  for (const file of files) {
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    expect(text.includes("test-key")).toBe(false);
  }
  for (const entry of entries) {
    expect(JSON.stringify(entry).includes("test-key")).toBe(false);
  }
}, 30000);

test("the fleet_status call round-trips through the MCP server (S2)", async () => {
  const { runDir, deps, opts } = await setupEnv("fleet.json");
  const result = await runMuseSession(opts, deps);
  expect(result.outcome).toEqual({ kind: "exited", rc: 0 });
  const calls = await readCoordCalls(join(runDir, "mcp-calls.jsonl"));
  expect(calls?.length).toBe(1);
  expect(calls?.[0]?.tool).toBe("fleet_status");
  expect(calls?.[0]?.outcome).toBe("ok");
  expect(calls?.[0]?.caller).toBe("coordinator");
  const lines = (await Bun.file(join(runDir, "mcp-calls.jsonl")).text()).split("\n");
  const starts = lines.filter((line) => line.includes('"event":"server-start"'));
  expect(starts.length).toBeGreaterThan(0);
  expect(starts[0]?.includes('"caller":"coordinator"')).toBe(true);
}, 30000);

test("a hang times out and kills the process group (S3)", async () => {
  const setup = await setupEnv("hang.json");
  const opts: MuseSessionOpts = { ...setup.opts, timeoutMs: 1500 };
  const result = await runMuseSession(opts, setup.deps);
  expect(result.outcome).toEqual({ kind: "timeout" });
  const record = (await Bun.file(setup.env.recordPath).json()) as {
    readonly grandchildPid: number;
  };
  await waitGrandchildGone(record.grandchildPid);
  expect(true).toBe(true);
}, 30000);

test("a nonzero exit still exports, and a failed export is recorded (S4)", async () => {
  const setup = await setupEnv("exit7.json");
  const result = await runMuseSession(setup.opts, setup.deps);
  expect(result.outcome).toEqual({ kind: "exited", rc: 7 });
  expect(result.exportOk).toBe(true);
  const exported = Bun.file(join(setup.runDir, "session-1-export.json"));
  expect(await exported.exists()).toBe(true);
  const fresh = await createRunDir(setup.env, `${RUN_ID}-s4b`);
  const failingName = "exit7-fails.json";
  await Bun.write(
    join(setup.env.dir, failingName),
    '{"calls":[],"exit":7,"hang":false,"exportFails":true}',
  );
  const second = await setupEnvFresh(setup.env, fresh, join(setup.env.dir, failingName));
  const secondResult = await runMuseSession(second.opts, second.deps);
  expect(secondResult.exportOk).toBe(false);
  const exports = second.entries.filter((entry) => entry["event"] === "export");
  expect(exports.length).toBe(1);
  const line = exports[0] as Record<string, unknown>;
  expect(line["event"]).toBe("export");
  expect(line["k"]).toBe(1);
  expect(line["ok"]).toBe(false);
  expect(line["reason"]).toBe("exit");
  expect(line["rc"]).toBe(5);
}, 30000);

test("an abort during setup is reported as aborted (S10)", async () => {
  const setup = await setupEnv("hang.json");
  const controller = new AbortController();
  const inner: CallLog = setup.deps.log;
  let first = true;
  const log: CallLog = {
    append(entry: Record<string, unknown>): Promise<void> {
      const pending = inner.append(entry);
      if (first) {
        first = false;
        void (async (): Promise<void> => {
          await pending;
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
          controller.abort();
        })();
      }
      return pending;
    },
  };
  const opts: MuseSessionOpts = {
    ...setup.opts,
    timeoutMs: 3000,
    signal: controller.signal,
  };
  const deps: MuseSessionDeps = { ...setup.deps, log };
  const started = Date.now();
  const result = await runMuseSession(opts, deps);
  const elapsed = Date.now() - started;
  expect(result.outcome).toEqual({ kind: "aborted" });
  expect(elapsed).toBeLessThan(2000);
}, 30000);

test("a missing key rejects before any event, dir or spawn (S5)", async () => {
  const setup = await setupEnv("fleet.json");
  const withoutKey: MuseSessionDeps = {
    ...setup.deps,
    env: {
      PATH: process.env["PATH"],
      FAKE_MUSE_RECORD: setup.env.recordPath,
      FAKE_MUSE_SCRIPT: scriptPath("fleet.json"),
    },
  };
  await runMuseSession(setup.opts, withoutKey).then(
    () => {
      throw new Error("expected SessionEnvError");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(SessionEnvError);
      expect((error as Error).message).toBe("coord: META_API_KEY is not set");
    },
  );
  const emptyKey: MuseSessionDeps = {
    ...setup.deps,
    env: { ...withoutKey.env, META_API_KEY: "" },
  };
  await runMuseSession(setup.opts, emptyKey).then(
    () => {
      throw new Error("expected SessionEnvError");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(SessionEnvError);
      expect((error as Error).message).toBe("coord: META_API_KEY is not set");
    },
  );
  expect(setup.entries.length).toBe(0);
  expect(await Bun.file(setup.env.recordPath).exists()).toBe(false);
}, 30000);

test("an unknown command reports spawn-failed without exporting (S6)", async () => {
  const setup = await setupEnv("fleet.json");
  const opts: MuseSessionOpts = {
    ...setup.opts,
    config: { ...setup.opts.config, museCommand: ["/nonexistent/muse"] },
  };
  const result = await runMuseSession(opts, setup.deps);
  expect(result.outcome).toEqual({ kind: "spawn-failed", stage: "exec", code: "ENOENT" });
  expect(result.exportOk).toBe(false);
  expect(setup.entries.some((entry) => entry["event"] === "export")).toBe(false);
}, 30000);

test("an abort wins over the deadline and kills the process group (S7)", async () => {
  const setup = await setupEnv("hang.json");
  const opts: MuseSessionOpts = { ...setup.opts, timeoutMs: 5000 };
  setTimeout(() => {
    setup.controller.abort();
  }, 300);
  const result = await runMuseSession(opts, setup.deps);
  expect(result.outcome).toEqual({ kind: "aborted" });
  const record = (await Bun.file(setup.env.recordPath).json()) as {
    readonly grandchildPid: number;
  };
  await waitGrandchildGone(record.grandchildPid);
  expect(true).toBe(true);
}, 30000);

test("the log carries start, sha-pinned end and nothing else (S8)", async () => {
  const setup = await setupEnv("exit7.json");
  const result = await runMuseSession(setup.opts, setup.deps);
  expect(result.outcome).toEqual({ kind: "exited", rc: 7 });
  expect(setup.entries.map((entry) => entry["event"])).toEqual([
    "session-start",
    "session-end",
    "export",
  ]);
  const start = setup.entries[0] as Record<string, unknown>;
  expect(start["argvSha256"]).toBe(
    sha256Hex(JSON.stringify(museArgv(setup.opts.config, setup.session))),
  );
  const end = setup.entries[1] as Record<string, unknown>;
  expect(end["outcome"]).toBe("exited");
  expect(end["rc"]).toBe(7);
}, 30000);

test("museEnv isolates HOME and the XDG dirs (S9)", () => {
  expect(museEnv(["PATH"], "/r", { PATH: "/bin", OTHER: "x", META_API_KEY: "k" })).toEqual({
    PATH: "/bin",
    HOME: "/r/home",
    XDG_CONFIG_HOME: "/r/home/.config",
    XDG_DATA_HOME: "/r/home/.local/share",
    XDG_STATE_HOME: "/r/home/.local/state",
    XDG_CACHE_HOME: "/r/home/.cache",
  });
});

test("an onSpawn throw rejects without session-end (S11)", async () => {
  const setup = await setupEnv("hang.json");
  const pids: number[] = [];
  const deps: MuseSessionDeps = {
    ...setup.deps,
    onSpawn: (pid: number): void => {
      pids.push(pid);
      throw new Error("record failed");
    },
  };
  const opts: MuseSessionOpts = { ...setup.opts, timeoutMs: 5000 };
  await runMuseSession(opts, deps).then(
    () => {
      throw new Error("expected record failed");
    },
    (error: unknown) => {
      expect((error as Error).message).toBe("record failed");
    },
  );
  expect(pids.length).toBe(1);
  expect(Number.isInteger(pids[0] as number)).toBe(true);
  // The onSpawn throw kills the group before the fake starts, so the fake
  // never writes its record: there is no grandchild to wait for, and no
  // session-end is logged.
  expect(setup.entries.map((entry) => entry["event"])).toEqual(["session-start"]);
}, 30000);

// Muse session runner: isolated env, process-group kill and redacted export.
// The key travels only in the exec stdin bytes, never in argv, env or logs.
import { mkdir, open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import type { CallLog } from "../mcp/call-log.js";
import { sha256Hex } from "../work/canonical.js";
import { exportArgv, museArgv, type MuseSession } from "./argv.js";
import type { CoordConfig } from "./config.js";

export type SessionOutcome =
  | { readonly kind: "exited"; readonly rc: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  | { readonly kind: "spawn-failed"; readonly stage: "files" | "exec"; readonly code: string };

export interface MuseSessionOpts {
  readonly config: CoordConfig;
  readonly session: MuseSession;
  readonly apiKeyEnv: string;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly signal: AbortSignal;
}

export interface MuseSessionDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: CallLog;
  readonly now: () => Date;
}

export interface MuseSessionResult {
  readonly outcome: SessionOutcome;
  readonly durationMs: number;
  readonly exportOk: boolean;
}

export class SessionEnvError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionEnvError";
  }
}

export function checkSessionEnv(
  envPassthrough: readonly string[],
  apiKeyEnv: string,
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const name of [...envPassthrough, apiKeyEnv]) {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new SessionEnvError(`coord: ${name} is not set`);
    }
  }
}

export function museEnv(
  envPassthrough: readonly string[],
  runDir: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const home = join(runDir, "home");
  const result: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
  for (const name of envPassthrough) {
    const value = env[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

async function closeQuiet(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The second open already failed; the first close is best-effort.
  }
}

function spawnCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "unknown";
}

function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return;
    }
    throw error;
  }
}

function exitRc(exitCode: number | null, signalCode: unknown): number {
  if (typeof exitCode === "number") {
    return exitCode;
  }
  if (typeof signalCode === "string") {
    const table: Readonly<Record<string, number>> = constants.signals;
    const offset: number | undefined = table[signalCode];
    if (typeof offset === "number") {
      return 128 + offset;
    }
  }
  throw new Error(
    `coord: unknown exit signal exitCode=${String(exitCode)} signalCode=${String(signalCode)}`,
  );
}

async function appendSpawnFailed(
  log: CallLog,
  now: () => Date,
  t0: Date,
  k: number,
  stage: "files" | "exec",
  code: string,
): Promise<MuseSessionResult> {
  const end = now();
  const durationMs = end.getTime() - t0.getTime();
  await log.append({
    ts: end.toISOString(),
    event: "session-end",
    k,
    outcome: "spawn-failed",
    rc: null,
    durationMs,
    stage,
    code,
  });
  return { outcome: { kind: "spawn-failed", stage, code }, durationMs, exportOk: false };
}

async function runSessionExport(
  opts: MuseSessionOpts,
  deps: MuseSessionDeps,
  childEnv: Record<string, string>,
): Promise<boolean> {
  const { config, session } = opts;
  const { log, now } = deps;
  const k = session.k;
  const exportPath = join(session.runDir, `session-${String(k)}-export.json`);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...exportArgv(config, session)], {
      cwd: join(session.runDir, "workspace"),
      env: childEnv,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
  } catch {
    const at = now();
    await log.append({
      ts: at.toISOString(),
      event: "export",
      k,
      ok: false,
      reason: "spawn",
      rc: null,
    });
    return false;
  }
  const exportState = { timedOut: false };
  const timer = setTimeout(() => {
    exportState.timedOut = true;
    killGroup(proc.pid, "SIGKILL");
  }, config.exportTimeoutMs);
  let rc: number;
  try {
    rc = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  const at = now();
  if (exportState.timedOut) {
    await log.append({
      ts: at.toISOString(),
      event: "export",
      k,
      ok: false,
      reason: "timeout",
      rc: null,
    });
    return false;
  }
  if (rc !== 0) {
    await log.append({
      ts: at.toISOString(),
      event: "export",
      k,
      ok: false,
      reason: "exit",
      rc,
    });
    return false;
  }
  let regular: boolean;
  try {
    regular = (await stat(exportPath)).isFile();
  } catch {
    regular = false;
  }
  if (regular) {
    await log.append({ ts: at.toISOString(), event: "export", k, ok: true });
    return true;
  }
  await log.append({
    ts: at.toISOString(),
    event: "export",
    k,
    ok: false,
    reason: "exit",
    rc,
  });
  return false;
}

export async function runMuseSession(
  opts: MuseSessionOpts,
  deps: MuseSessionDeps,
): Promise<MuseSessionResult> {
  const { config, session, apiKeyEnv } = opts;
  const { env, log, now } = deps;
  checkSessionEnv(config.envPassthrough, apiKeyEnv, env);
  const t0 = now();
  const k = session.k;
  const home = join(session.runDir, "home");
  const childEnv = museEnv(config.envPassthrough, session.runDir, env);
  const argvSha256 = sha256Hex(JSON.stringify(museArgv(config, session)));
  await log.append({
    ts: t0.toISOString(),
    event: "session-start",
    k,
    kind: session.kind,
    sessionId: session.sessionId,
    argvSha256,
  });
  if (opts.signal.aborted) {
    const aborted = now();
    await log.append({
      ts: aborted.toISOString(),
      event: "session-end",
      k,
      outcome: "aborted",
      rc: null,
      durationMs: 0,
    });
    return { outcome: { kind: "aborted" }, durationMs: 0, exportOk: false };
  }
  const workspace = join(session.runDir, "workspace");
  try {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(join(home, ".config"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, ".local", "share"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, ".local", "state"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, ".cache"), { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    return appendSpawnFailed(log, now, t0, k, "files", spawnCode(error));
  }
  let jsonl: FileHandle;
  try {
    jsonl = await open(join(session.runDir, `session-${String(k)}.jsonl`), "wx", 0o600);
  } catch (error: unknown) {
    return appendSpawnFailed(log, now, t0, k, "files", spawnCode(error));
  }
  let stderrHandle: FileHandle;
  try {
    stderrHandle = await open(join(session.runDir, `session-${String(k)}.stderr`), "wx", 0o600);
  } catch (error: unknown) {
    await closeQuiet(jsonl);
    return appendSpawnFailed(log, now, t0, k, "files", spawnCode(error));
  }
  const apiKey = env[apiKeyEnv] as string;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...museArgv(config, session)], {
      cwd: workspace,
      env: childEnv,
      stdin: new TextEncoder().encode(`${apiKey}\n`),
      stdout: jsonl.fd,
      stderr: stderrHandle.fd,
      detached: true,
    });
  } catch (error: unknown) {
    await closeQuiet(jsonl);
    await closeQuiet(stderrHandle);
    return appendSpawnFailed(log, now, t0, k, "exec", spawnCode(error));
  }
  const pid = proc.pid;
  const killState: {
    killed: "timeout" | "aborted" | null;
    done: Promise<void> | null;
    killError: unknown;
  } = { killed: null, done: null, killError: null };
  const recordKillError = (error: unknown): void => {
    if (killState.killError === null) {
      killState.killError = error;
    }
  };
  const armKill = (): void => {
    killState.done = new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          killGroup(pid, "SIGKILL");
        } catch (error: unknown) {
          recordKillError(error);
        } finally {
          resolve();
        }
      }, opts.killGraceMs);
    });
  };
  const onTimeout = (): void => {
    if (killState.killed === null) {
      killState.killed = "timeout";
      try {
        killGroup(pid, "SIGTERM");
      } catch (error: unknown) {
        recordKillError(error);
      }
      armKill();
    }
  };
  const onAbort = (): void => {
    if (killState.killed === null) {
      killState.killed = "aborted";
      try {
        killGroup(pid, "SIGTERM");
      } catch (error: unknown) {
        recordKillError(error);
      }
      armKill();
    }
  };
  const timeoutTimer = setTimeout(onTimeout, opts.timeoutMs);
  opts.signal.addEventListener("abort", onAbort, { once: true });
  // The setup awaits above can resolve after the abort lands, so the signal
  // can read as aborted here even though it was live at the entry check.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (opts.signal.aborted) {
    onAbort();
  }
  try {
    await proc.exited;
  } finally {
    clearTimeout(timeoutTimer);
    opts.signal.removeEventListener("abort", onAbort);
    if (killState.done !== null) {
      await killState.done;
    }
    await jsonl.close();
    await stderrHandle.close();
  }
  if (killState.killError !== null) {
    throw killState.killError as Error;
  }
  const end = now();
  const durationMs = end.getTime() - t0.getTime();
  const outcome: SessionOutcome =
    killState.killed === null
      ? { kind: "exited", rc: exitRc(proc.exitCode, proc.signalCode) }
      : { kind: killState.killed };
  await log.append({
    ts: end.toISOString(),
    event: "session-end",
    k,
    outcome: outcome.kind,
    rc: outcome.kind === "exited" ? outcome.rc : null,
    durationMs,
  });
  const exportOk = await runSessionExport(opts, deps, childEnv);
  return { outcome, durationMs, exportOk };
}

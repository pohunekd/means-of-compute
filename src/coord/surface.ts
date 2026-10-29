// Tool-surface checks for coordinator sessions: the six factory tools with
// no built-in, the allowed context sources, and an inactive posture with an
// empty reminder roster. The echo probe runs without the key, so the check
// reads only the export documents.
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { CoordConfig } from "./config.js";
import { COORD_TOOLS } from "./report.js";
import { exitRc, killGroup, museEnv, spawnCode } from "./session.js";
import { probeArgv, probeExportArgv, type MuseSession } from "./argv.js";

export const ALLOWED_TOOLS: readonly string[] = COORD_TOOLS.map((t) => `mcp__factory__${t}`);

export const ALLOWED_CONTEXT_SOURCES: readonly string[] = [
  "capability_policy",
  "meta_context_note",
  "security_mode",
  "session_identity",
  "skills",
  "workspace_identity",
];

export type SurfaceReason =
  "unreadable" | "mode" | "tools" | "context" | "delegation" | "reminders";

export type SurfaceVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: SurfaceReason;
      readonly extra: readonly string[];
      readonly missing: readonly string[];
    };

export type ProbeResult =
  | { readonly kind: "checked"; readonly verdict: SurfaceVerdict }
  | { readonly kind: "probe-failed"; readonly reason: "probe-timeout" | "probe-exit" }
  | { readonly kind: "spawn-failed"; readonly code: string }
  | { readonly kind: "aborted" };

interface SurfaceRecord {
  readonly toolset: { readonly mode: string; readonly activeTools: readonly string[] };
  readonly sources: readonly string[];
  readonly delegationState: string;
  readonly agentCount: number;
}

function unreadable(): SurfaceVerdict {
  return { ok: false, reason: "unreadable", extra: [], missing: [] };
}

function toRecord(event: unknown): SurfaceRecord | null {
  if (typeof event !== "object" || event === null) {
    return null;
  }
  const record = event as {
    readonly toolset?: unknown;
    readonly run_context_messages?: unknown;
    readonly delegation_posture?: unknown;
    readonly reminder_roster?: unknown;
  };
  if (typeof record.toolset !== "object" || record.toolset === null) {
    return null;
  }
  const toolset = record.toolset as { readonly mode?: unknown; readonly active_tools: unknown };
  const rawTools: unknown = toolset.active_tools;
  if (
    typeof toolset.mode !== "string" ||
    !Array.isArray(rawTools) ||
    !rawTools.every((entry: unknown) => typeof entry === "string")
  ) {
    return null;
  }
  const activeTools: readonly string[] = rawTools;
  if (!Array.isArray(record.run_context_messages)) {
    return null;
  }
  const sources: string[] = [];
  for (const entry of record.run_context_messages as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const source = (entry as { readonly source?: unknown }).source;
    if (typeof source !== "string") {
      return null;
    }
    sources.push(source);
  }
  if (typeof record.delegation_posture !== "object" || record.delegation_posture === null) {
    return null;
  }
  const state = (record.delegation_posture as { readonly state?: unknown }).state;
  if (typeof state !== "string") {
    return null;
  }
  if (typeof record.reminder_roster !== "object" || record.reminder_roster === null) {
    return null;
  }
  const roster = record.reminder_roster as { readonly agents: unknown };
  if (!Array.isArray(roster.agents)) {
    return null;
  }
  const agentCount = roster.agents.length;
  return {
    toolset: { mode: toolset.mode, activeTools },
    sources,
    delegationState: state,
    agentCount,
  };
}

function checkRecord(record: SurfaceRecord): SurfaceVerdict | null {
  if (record.toolset.mode !== "named") {
    return { ok: false, reason: "mode", extra: [], missing: [] };
  }
  const seen = new Set<string>();
  let duplicate = false;
  for (const tool of record.toolset.activeTools) {
    if (seen.has(tool)) {
      duplicate = true;
    }
    seen.add(tool);
  }
  const allowed = new Set<string>(ALLOWED_TOOLS);
  if (duplicate || seen.size !== allowed.size || ![...seen].every((tool) => allowed.has(tool))) {
    const extra = [...seen].filter((tool) => !allowed.has(tool)).sort();
    const missing = [...allowed].filter((tool) => !seen.has(tool)).sort();
    return { ok: false, reason: "tools", extra, missing };
  }
  const allowedSources = new Set<string>(ALLOWED_CONTEXT_SOURCES);
  const extra = [...new Set(record.sources)].filter((s) => !allowedSources.has(s)).sort();
  if (extra.length > 0) {
    return { ok: false, reason: "context", extra, missing: [] };
  }
  if (record.delegationState !== "inactive") {
    return { ok: false, reason: "delegation", extra: [], missing: [] };
  }
  if (record.agentCount > 0) {
    return { ok: false, reason: "reminders", extra: [], missing: [] };
  }
  return null;
}

export function checkSurface(doc: unknown): SurfaceVerdict {
  if (typeof doc !== "object" || doc === null) {
    return unreadable();
  }
  const events = (doc as { readonly events?: unknown }).events;
  if (!Array.isArray(events)) {
    return unreadable();
  }
  const records: unknown[] = [];
  for (const entry of events as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const envelope = (entry as { readonly envelope?: unknown }).envelope;
    if (typeof envelope !== "object" || envelope === null) {
      continue;
    }
    const typed = envelope as { readonly payload_type?: unknown; readonly payload?: unknown };
    if (typed.payload_type !== "runtime.session") {
      continue;
    }
    if (typeof typed.payload !== "object" || typed.payload === null) {
      continue;
    }
    const event = (typed.payload as { readonly event?: unknown }).event;
    if (typeof event !== "object" || event === null) {
      continue;
    }
    const kind = (event as { readonly kind?: unknown }).kind;
    if (kind !== "model_request_configured") {
      continue;
    }
    records.push(event);
  }
  if (records.length === 0) {
    return unreadable();
  }
  for (const event of records) {
    const record = toRecord(event);
    if (record === null) {
      return unreadable();
    }
    const verdict = checkRecord(record);
    if (verdict !== null) {
      return verdict;
    }
  }
  return { ok: true };
}

export async function readSurface(path: string): Promise<SurfaceVerdict> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return unreadable();
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch {
    return unreadable();
  }
  return checkSurface(doc);
}

export interface SurfaceProbeOpts {
  readonly config: CoordConfig;
  readonly session: MuseSession;
  readonly signal: AbortSignal;
}

export interface SurfaceProbeDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
}

export async function runSurfaceProbe(
  opts: SurfaceProbeOpts,
  deps: SurfaceProbeDeps,
): Promise<ProbeResult> {
  const { config, session, signal } = opts;
  const runDir = session.runDir;
  const stem = `probe-${String(session.k)}`;
  if (signal.aborted) {
    return { kind: "aborted" };
  }
  const stdoutHandle = await open(join(runDir, `${stem}.jsonl`), "wx", 0o600);
  let stderrHandle: Awaited<ReturnType<typeof open>>;
  try {
    stderrHandle = await open(join(runDir, `${stem}.stderr`), "wx", 0o600);
  } catch (error: unknown) {
    await stdoutHandle.close();
    throw error;
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...probeArgv(config, session)], {
      cwd: join(runDir, "workspace"),
      env: museEnv(config.envPassthrough, runDir, deps.env),
      stdin: "ignore",
      stdout: stdoutHandle.fd,
      stderr: stderrHandle.fd,
      detached: true,
    });
  } catch (error: unknown) {
    await stdoutHandle.close();
    await stderrHandle.close();
    return { kind: "spawn-failed", code: spawnCode(error) };
  }
  const probeTimedOut = { value: false };
  const probeAborted = { value: false };
  const probeKillError: { value: unknown } = { value: null };
  const timer = setTimeout(() => {
    probeTimedOut.value = true;
    try {
      killGroup(proc.pid, "SIGKILL");
    } catch (error: unknown) {
      probeKillError.value = error;
    }
  }, config.exportTimeoutMs);
  const onAbort = (): void => {
    probeAborted.value = true;
    try {
      killGroup(proc.pid, "SIGKILL");
    } catch (error: unknown) {
      if (probeKillError.value === null) {
        probeKillError.value = error;
      }
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    await stdoutHandle.close();
    await stderrHandle.close();
  }
  if (probeKillError.value !== null) {
    throw probeKillError.value as Error;
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (probeAborted.value || signal.aborted) {
    return { kind: "aborted" };
  }
  if (probeTimedOut.value) {
    return { kind: "probe-failed", reason: "probe-timeout" };
  }
  if (exitRc(proc.exitCode, proc.signalCode) !== 0) {
    return { kind: "probe-failed", reason: "probe-exit" };
  }
  let exportProc: ReturnType<typeof Bun.spawn>;
  try {
    exportProc = Bun.spawn([...probeExportArgv(config, session)], {
      cwd: join(runDir, "workspace"),
      env: museEnv(config.envPassthrough, runDir, deps.env),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
  } catch {
    return { kind: "checked", verdict: await readSurface(join(runDir, `${stem}-export.json`)) };
  }
  const exportAborted = { value: false };
  const exportKillError: { value: unknown } = { value: null };
  const exportTimer = setTimeout(() => {
    try {
      killGroup(exportProc.pid, "SIGKILL");
    } catch (error: unknown) {
      exportKillError.value = error;
    }
  }, config.exportTimeoutMs);
  const onExportAbort = (): void => {
    exportAborted.value = true;
    try {
      killGroup(exportProc.pid, "SIGKILL");
    } catch (error: unknown) {
      if (exportKillError.value === null) {
        exportKillError.value = error;
      }
    }
  };
  signal.addEventListener("abort", onExportAbort, { once: true });
  try {
    await exportProc.exited;
  } finally {
    clearTimeout(exportTimer);
    signal.removeEventListener("abort", onExportAbort);
  }
  if (exportKillError.value !== null) {
    throw exportKillError.value as Error;
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (exportAborted.value || signal.aborted) {
    return { kind: "aborted" };
  }
  return { kind: "checked", verdict: await readSurface(join(runDir, `${stem}-export.json`)) };
}

/* eslint-disable no-useless-assignment, no-dupe-else-if, @typescript-eslint/no-unnecessary-condition */
// Live view model: recorded real fleet, the real meter activity and a
// simulated fleet replayed from a sim-trace-v1 file (docs/dashboard.md).
// Pure: buildLive turns gathered Sourced inputs into the value the live
// renderer turns into HTML. Simulated data arrives only through the sim
// source and never through DashboardInputs, so no existing panel can show it.
import type { NanoPricing } from "../budget/pricing.js";
import type { RegistryEntry } from "../dispatcher/registry.js";
import { readInputText, statInputPath } from "../fs/input.js";
import { HostStateLogDataError, readRecordedProbes, type RecordedProbe } from "../hoststate/log.js";
import { MeterLogError, replayUsageLog, type UsageIndex } from "../meter/usage-log.js";
import { formatUsd, groupDigits, tokenCostScaled } from "./money.js";
import { verdictCounts } from "../auditor/verdict.js";
import type { AuditVerdict, WorkItem } from "../../contracts/v1/types.js";
import type { DashboardInputs, InputFailure, Sourced } from "./inputs.js";
import { openSessionCount } from "./sessions.js";
import { stat } from "node:fs/promises";

// Cell text for counters and activity rows: like the dashboard Cell, but
// the error code may be a live input code as well as a dashboard one.
export type LiveCell =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "no-data"; readonly reason: string }
  | { readonly kind: "error"; readonly code: string };

export const LIVE_STEP_MINUTES = 5;

export type LiveInputCode =
  | "sim-trace-invalid"
  | "sim-trace-unreadable"
  | "meter-usage-invalid"
  | "meter-usage-unreadable"
  | "host-state-log-invalid"
  | "host-state-log-unreadable";

export type LiveFailure =
  | { readonly kind: "no-data"; readonly reason: string }
  | { readonly kind: "error"; readonly code: LiveInputCode };

export type LiveSourced<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: LiveFailure };

export interface LiveSources {
  readonly simTracePath: string | null;
  readonly meterUsagePath: string;
  readonly portsPath: string;
}

export type SimTileState = "offline" | "busy" | "blocked" | "eligible" | "running";

export interface SimTask {
  readonly kind: string;
  readonly title: string;
}

export interface SimHostLine {
  readonly atMinute: number;
  readonly at: string;
  readonly alias: string;
  readonly hostKind: string;
  readonly site: string;
  readonly state: SimTileState;
  readonly eligible: boolean;
  readonly excludeReason: string | null;
  readonly running: number;
  readonly maxAgents: number;
  readonly batteryPercent: number | null;
  readonly task: SimTask | null;
}

export interface SimEventLine {
  readonly atMinute: number;
  readonly at: string;
  readonly alias: string;
  readonly event: string;
  readonly text: string;
}

export interface SimPlacementLine {
  readonly atMinute: number;
  readonly at: string;
  readonly workItemId: string;
  readonly chosenHostAlias: string | null;
  readonly reason: string;
  readonly task: SimTask | null;
  readonly eligibleCount: number;
}

export interface SimWorkEnd {
  readonly atMinute: number;
  readonly at: string;
  readonly workItemId: string;
}

export interface SimTrace {
  readonly timeline: string;
  readonly startAt: string;
  readonly speed: number;
  readonly durationMinutes: number;
  readonly hostCount: number;
  readonly kinds: readonly { readonly kind: string; readonly count: number }[];
  readonly hosts: readonly SimHostLine[];
  readonly events: readonly SimEventLine[];
  readonly placements: readonly SimPlacementLine[];
  readonly workEnds: readonly SimWorkEnd[];
}

export type LiveTileState = SimTileState | "reported" | "unavailable";

// The agent-limit exclusion text is the fixed template at src/placement/place.ts:144;
// place() runs its other exclusion checks first, so a host excluded for another reason
// while running never carries this prefix.
const AGENT_LIMIT_REASON_PREFIX = "excluded: at agent limit (";

export interface LiveTile {
  readonly alias: string;
  readonly hostKind: string;
  readonly site: string;
  readonly simulated: boolean;
  readonly state: LiveTileState;
  readonly eligible: boolean;
  readonly flagged: boolean;
  readonly running: number | null;
  readonly runningError: string | null;
  readonly maxAgents: number | null;
  readonly batteryPercent: number | null;
  readonly detail: string;
}

export interface LiveGroup {
  readonly title: string;
  readonly tiles: readonly LiveTile[];
}

export interface LiveCounter {
  readonly label: string;
  readonly simulated: boolean;
  readonly cell: LiveCell;
}

export interface LiveActivityRow {
  readonly at: string;
  readonly model: string;
  readonly providerId: string;
  readonly role: string | null;
  readonly workItemId: string | null;
  readonly hostAlias: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly ms: number;
  readonly cost: LiveCell;
}

export interface LiveTickerRow {
  readonly at: string;
  readonly simulated: boolean;
  readonly text: string;
}

export type LiveSection<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "no-data"; readonly reason: string }
  | { readonly kind: "error"; readonly code: string };

export interface HostPanelSim {
  readonly kind: "sim";
  readonly alias: string;
  readonly site: string;
  readonly hostKind: string;
  readonly state: SimTileState;
  readonly eligible: boolean;
  readonly excludeReason: string | null;
  readonly batteryPercent: number | null;
  readonly running: number;
  readonly maxAgents: number;
  readonly task: SimTask | null;
  readonly runningTasks: readonly { readonly workItemId: string; readonly at: string }[];
  readonly events: readonly SimEventLine[];
  readonly placements: readonly SimPlacementLine[];
}

export interface HostPanelReal {
  readonly kind: "real";
  readonly alias: string;
  readonly probe: LiveSection<RecordedProbe | null>;
  readonly registry: LiveSection<readonly RegistryEntry[]>;
  readonly results: LiveSection<
    readonly { at: string; outcome: string; workItemId: string; known: boolean }[]
  >;
  readonly meterCalls: LiveSection<readonly LiveActivityRow[]>;
}

export type HostPanel = HostPanelSim | HostPanelReal;

export interface TaskPanelSim {
  readonly kind: "sim";
  readonly workItemId: string;
  readonly task: SimTask;
  readonly brief: string;
  readonly hostAlias: string | null;
  readonly placedAt: string;
  readonly reason: string;
  readonly eligibleCount: number;
  readonly status: "running" | "ended";
  readonly endedAt: string | null;
}

export interface TaskPanelReal {
  readonly kind: "real";
  readonly workItemId: string;
  readonly workItem: LiveSection<WorkItem>;
  readonly dod: LiveSection<readonly { id: string; text: string; done: boolean }[]>;
  readonly rounds: LiveSection<
    readonly { at: string; outcome: string; model: string; hostAlias: string | null }[]
  >;
  readonly verdicts: LiveSection<readonly AuditVerdict[]>;
  readonly ledger: LiveSection<
    readonly {
      provider: string;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
      requests: number | null;
      source: string;
    }[]
  >;
  readonly ledgerSessions: LiveSection<
    readonly { hostAlias: string; seconds: number; source: string }[]
  >;
  readonly ledgerMeta: LiveSection<{
    result: string;
    retries: number;
    humanInterventions: number;
  } | null>;
}

export type TaskPanel = TaskPanelSim | TaskPanelReal;

export interface CallDetail {
  readonly providerId: string;
  readonly model: string;
  readonly rawModel: string;
  readonly role: string | null;
  readonly hostAlias: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly ms: number;
  readonly cost: LiveCell;
}

export interface CallPanel {
  readonly callId: string;
  readonly endedAt: string;
  readonly workItemId: string | null;
  readonly detail: LiveSection<CallDetail>;
}

export interface AuditPanel {
  readonly workItemId: string;
  readonly headSha: string;
  readonly verdict: LiveSection<AuditVerdict>;
  readonly workItemRepo: string | null;
}

export interface RealWorkCard {
  readonly alias: string;
  readonly stage: "implement" | "audit" | "idle";
  readonly workItemId: string | null;
  readonly title: string | null;
  readonly issue: number | null;
  readonly pullNumber: number | null;
  readonly repo: string | null;
  readonly branch: string | null;
  readonly modelText: string | null;
  readonly providerId: string | null;
  readonly auditorModelText: string | null;
  readonly elapsed: string | null;
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly cost: LiveCell | null;
  // Null when source failed, the reason is in outer LiveSection error/no-data.
  readonly latestCall: {
    readonly at: string;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly ms: number;
    readonly model: string;
  } | null;
  readonly idleReason: string | null;
  readonly probeAt: string | null;
  readonly lastFinished: {
    readonly workItemId: string;
    readonly at: string;
    readonly outcome: string;
  } | null;
  readonly today: { readonly count: number; readonly cost: LiveCell | null } | null;
}

export interface JustFinishedEntry {
  readonly workItemId: string;
  readonly title: string | null;
  readonly hostAlias: string | null;
  readonly verdictCounts:
    { readonly high: number; readonly medium: number; readonly low: number } | "invalid" | null;
  readonly outcome: string;
  readonly cost: LiveCell | null;
  readonly at: string;
  readonly headSha: string | null;
}

export interface LiveModel {
  readonly renderedAt: string;
  readonly simAt: string | null;
  readonly simMinute: number | null;
  readonly durationMinutes: number | null;
  readonly refreshSeconds: number | null;
  readonly nextMinute: number | null;
  readonly counters: readonly LiveCounter[];
  readonly realWork: LiveSection<readonly RealWorkCard[]>;
  readonly justFinished: LiveSection<readonly JustFinishedEntry[]>;
  readonly realFleet: LiveSection<readonly LiveTile[]>;
  readonly simFleet: LiveSection<readonly LiveGroup[]>;
  readonly activity: LiveSection<readonly LiveActivityRow[]>;
  readonly ticker: readonly LiveTickerRow[];
  readonly tickerNote: string | null;
  readonly view: "overview" | "fleet";
  readonly t: number;
  readonly paused: boolean;
  readonly hostPanel: HostPanel | null;
  readonly taskPanel: TaskPanel | null;
  readonly callPanel: CallPanel | null;
  readonly auditPanel: AuditPanel | null;
}

export interface LiveInputs {
  readonly now: Date;
  readonly minute: number;
  readonly dashboard: DashboardInputs;
  readonly sim: LiveSourced<SimTrace>;
  readonly meter: LiveSourced<UsageIndex>;
  readonly probes: LiveSourced<readonly RecordedProbe[]>;
}

export interface LiveOptions {
  readonly view: "overview" | "fleet";
  readonly t: number;
  readonly paused: boolean;
  readonly host: string | null;
  readonly task?: string | null;
  readonly call?: string | null;
  readonly audit?: string | null;
}

export class SimTraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimTraceError";
  }
}

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SIM_STATES: ReadonlySet<string> = new Set([
  "offline",
  "busy",
  "blocked",
  "eligible",
  "running",
]);

const TASK_KINDS = new Set([
  "code",
  "research",
  "data-analysis",
  "report",
  "support",
  "translation",
  "document",
]);

export const TASK_BRIEFS: ReadonlyMap<string, string> = new Map([
  [
    "code",
    "Change the code as the ticket describes, run the project checks, and open a pull request for review.",
  ],
  [
    "research",
    "Read the listed sources, compare the options in a short table, and end with a recommendation.",
  ],
  [
    "data-analysis",
    "Load the dataset, check its quality, compute the requested aggregates, and chart the result.",
  ],
  [
    "support",
    "Read the ticket, classify it, draft the reply from the help-centre articles, and link the article used.",
  ],
  [
    "translation",
    "Translate the strings into the target language, keep placeholders and tone, and flag anything unclear.",
  ],
  [
    "document",
    "Draft the document from the outline and the source notes, in the house template, ready for review.",
  ],
  [
    "report",
    "Collect the figures for the period, compare them with the previous one, and write the summary.",
  ],
]);

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function parseTask(raw: unknown, where: string): SimTask | null {
  if (raw === null) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${where}: invalid "task"`);
  }
  const rec = raw as Record<string, unknown>;
  const allowed = new Set(["kind", "title"]);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) {
      fail(`${where}: invalid "task"`);
    }
  }
  if (!("kind" in rec) || !("title" in rec)) {
    fail(`${where}: invalid "task"`);
  }
  const kind = rec["kind"];
  if (typeof kind !== "string" || !TASK_KINDS.has(kind)) {
    fail(`${where}: invalid "task"`);
  }
  const title = rec["title"];
  if (typeof title !== "string" || title.length < 1 || title.length > 60 || hasControlChar(title)) {
    fail(`${where}: invalid "task"`);
  }
  return { kind, title };
}

function fail(message: string): never {
  throw new SimTraceError(`sim trace: ${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where}: must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function reqString(record: Record<string, unknown>, field: string, where: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${where}: invalid "${field}"`);
  }
  return value;
}

function reqInt(
  record: Record<string, unknown>,
  field: string,
  where: string,
  min: number,
  max: number,
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${where}: invalid "${field}"`);
  }
  return value;
}

function reqBool(record: Record<string, unknown>, field: string, where: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    fail(`${where}: invalid "${field}"`);
  }
  return value;
}

function reqAlias(record: Record<string, unknown>, field: string, where: string): string {
  const value = reqString(record, field, where);
  if (!ALIAS_PATTERN.test(value)) {
    fail(`${where}: invalid "${field}"`);
  }
  return value;
}

function reqIso(record: Record<string, unknown>, field: string, where: string): string {
  const value = reqString(record, field, where);
  if (Number.isNaN(Date.parse(value))) {
    fail(`${where}: invalid "${field}"`);
  }
  return value;
}

function parseHostLine(
  record: Record<string, unknown>,
  where: string,
  duration: number,
): SimHostLine {
  const state = reqString(record, "state", where);
  if (!SIM_STATES.has(state)) {
    fail(`${where}: invalid "state"`);
  }
  const eligible = reqBool(record, "eligible", where);
  const reasonRaw = record["excludeReason"];
  if (reasonRaw !== null && typeof reasonRaw !== "string") {
    fail(`${where}: invalid "excludeReason"`);
  }
  const excludeReason: string | null = reasonRaw;
  if ((excludeReason === null) !== eligible) {
    fail(`${where}: "excludeReason" must be null exactly when eligible`);
  }
  const batteryRaw = record["batteryPercent"];
  if (batteryRaw !== null && (typeof batteryRaw !== "number" || !Number.isInteger(batteryRaw))) {
    fail(`${where}: invalid "batteryPercent"`);
  }
  if (!Object.hasOwn(record, "task")) {
    fail(`${where}: invalid "task"`);
  }
  const task = parseTask(record["task"], where);
  return {
    atMinute: reqInt(record, "atMinute", where, 0, duration),
    at: reqIso(record, "at", where),
    alias: reqAlias(record, "alias", where),
    hostKind: reqString(record, "hostKind", where),
    site: reqString(record, "site", where),
    state: state as SimTileState,
    eligible,
    excludeReason,
    running: reqInt(record, "running", where, 0, 1000000),
    maxAgents: reqInt(record, "maxAgents", where, 1, 1000000),
    batteryPercent: batteryRaw,
    task,
  };
}

// The trace is the simulator's whole output, written atomically, so a line
// that does not parse or validate fails the sim source as sim-trace-invalid.
export function parseSimTrace(text: string): SimTrace {
  const segments = text.split("\n");
  const body = segments[segments.length - 1] === "" ? segments.slice(0, -1) : segments;
  if (body.length === 0) {
    fail("empty");
  }
  const lines: Record<string, unknown>[] = body.map((segment, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment) as unknown;
    } catch {
      fail(`line ${String(index + 1)}: not JSON`);
    }
    return asRecord(parsed, `line ${String(index + 1)}`);
  });
  const header = lines[0] as Record<string, unknown>;
  if (header["kind"] !== "header" || header["schemaVersion"] !== "sim-trace-v1") {
    fail("line 1: not a sim-trace-v1 header");
  }
  const durationMinutes = reqInt(header, "durationMinutes", "header", 0, 1000000);
  const hostCount = reqInt(header, "hostCount", "header", 0, 1000000);
  const speedRaw = header["speed"];
  if (typeof speedRaw !== "number" || !Number.isFinite(speedRaw) || speedRaw <= 0) {
    fail(`header: invalid "speed"`);
  }
  const kindsRaw = header["kinds"];
  if (!Array.isArray(kindsRaw)) {
    fail(`header: invalid "kinds"`);
  }
  const kinds = kindsRaw.map((entry, index) => {
    const record = asRecord(entry, `header kinds ${String(index)}`);
    return {
      kind: reqString(record, "kind", "header kinds"),
      count: reqInt(record, "count", "header kinds", 0, 1000000),
    };
  });
  const hosts: SimHostLine[] = [];
  const events: SimEventLine[] = [];
  const placements: SimPlacementLine[] = [];
  const workEnds: SimWorkEnd[] = [];
  lines.slice(1).forEach((record, offset) => {
    const where = `line ${String(offset + 2)}`;
    if (record["simulated"] !== true) {
      fail(`${where}: missing "simulated": true`);
    }
    switch (record["kind"]) {
      case "host": {
        hosts.push(parseHostLine(record, where, durationMinutes));
        break;
      }
      case "event": {
        events.push({
          atMinute: reqInt(record, "atMinute", where, 0, durationMinutes),
          at: reqIso(record, "at", where),
          alias: reqAlias(record, "alias", where),
          event: reqString(record, "event", where),
          text: reqString(record, "text", where),
        });
        break;
      }
      case "placement": {
        const chosenRaw = record["chosenHostAlias"];
        if (
          chosenRaw !== null &&
          (typeof chosenRaw !== "string" || !ALIAS_PATTERN.test(chosenRaw))
        ) {
          fail(`${where}: invalid "chosenHostAlias"`);
        }
        if (!Object.hasOwn(record, "task")) {
          fail(`${where}: invalid "task"`);
        }
        const task = parseTask(record["task"], where);
        const eligibleCountRaw = record["eligibleCount"];
        if (
          typeof eligibleCountRaw !== "number" ||
          !Number.isInteger(eligibleCountRaw) ||
          eligibleCountRaw < 0
        ) {
          fail(`${where}: invalid "eligibleCount"`);
        }
        const eligibleCount = eligibleCountRaw;
        placements.push({
          atMinute: reqInt(record, "atMinute", where, 0, durationMinutes),
          at: reqIso(record, "at", where),
          workItemId: reqString(record, "workItemId", where),
          chosenHostAlias: chosenRaw,
          reason: reqString(record, "reason", where),
          task,
          eligibleCount,
        });
        break;
      }
      case "work-end": {
        workEnds.push({
          atMinute: reqInt(record, "atMinute", where, 0, durationMinutes),
          at: reqIso(record, "at", where),
          workItemId: reqString(record, "workItemId", where),
        });
        break;
      }
      case "summary": {
        break;
      }
      default: {
        fail(`${where}: unknown kind`);
      }
    }
  });
  const initial = new Set(hosts.filter((host) => host.atMinute === 0).map((host) => host.alias));
  if (initial.size !== hostCount) {
    fail(`header "hostCount" does not match the minute-0 host snapshot`);
  }
  return {
    timeline: reqString(header, "timeline", "header"),
    startAt: reqIso(header, "startAt", "header"),
    speed: speedRaw,
    durationMinutes,
    hostCount,
    kinds,
    hosts,
    events,
    placements,
    workEnds,
  };
}

// Parsed traces are cached per path, keyed by file size and mtime, so a
// refresh of /live never reparses an unchanged trace file.
const traceCache = new Map<string, { size: number; mtimeMs: number; trace: SimTrace }>();

async function readSimInput(
  path: string | null,
  log: (input: string, code: LiveInputCode, message: string) => void,
): Promise<LiveSourced<SimTrace>> {
  if (path === null) {
    return { ok: false, failure: { kind: "no-data", reason: "no simulated input" } };
  }
  try {
    if ((await statInputPath("Sim trace", path)) === "absent") {
      log("sim trace", "sim-trace-unreadable", `sim trace ${path}: file is missing`);
      return { ok: false, failure: { kind: "error", code: "sim-trace-unreadable" } };
    }
    const info = await stat(path);
    const cached = traceCache.get(path);
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return { ok: true, value: cached.trace };
    }
    const trace = parseSimTrace(await readInputText("Sim trace", path));
    traceCache.set(path, { size: info.size, mtimeMs: info.mtimeMs, trace });
    return { ok: true, value: trace };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    const code: LiveInputCode =
      error instanceof SimTraceError ? "sim-trace-invalid" : "sim-trace-unreadable";
    log("sim trace", code, error.message);
    return { ok: false, failure: { kind: "error", code } };
  }
}

async function readMeterInput(
  path: string,
  log: (input: string, code: LiveInputCode, message: string) => void,
): Promise<LiveSourced<UsageIndex>> {
  try {
    return { ok: true, value: await replayUsageLog(path, "read-only", () => {}) };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    const code: LiveInputCode =
      error instanceof MeterLogError ? "meter-usage-invalid" : "meter-usage-unreadable";
    log("meter usage", code, error.message);
    return { ok: false, failure: { kind: "error", code } };
  }
}

async function readProbesInput(
  path: string,
  now: Date,
  log: (input: string, code: LiveInputCode, message: string) => void,
): Promise<LiveSourced<readonly RecordedProbe[]>> {
  try {
    const probes = await readRecordedProbes(path, now);
    if (probes === null) {
      return { ok: false, failure: { kind: "no-data", reason: "no probe recorded" } };
    }
    return { ok: true, value: probes };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    const code: LiveInputCode =
      error instanceof HostStateLogDataError
        ? "host-state-log-invalid"
        : "host-state-log-unreadable";
    log("host state log", code, error.message);
    return { ok: false, failure: { kind: "error", code } };
  }
}

export async function gatherLiveInputs(
  sources: LiveSources,
  dashboard: DashboardInputs,
  minute: number,
  log: (event: { input: string; code: LiveInputCode; message: string }) => void,
): Promise<LiveInputs> {
  const emit = (input: string, code: LiveInputCode, message: string): void => {
    log({ input, code, message });
  };
  const [sim, meter, probes] = await Promise.all([
    readSimInput(sources.simTracePath, emit),
    readMeterInput(sources.meterUsagePath, emit),
    readProbesInput(sources.portsPath, dashboard.now, emit),
  ]);
  return { now: dashboard.now, minute, dashboard, sim, meter, probes };
}

function failureCell(failure: InputFailure): LiveCell {
  return failure.kind === "error"
    ? { kind: "error", code: failure.code }
    : { kind: "no-data", reason: failure.reason };
}

function liveCell<T>(sourced: LiveSourced<T>, text: (value: T) => string): LiveCell {
  return sourced.ok
    ? { kind: "text", text: text(sourced.value) }
    : sourced.failure.kind === "error"
      ? { kind: "error", code: sourced.failure.code }
      : { kind: "no-data", reason: sourced.failure.reason };
}

function sourcedCell<T>(sourced: Sourced<T>, text: (value: T) => string): LiveCell {
  return sourced.ok ? { kind: "text", text: text(sourced.value) } : failureCell(sourced.failure);
}

function section<T>(sourced: LiveSourced<T>): LiveSection<T> {
  if (sourced.ok) {
    return { kind: "ok", value: sourced.value };
  }
  return sourced.failure.kind === "error"
    ? { kind: "error", code: sourced.failure.code }
    : { kind: "no-data", reason: sourced.failure.reason };
}

function simTilesAt(trace: SimTrace, minute: number): SimHostLine[] {
  const latest = new Map<string, SimHostLine>();
  for (const host of trace.hosts) {
    if (host.atMinute <= minute) {
      latest.set(host.alias, host);
    }
  }
  return [...latest.values()].sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
}

function realTiles(
  probes: readonly RecordedProbe[],
  registry: Sourced<readonly RegistryEntry[]>,
): LiveTile[] {
  return probes.map((probe) => ({
    alias: probe.hostAlias,
    hostKind: "real host",
    site: "real fleet",
    simulated: false,
    state: probe.kind === "reported" ? "reported" : "unavailable",
    eligible: probe.kind === "reported",
    flagged: false,
    running: registry.ok ? openSessionCount(registry.value, probe.hostAlias) : null,
    runningError: registry.ok
      ? null
      : registry.failure.kind === "error"
        ? registry.failure.code
        : registry.failure.reason,
    maxAgents: null,
    batteryPercent: null,
    detail:
      probe.kind === "reported"
        ? "last probe: reported"
        : `last probe: unavailable: ${(probe.cause ?? "unknown").replace(/-/g, " ")}`,
  }));
}

export function stripProvider(model: string): string {
  const idx = model.lastIndexOf("/");
  if (idx !== -1) return model.slice(idx + 1);
  return model;
}

function formatElapsed(startedAt: string, now: Date): string | null {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;
  const diffMs = now.getTime() - startMs;
  if (diffMs < 0) return "0 min";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${String(mins)} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rem)}m`;
}

function idleReasonFromProbe(probe: RecordedProbe): string {
  if (probe.kind === "unavailable") {
    if (probe.cause === "plugin-busy") return "person at the desk";
    const label = probe.cause === null ? "unavailable" : probe.cause.replace(/-/g, " ");
    return label;
  }
  return "no work queued";
}

function newestResultForHost(
  results: readonly { at: string; outcome: string; workItemId: string; hostAlias: string | null }[],
  hostAlias: string,
): { at: string; outcome: string; workItemId: string } | null {
  let best: { at: string; outcome: string; workItemId: string } | null = null;
  for (const entry of results) {
    if (entry.hostAlias !== hostAlias) continue;
    if (entry.outcome !== "merged" && entry.outcome !== "parked") continue;
    if (best === null || entry.at > best.at) {
      best = { at: entry.at, outcome: entry.outcome, workItemId: entry.workItemId };
    }
  }
  return best;
}

function sumMeterForWorkItem(
  meter: UsageIndex,
  workItemId: string,
  pricing: Sourced<ReadonlyMap<string, NanoPricing>>,
): {
  tokens: { input: number; output: number } | null;
  cost: LiveCell | null;
  latestCall: RealWorkCard["latestCall"];
} {
  let sumIn = 0;
  let sumOut = 0;
  let scaledIn = 0n;
  let scaledOut = 0n;
  let totalEntries = 0;
  let pricedEntries = 0;
  let missingTokens = false;
  let latest: {
    at: string;
    inputTokens: number | null;
    outputTokens: number | null;
    ms: number;
    model: string;
  } | null = null;
  for (const end of meter.ends.values()) {
    const grant = meter.grants.get(end.requestId)?.open;
    if (grant === undefined || grant.workItemId !== workItemId) continue;
    totalEntries += 1;
    if (latest === null || end.at > latest.at) {
      const start = meter.starts.get(end.callId);
      const rawModel = start?.model ?? grant.model;
      latest = {
        at: end.at,
        inputTokens: end.inputTokens,
        outputTokens: end.outputTokens,
        ms: end.ms,
        model: stripProvider(rawModel),
      };
    }
    if (end.inputTokens === null || end.outputTokens === null) {
      missingTokens = true;
      continue;
    }
    sumIn += end.inputTokens;
    sumOut += end.outputTokens;
    if (pricing.ok) {
      const price = pricing.value.get(grant.providerId);
      if (price !== undefined) {
        pricedEntries += 1;
        scaledIn += tokenCostScaled(end.inputTokens, price.inputNanoPer1M);
        scaledOut += tokenCostScaled(end.outputTokens, price.outputNanoPer1M);
      }
    }
  }
  if (latest === null) return { tokens: null, cost: null, latestCall: null };
  const tokens =
    (totalEntries > 0 && !missingTokens) || sumIn !== 0 || sumOut !== 0
      ? { input: sumIn, output: sumOut }
      : null;
  let cost: LiveCell | null = null;
  if (missingTokens && pricedEntries === 0) {
    cost = { kind: "no-data", reason: "usage not reported" };
  } else if (!pricing.ok) {
    cost = failureCell(pricing.failure);
  } else if (totalEntries > pricedEntries) {
    const unpriced = totalEntries - pricedEntries;
    if (pricedEntries === 0) {
      cost = {
        kind: "no-data",
        reason: `${String(unpriced)} of ${String(totalEntries)} entries unpriced`,
      };
    } else {
      cost = {
        kind: "text",
        text: `at least ${formatUsd(scaledIn + scaledOut)} (${String(unpriced)} of ${String(totalEntries)} entries unpriced)`,
      };
    }
  } else {
    cost = { kind: "text", text: formatUsd(scaledIn + scaledOut) };
  }
  // null tokens when all entries missing tokens
  const finalTokens =
    missingTokens && pricedEntries === 0 && sumIn === 0 && sumOut === 0 ? null : tokens;
  return { tokens: finalTokens, cost, latestCall: latest };
}

function buildJustFinishedSection(inputs: LiveInputs): LiveSection<readonly JustFinishedEntry[]> {
  if (!inputs.dashboard.results.ok) {
    return inputs.dashboard.results.failure.kind === "error"
      ? { kind: "error", code: inputs.dashboard.results.failure.code }
      : { kind: "no-data", reason: inputs.dashboard.results.failure.reason };
  }
  const results = inputs.dashboard.results.value;
  const filtered = results.filter(
    (r) => r.outcome === "merged" || (r.outcome as string) === "parked",
  );
  const sorted = [...filtered].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 3);
  if (sorted.length === 0) return { kind: "ok", value: [] };
  const workById = new Map<string, WorkItem>();
  if (inputs.dashboard.workItems.ok) {
    for (const item of inputs.dashboard.workItems.value) workById.set(item.id, item);
  }
  const entries: JustFinishedEntry[] = sorted.map((row) => {
    const work = workById.get(row.workItemId);
    const title = work?.title ?? row.workItemId;
    let countedVal: JustFinishedEntry["verdictCounts"] = null;
    const verdicts = inputs.dashboard.verdicts.get(row.workItemId);
    if (verdicts !== undefined && verdicts.ok && verdicts.value.length > 0) {
      let chosen: AuditVerdict | null = null;
      chosen = verdicts.value[verdicts.value.length - 1] ?? null;
      if (chosen !== null) {
        const c = verdictCounts(chosen);
        countedVal = c;
      }
    }
    let cost: LiveCell | null;
    if (!inputs.dashboard.ledger.ok) {
      cost =
        inputs.dashboard.ledger.failure.kind === "error"
          ? { kind: "error", code: inputs.dashboard.ledger.failure.code }
          : { kind: "no-data", reason: inputs.dashboard.ledger.failure.reason };
    } else if (!inputs.dashboard.pricing.ok) {
      cost = failureCell(inputs.dashboard.pricing.failure);
    } else {
      const rec = inputs.dashboard.ledger.value.records.find(
        (r) => r.workItemId === row.workItemId,
      );
      if (rec !== undefined) {
        let scaled = 0n;
        const total = rec.tokens.length;
        let priced = 0;
        let hasMissingTokens = false;
        for (const t of rec.tokens) {
          if (t.inputTokens === null || t.outputTokens === null) {
            hasMissingTokens = true;
            continue;
          }
          const price = inputs.dashboard.pricing.value.get(t.provider);
          if (price === undefined) continue;
          priced += 1;
          scaled += tokenCostScaled(t.inputTokens, price.inputNanoPer1M);
          scaled += tokenCostScaled(t.outputTokens, price.outputNanoPer1M);
        }
        if (hasMissingTokens && priced === 0 && total > 0) {
          cost = { kind: "no-data", reason: "usage not reported" };
        } else if (total > priced) {
          const unpriced = total - priced;
          if (priced === 0) {
            cost = {
              kind: "no-data",
              reason: `${String(unpriced)} of ${String(total)} entries unpriced`,
            };
          } else {
            cost = {
              kind: "text",
              text: `at least ${formatUsd(scaled)} (${String(unpriced)} of ${String(total)} entries unpriced)`,
            };
          }
        } else {
          cost = { kind: "text", text: formatUsd(scaled) };
        }
      } else {
        cost = { kind: "no-data", reason: "not in ledger yet" };
      }
    }
    let headSha: string | null = null;
    if (verdicts !== undefined && verdicts.ok && verdicts.value.length > 0) {
      const latestVerdict = verdicts.value[verdicts.value.length - 1];
      if (latestVerdict !== undefined) headSha = latestVerdict.headSha;
    }
    return {
      workItemId: row.workItemId,
      title,
      hostAlias: row.hostAlias,
      verdictCounts: countedVal,
      outcome: row.outcome,
      cost,
      at: row.at,
      headSha,
    };
  });
  return { kind: "ok", value: entries };
}

function buildRealWorkSection(inputs: LiveInputs): LiveSection<readonly RealWorkCard[]> {
  if (!inputs.probes.ok) {
    return inputs.probes.failure.kind === "error"
      ? { kind: "error", code: inputs.probes.failure.code }
      : { kind: "no-data", reason: inputs.probes.failure.reason };
  }
  if (!inputs.dashboard.registry.ok) {
    return inputs.dashboard.registry.failure.kind === "error"
      ? { kind: "error", code: inputs.dashboard.registry.failure.code }
      : { kind: "no-data", reason: inputs.dashboard.registry.failure.reason };
  }
  const probes = inputs.probes.value;
  const aliasSet = new Set<string>(probes.map((p) => p.hostAlias));
  for (const entry of inputs.dashboard.registry.value) {
    if (entry.terminal === null) aliasSet.add(entry.hostAlias);
  }
  const aliases = [...aliasSet].sort();
  if (aliases.length === 0) return { kind: "ok", value: [] };
  const probeByAlias = new Map<string, RecordedProbe>(probes.map((p) => [p.hostAlias, p] as const));
  const openByAlias = new Map<string, RegistryEntry>();
  for (const entry of inputs.dashboard.registry.value) {
    if (entry.terminal !== null) continue;
    const prev = openByAlias.get(entry.hostAlias);
    if (prev === undefined || entry.startedAt > prev.startedAt)
      openByAlias.set(entry.hostAlias, entry);
  }
  const workById = new Map<string, WorkItem>();
  if (inputs.dashboard.workItems.ok) {
    for (const item of inputs.dashboard.workItems.value) workById.set(item.id, item);
  }
  // results sorted newest first per host for lastFinished
  const resultsOk = inputs.dashboard.results.ok ? inputs.dashboard.results.value : [];
  // Map workItemId -> newest result for stage inference
  const newestResultByWorkItem = new Map<string, (typeof resultsOk)[number]>();
  for (const row of resultsOk) {
    const prev = newestResultByWorkItem.get(row.workItemId);
    if (prev === undefined || row.at > prev.at) newestResultByWorkItem.set(row.workItemId, row);
  }
  const ledgerRecords = inputs.dashboard.ledger.ok ? inputs.dashboard.ledger.value.records : [];
  const utcDay = inputs.now.toISOString().slice(0, 10);
  const cards: RealWorkCard[] = aliases.map((alias) => {
    const probe = probeByAlias.get(alias) ?? null;
    const registryEntry = openByAlias.get(alias) ?? null;
    const probeAt = probe?.at ?? null;
    const lastFinished = newestResultForHost(resultsOk, alias);
    // today stats
    let todayCount = 0;
    let todayScaled = 0n;
    let todayHasPriced = false;
    if (inputs.dashboard.ledger.ok && inputs.dashboard.pricing.ok) {
      for (const rec of ledgerRecords) {
        if (rec.finishedAt.slice(0, 10) !== utcDay) continue;
        if (!rec.sessionSeconds.some((s) => s.hostAlias === alias)) continue;
        todayCount += 1;
        for (const t of rec.tokens) {
          if (t.inputTokens === null || t.outputTokens === null) continue;
          const price = inputs.dashboard.pricing.value.get(t.provider);
          if (price === undefined) continue;
          todayHasPriced = true;
          todayScaled += tokenCostScaled(t.inputTokens, price.inputNanoPer1M);
          todayScaled += tokenCostScaled(t.outputTokens, price.outputNanoPer1M);
        }
      }
    }
    let today: RealWorkCard["today"] = null;
    if (inputs.dashboard.ledger.ok) {
      let cost: LiveCell | null = null;
      if (todayCount === 0) {
        cost = null;
      } else if (!inputs.dashboard.pricing.ok) cost = failureCell(inputs.dashboard.pricing.failure);
      else if (todayScaled === 0n && !todayHasPriced) cost = null;
      else cost = { kind: "text", text: formatUsd(todayScaled) };
      if (todayCount > 0 || probe !== null) today = { count: todayCount, cost };
      else if (probe !== null) today = { count: 0, cost: null };
    } else if (!inputs.dashboard.ledger.ok) {
      const failure = inputs.dashboard.ledger.failure;
      const err: LiveCell =
        failure.kind === "error"
          ? { kind: "error", code: failure.code }
          : { kind: "no-data", reason: failure.reason };
      today = { count: 0, cost: err };
    }
    if (registryEntry !== null) {
      const work = workById.get(registryEntry.workItemId) ?? null;
      // stage: open session => implement, unless newest result for this workItem is merged? But merged while session open should not happen; keep implement.
      const stage: RealWorkCard["stage"] = "implement";
      // model text = provider/model stripped? Show model + provider in (provider)
      const modelText = stripProvider(registryEntry.model.model);
      const providerId = registryEntry.model.providerId;
      const auditorModelText: string | null = null;
      const latest = inputs.meter.ok
        ? sumMeterForWorkItem(
            inputs.meter.value,
            registryEntry.workItemId,
            inputs.dashboard.pricing,
          )
        : { tokens: null, cost: null, latestCall: null };
      const costCell: typeof latest.cost = !inputs.meter.ok
        ? inputs.meter.failure.kind === "error"
          ? { kind: "error", code: inputs.meter.failure.code }
          : { kind: "no-data", reason: inputs.meter.failure.reason }
        : latest.cost;
      return {
        alias,
        stage,
        workItemId: registryEntry.workItemId,
        title: work?.title ?? registryEntry.workItemId,
        issue: work?.issue ?? null,
        pullNumber: work?.pullNumber ?? null,
        repo: work?.repo ?? null,
        branch: work?.branch ?? null,
        modelText,
        providerId,
        auditorModelText,
        elapsed: formatElapsed(registryEntry.startedAt, inputs.now),
        tokens: latest.tokens,
        cost: costCell,
        latestCall: latest.latestCall,
        idleReason: null,
        probeAt,
        lastFinished:
          lastFinished !== null
            ? {
                workItemId: lastFinished.workItemId,
                at: lastFinished.at,
                outcome: lastFinished.outcome,
              }
            : null,
        today,
      };
    }
    // No open session: check for pending audit work on this host.
    // The pending audit is the newest non-merged result for the host whose verdict is still missing.
    // A merged result is considered finished and the host becomes idle with lastFinished info.
    {
      // Look for a pending audit result on this host: newest result with outcome != merged and no verdict yet.
      let pending: (typeof resultsOk)[number] | null = null;
      for (const row of resultsOk) {
        if (row.hostAlias !== alias) continue;
        if (row.outcome === "merged") continue;
        if (row.outcome === "start-rejected") continue;
        if (pending === null || row.at > pending.at) pending = row;
      }
      if (pending !== null) {
        const verdicts = inputs.dashboard.verdicts.get(pending.workItemId);
        const hasVerdict = verdicts !== undefined && verdicts.ok && verdicts.value.length > 0;
        if (!hasVerdict) {
          const wid = pending.workItemId;
          const work = workById.get(wid) ?? null;
          const newest = newestResultByWorkItem.get(wid);
          const modelEntry = newest?.model ? stripProvider(newest.model) : null;
          const providerId = newest?.providerId ?? null;
          const auditorModelText: string | null = null;
          // Auditor known from verdict store only when verdict exists; pending audit has none.
          const meterInfo = inputs.meter.ok
            ? sumMeterForWorkItem(inputs.meter.value, wid, inputs.dashboard.pricing)
            : { tokens: null, cost: null, latestCall: null };
          const costCell: typeof meterInfo.cost = !inputs.meter.ok
            ? inputs.meter.failure.kind === "error"
              ? { kind: "error", code: inputs.meter.failure.code }
              : { kind: "no-data", reason: inputs.meter.failure.reason }
            : meterInfo.cost;
          return {
            alias,
            stage: "audit" as const,
            workItemId: wid,
            title: work?.title ?? wid,
            issue: work?.issue ?? null,
            pullNumber: work?.pullNumber ?? null,
            repo: work?.repo ?? null,
            branch: work?.branch ?? null,
            modelText: modelEntry,
            providerId,
            auditorModelText,
            elapsed: null,
            tokens: meterInfo.tokens,
            cost: costCell,
            latestCall: null,
            idleReason: null,
            probeAt,
            lastFinished:
              lastFinished !== null
                ? {
                    workItemId: lastFinished.workItemId,
                    at: lastFinished.at,
                    outcome: lastFinished.outcome,
                  }
                : null,
            today,
          };
        }
      }
    }
    // Idle: no running work, no recent finished host work
    return {
      alias,
      stage: "idle",
      workItemId: null,
      title: null,
      issue: null,
      pullNumber: null,
      repo: null,
      branch: null,
      modelText: null,
      providerId: null,
      auditorModelText: null,
      elapsed: null,
      tokens: null,
      cost: null,
      latestCall: null,
      idleReason: probe !== null ? idleReasonFromProbe(probe) : null,
      probeAt,
      lastFinished,
      today,
    };
  });
  return { kind: "ok", value: cards };
}

function activityRows(
  meter: UsageIndex,
  pricing: Sourced<ReadonlyMap<string, NanoPricing>>,
): LiveActivityRow[] {
  const ends = [...meter.ends.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return ends.slice(0, 12).map((end) => {
    const start = meter.starts.get(end.callId);
    const grant = meter.grants.get(end.requestId)?.open;
    const providerId = start?.providerId ?? grant?.providerId ?? "unknown";
    const rawModel = start?.model ?? grant?.model ?? "unknown";
    const model = stripProvider(rawModel);
    let cost: LiveCell;
    if (end.inputTokens === null || end.outputTokens === null) {
      cost = { kind: "no-data", reason: "usage not reported" };
    } else if (!pricing.ok) {
      cost = failureCell(pricing.failure);
    } else {
      const price = pricing.value.get(providerId);
      cost =
        price === undefined
          ? { kind: "no-data", reason: "no price found" }
          : {
              kind: "text",
              text: formatUsd(
                tokenCostScaled(end.inputTokens, price.inputNanoPer1M) +
                  tokenCostScaled(end.outputTokens, price.outputNanoPer1M),
              ),
            };
    }
    return {
      at: end.at,
      model,
      providerId,
      role: "session",
      workItemId: grant?.workItemId ?? null,
      hostAlias: grant?.hostAlias ?? null,
      inputTokens: end.inputTokens,
      outputTokens: end.outputTokens,
      ms: end.ms,
      cost,
    };
  });
}

function tickerRows(inputs: LiveInputs, minute: number, simOk: SimTrace | null): LiveTickerRow[] {
  const rows: LiveTickerRow[] = [];
  if (inputs.dashboard.results.ok) {
    const real = [...inputs.dashboard.results.value]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, 8);
    for (const line of real) {
      rows.push({
        at: line.at,
        simulated: false,
        text:
          line.outcome === "merged"
            ? `merged ${line.workItemId} on ${line.hostAlias ?? "no host"}`
            : `round ${line.outcome} for ${line.workItemId}`,
      });
    }
  }
  if (simOk !== null) {
    const simRows: LiveTickerRow[] = [];
    for (const event of simOk.events) {
      if (event.atMinute <= minute) {
        simRows.push({ at: event.at, simulated: true, text: event.text });
      }
    }
    for (const placement of simOk.placements) {
      if (placement.atMinute <= minute && placement.chosenHostAlias !== null) {
        const text =
          placement.task !== null
            ? `${placement.task.kind}: ${placement.task.title} placed on ${placement.chosenHostAlias} because ${placement.reason}`
            : `placed ${placement.workItemId} on ${placement.chosenHostAlias} because ${placement.reason}`;
        simRows.push({
          at: placement.at,
          simulated: true,
          text,
        });
      }
    }
    simRows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    rows.push(...simRows.slice(0, 8));
  }
  rows.sort((a, b) => {
    if (a.at !== b.at) {
      return a.at < b.at ? 1 : -1;
    }
    return Number(a.simulated) - Number(b.simulated);
  });
  return rows.slice(0, 16);
}

function buildHostPanel(
  inputs: LiveInputs,
  minute: number,
  sim: SimTrace | null,
  hostAlias: string,
): HostPanel | null {
  // Try simulated first.
  if (sim !== null) {
    const hostLine = simTilesAt(sim, minute).find((host) => host.alias === hostAlias);
    if (hostLine !== undefined) {
      const events = sim.events
        .filter((event) => event.alias === hostAlias && event.atMinute <= minute)
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, 6);
      const placements = sim.placements
        .filter(
          (placement) => placement.chosenHostAlias === hostAlias && placement.atMinute <= minute,
        )
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, 6);
      const workEndById = new Map<string, number>();
      for (const end of sim.workEnds) {
        if (end.atMinute <= minute) {
          const prev = workEndById.get(end.workItemId);
          if (prev === undefined || end.atMinute < prev)
            workEndById.set(end.workItemId, end.atMinute);
        }
      }
      const allHostPlacements = sim.placements.filter(
        (p) => p.chosenHostAlias === hostAlias && p.atMinute <= minute,
      );
      const runningTasks = allHostPlacements
        .filter((p) => !workEndById.has(p.workItemId))
        .map((p) => ({ workItemId: p.workItemId, at: p.at }));
      return {
        kind: "sim",
        alias: hostLine.alias,
        site: hostLine.site,
        hostKind: hostLine.hostKind,
        state: hostLine.state,
        eligible: hostLine.eligible,
        excludeReason: hostLine.excludeReason,
        batteryPercent: hostLine.batteryPercent,
        running: hostLine.running,
        maxAgents: hostLine.maxAgents,
        task: hostLine.task,
        runningTasks,
        events,
        placements,
      };
    }
  }
  // A real panel exists when the probes, registry, results or meter usage name the alias; each block degrades on its own source.
  const probeSection: LiveSection<RecordedProbe | null> = inputs.probes.ok
    ? { kind: "ok", value: inputs.probes.value.find((p) => p.hostAlias === hostAlias) ?? null }
    : inputs.probes.failure.kind === "error"
      ? { kind: "error", code: inputs.probes.failure.code }
      : { kind: "no-data", reason: inputs.probes.failure.reason };
  // Registry block: open sessions on this host
  const registrySection: LiveSection<readonly RegistryEntry[]> = inputs.dashboard.registry.ok
    ? {
        kind: "ok",
        value: inputs.dashboard.registry.value.filter(
          (entry: RegistryEntry) => entry.hostAlias === hostAlias && entry.terminal === null,
        ),
      }
    : inputs.dashboard.registry.failure.kind === "error"
      ? { kind: "error", code: inputs.dashboard.registry.failure.code }
      : { kind: "no-data", reason: inputs.dashboard.registry.failure.reason };
  const knownWorkIds = new Set<string>(
    inputs.dashboard.workItems.ok ? inputs.dashboard.workItems.value.map((w) => w.id) : [],
  );
  const resultsSection: LiveSection<
    readonly { at: string; outcome: string; workItemId: string; known: boolean }[]
  > = inputs.dashboard.results.ok
    ? {
        kind: "ok",
        value: inputs.dashboard.results.value
          .filter((line) => line.hostAlias === hostAlias)
          .map((line) => ({
            at: line.at,
            outcome: line.outcome,
            workItemId: line.workItemId,
            known: knownWorkIds.has(line.workItemId),
          }))
          .sort((a, b) => (a.at < b.at ? 1 : -1))
          .slice(0, 6),
      }
    : inputs.dashboard.results.failure.kind === "error"
      ? { kind: "error", code: inputs.dashboard.results.failure.code }
      : { kind: "no-data", reason: inputs.dashboard.results.failure.reason };
  const meterSection: LiveSection<readonly LiveActivityRow[]> = inputs.meter.ok
    ? {
        kind: "ok",
        value: activityRows(inputs.meter.value, inputs.dashboard.pricing)
          .filter((row) => row.hostAlias === hostAlias)
          .slice(0, 6),
      }
    : inputs.meter.failure.kind === "error"
      ? { kind: "error", code: inputs.meter.failure.code }
      : { kind: "no-data", reason: inputs.meter.failure.reason };
  const probeFound = probeSection.kind === "ok" && probeSection.value !== null;
  const anyRegistryHost =
    inputs.dashboard.registry.ok &&
    inputs.dashboard.registry.value.some((e) => e.hostAlias === hostAlias);
  const anyResultsHost =
    inputs.dashboard.results.ok &&
    inputs.dashboard.results.value.some((l) => l.hostAlias === hostAlias);
  const anyMeterHost = (() => {
    if (!inputs.meter.ok) return false;
    const meter = inputs.meter.value;
    return [...meter.ends.values()].some((end) => {
      const grant = meter.grants.get(end.requestId)?.open;
      return grant?.hostAlias === hostAlias;
    });
  })();
  if (!probeFound && !anyRegistryHost && !anyResultsHost && !anyMeterHost) {
    return null;
  }
  return {
    kind: "real",
    alias: hostAlias,
    probe: probeSection,
    registry: registrySection,
    results: resultsSection,
    meterCalls: meterSection,
  };
}

function buildTaskPanelSim(
  inputs: LiveInputs,
  minute: number,
  sim: SimTrace,
  workItemId: string,
): TaskPanelSim | null {
  const placement = sim.placements.find((p) => p.workItemId === workItemId && p.atMinute <= minute);
  if (placement === undefined || placement.task === null) {
    return null;
  }
  const brief = TASK_BRIEFS.get(placement.task.kind) ?? "";
  const ended = sim.workEnds.find((end) => end.workItemId === workItemId && end.atMinute <= minute);
  const status: "running" | "ended" = ended !== undefined ? "ended" : "running";
  const endedAt = ended?.at ?? null;
  return {
    kind: "sim",
    workItemId,
    task: placement.task,
    brief,
    hostAlias: placement.chosenHostAlias,
    placedAt: placement.at,
    reason: placement.reason,
    eligibleCount: placement.eligibleCount,
    status,
    endedAt,
  };
}

function buildTaskPanelReal(inputs: LiveInputs, workItemId: string): TaskPanelReal | null {
  const workItemSectionNullable: LiveSection<WorkItem> | null = (() => {
    if (!inputs.dashboard.workItems.ok) {
      return inputs.dashboard.workItems.failure.kind === "error"
        ? { kind: "error", code: inputs.dashboard.workItems.failure.code }
        : { kind: "no-data", reason: inputs.dashboard.workItems.failure.reason };
    }
    const found = inputs.dashboard.workItems.value.find((w) => w.id === workItemId);
    if (found === undefined) return null;
    return { kind: "ok", value: found };
  })();
  if (workItemSectionNullable === null) return null;
  const workItemSection: LiveSection<WorkItem> = workItemSectionNullable;
  const dodSection: LiveSection<readonly { id: string; text: string; done: boolean }[]> = (() => {
    if (workItemSection.kind !== "ok")
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      return workItemSection as unknown as LiveSection<
        readonly { id: string; text: string; done: boolean }[]
      >;
    return { kind: "ok", value: workItemSection.value.dod };
  })();
  const resultsSection: LiveSection<
    readonly { at: string; outcome: string; model: string; hostAlias: string | null }[]
  > = (() => {
    if (!inputs.dashboard.results.ok) {
      return inputs.dashboard.results.failure.kind === "error"
        ? { kind: "error", code: inputs.dashboard.results.failure.code }
        : { kind: "no-data", reason: inputs.dashboard.results.failure.reason };
    }
    const filtered = inputs.dashboard.results.value
      .filter((l) => l.workItemId === workItemId)
      .map((l) => ({
        at: l.at,
        outcome: l.outcome,
        model: stripProvider(l.model),
        hostAlias: l.hostAlias,
      }))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    return { kind: "ok", value: filtered };
  })();
  const verdictsSection: LiveSection<readonly AuditVerdict[]> = (() => {
    const entry = inputs.dashboard.verdicts.get(workItemId);
    if (entry === undefined) {
      return { kind: "no-data", reason: "no verdict store" };
    }
    if (!entry.ok) {
      return entry.failure.kind === "error"
        ? { kind: "error", code: entry.failure.code }
        : { kind: "no-data", reason: entry.failure.reason };
    }
    return { kind: "ok", value: entry.value };
  })();
  const ledgerTokensSection: LiveSection<
    readonly {
      provider: string;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
      requests: number | null;
      source: string;
    }[]
  > = (() => {
    if (!inputs.dashboard.ledger.ok) {
      return inputs.dashboard.ledger.failure.kind === "error"
        ? { kind: "error", code: inputs.dashboard.ledger.failure.code }
        : { kind: "no-data", reason: inputs.dashboard.ledger.failure.reason };
    }
    const rec = inputs.dashboard.ledger.value.records.find((r) => r.workItemId === workItemId);
    if (rec === undefined) {
      // No record; pending entries may still carry usage.
      const pend = inputs.dashboard.ledger.value.pending.filter((p) => p.workItemId === workItemId);
      if (pend.length > 0) {
        const tokens = pend.flatMap((p) =>
          p.tokens.map((t) => ({
            provider: t.provider,
            model: stripProvider(t.model),
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            requests: t.requests,
            source: t.source,
          })),
        );
        return { kind: "ok", value: tokens };
      }
      return { kind: "ok", value: [] };
    }
    const tokens = rec.tokens.map((t) => ({
      provider: t.provider,
      model: stripProvider(t.model),
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      requests: t.requests,
      source: t.source,
    }));
    return { kind: "ok", value: tokens };
  })();
  const ledgerSessionsSection: LiveSection<
    readonly { hostAlias: string; seconds: number; source: string }[]
  > = (() => {
    if (!inputs.dashboard.ledger.ok) {
      return inputs.dashboard.ledger.failure.kind === "error"
        ? { kind: "error", code: inputs.dashboard.ledger.failure.code }
        : { kind: "no-data", reason: inputs.dashboard.ledger.failure.reason };
    }
    const rec = inputs.dashboard.ledger.value.records.find((r) => r.workItemId === workItemId);
    if (rec === undefined) {
      const pend = inputs.dashboard.ledger.value.pending.filter(
        (p) => p.workItemId === workItemId && p.session !== null,
      );
      if (pend.length > 0) {
        const sessions = pend
          .filter((p) => p.session !== null)
          .map((p) => {
            const s = p.session as NonNullable<typeof p.session>;
            return { hostAlias: s.hostAlias, seconds: s.seconds, source: s.source };
          });
        return { kind: "ok", value: sessions };
      }
      return { kind: "ok", value: [] };
    }
    return { kind: "ok", value: rec.sessionSeconds };
  })();
  const ledgerMetaSection: LiveSection<{
    result: string;
    retries: number;
    humanInterventions: number;
  } | null> = (() => {
    if (!inputs.dashboard.ledger.ok) {
      return inputs.dashboard.ledger.failure.kind === "error"
        ? { kind: "error", code: inputs.dashboard.ledger.failure.code }
        : { kind: "no-data", reason: inputs.dashboard.ledger.failure.reason };
    }
    const rec = inputs.dashboard.ledger.value.records.find((r) => r.workItemId === workItemId);
    if (rec === undefined) return { kind: "ok", value: null };
    return {
      kind: "ok",
      value: {
        result: rec.result,
        retries: rec.retries,
        humanInterventions: rec.humanInterventions,
      },
    };
  })();
  return {
    kind: "real",
    workItemId,
    workItem: workItemSection,
    dod: dodSection,
    rounds: resultsSection,
    verdicts: verdictsSection,
    ledger: ledgerTokensSection,
    ledgerSessions: ledgerSessionsSection,
    ledgerMeta: ledgerMetaSection,
  };
}

function buildTaskPanel(
  inputs: LiveInputs,
  minute: number,
  sim: SimTrace | null,
  workItemId: string,
): TaskPanel | null {
  if (sim !== null) {
    const simPanel = buildTaskPanelSim(inputs, minute, sim, workItemId);
    if (simPanel !== null) return simPanel;
  }
  const realPanel = buildTaskPanelReal(inputs, workItemId);
  if (realPanel !== null) return realPanel;
  return null;
}

function isKnownWorkItemId(inputs: LiveInputs, workItemId: string): boolean {
  if (inputs.dashboard.workItems.ok) {
    if (inputs.dashboard.workItems.value.some((w) => w.id === workItemId)) return true;
  }
  if (inputs.meter.ok) {
    for (const grant of inputs.meter.value.grants.values()) {
      if (grant.open.workItemId === workItemId) return true;
    }
    for (const end of inputs.meter.value.ends.values()) {
      const g = inputs.meter.value.grants.get(end.requestId);
      if (g !== undefined && g.open.workItemId === workItemId) return true;
    }
  }
  if (inputs.dashboard.results.ok) {
    if (inputs.dashboard.results.value.some((r) => r.workItemId === workItemId)) return true;
  }
  const sim = inputs.sim.ok ? inputs.sim.value : null;
  if (sim !== null) {
    if (sim.placements.some((p) => p.workItemId === workItemId)) return true;
    if (sim.workEnds.some((e) => e.workItemId === workItemId)) return true;
  }
  return false;
}

function buildCallPanel(inputs: LiveInputs, callKey: string): CallPanel | null {
  const sep = callKey.indexOf("|");
  if (sep === -1) return null;
  const endedAt = callKey.slice(0, sep);
  const workItemId = callKey.slice(sep + 1);
  if (endedAt === "" || workItemId === "") return null;
  if (!isKnownWorkItemId(inputs, workItemId)) return null;
  if (!inputs.meter.ok) {
    const detail: LiveSection<CallDetail> =
      inputs.meter.failure.kind === "error"
        ? { kind: "error", code: inputs.meter.failure.code }
        : { kind: "no-data", reason: inputs.meter.failure.reason };
    return {
      callId: callKey,
      endedAt,
      workItemId,
      detail,
    };
  }
  // Find matching call-end by at and workItemId via grant
  for (const end of inputs.meter.value.ends.values()) {
    if (end.at !== endedAt) continue;
    const grant = inputs.meter.value.grants.get(end.requestId)?.open;
    if (grant === undefined) continue;
    if (grant.workItemId !== workItemId) continue;
    const start = inputs.meter.value.starts.get(end.callId);
    const providerId = start?.providerId ?? grant.providerId;
    const rawModel = start?.model ?? grant.model;
    const model = stripProvider(rawModel);
    let cost: LiveCell;
    if (end.inputTokens === null || end.outputTokens === null) {
      cost = { kind: "no-data", reason: "usage not reported" };
    } else if (!inputs.dashboard.pricing.ok) {
      cost =
        inputs.dashboard.pricing.failure.kind === "error"
          ? { kind: "error", code: inputs.dashboard.pricing.failure.code }
          : { kind: "no-data", reason: inputs.dashboard.pricing.failure.reason };
    } else {
      const price = inputs.dashboard.pricing.value.get(providerId);
      cost =
        price === undefined
          ? { kind: "no-data", reason: "no price found" }
          : {
              kind: "text",
              text: formatUsd(
                tokenCostScaled(end.inputTokens, price.inputNanoPer1M) +
                  tokenCostScaled(end.outputTokens, price.outputNanoPer1M),
              ),
            };
    }
    const detail: LiveSection<CallDetail> = {
      kind: "ok",
      value: {
        providerId,
        model,
        rawModel,
        role: "session",
        hostAlias: grant.hostAlias,
        inputTokens: end.inputTokens,
        outputTokens: end.outputTokens,
        ms: end.ms,
        cost,
      },
    };
    return {
      callId: end.callId,
      endedAt: end.at,
      workItemId: grant.workItemId,
      detail,
    };
  }
  return null;
}

function buildAuditPanel(inputs: LiveInputs, auditKey: string): AuditPanel | null {
  const sep = auditKey.indexOf("@");
  if (sep === -1) return null;
  const workItemId = auditKey.slice(0, sep);
  const headSha = auditKey.slice(sep + 1);
  const entry = inputs.dashboard.verdicts.get(workItemId);
  if (entry === undefined) {
    // No verdict store entry for this id.
    return null;
  }
  // Determine work item repo for PR link equality check (Fix2).
  let workItemRepo: string | null = null;
  if (inputs.dashboard.workItems.ok) {
    const w = inputs.dashboard.workItems.value.find((item) => item.id === workItemId);
    if (w !== undefined) workItemRepo = w.repo;
  }
  if (!entry.ok) {
    return {
      workItemId,
      headSha,
      workItemRepo,
      verdict:
        entry.failure.kind === "error"
          ? { kind: "error", code: entry.failure.code }
          : { kind: "no-data", reason: entry.failure.reason },
    };
  }
  const found = entry.value.find((v) => v.headSha === headSha);
  if (found === undefined) return null;
  return { workItemId, headSha, workItemRepo, verdict: { kind: "ok", value: found } };
}

export function buildLive(inputs: LiveInputs, opts?: LiveOptions): LiveModel {
  const nowIso = inputs.now.toISOString();
  const utcDay = nowIso.slice(0, 10);
  const sim = inputs.sim.ok ? inputs.sim.value : null;
  const minute = inputs.minute;
  const tiles = sim === null ? [] : simTilesAt(sim, minute);
  const nextMinute =
    sim !== null && minute < sim.durationMinutes ? minute + LIVE_STEP_MINUTES : null;
  const refreshSeconds =
    nextMinute === null || sim === null
      ? null
      : Math.min(30, Math.max(2, Math.ceil((LIVE_STEP_MINUTES * 60) / sim.speed)));
  const counters: LiveCounter[] = [
    {
      label: "Real hosts reporting",
      simulated: false,
      cell: liveCell(inputs.probes, (probes) =>
        probes.length === 0
          ? "0"
          : `${groupDigits(probes.filter((probe) => probe.kind === "reported").length)} of ${groupDigits(probes.length)}`,
      ),
    },
    {
      label: "Sessions running",
      simulated: false,
      cell: sourcedCell(inputs.dashboard.registry, (entries) =>
        groupDigits(entries.filter((entry) => entry.terminal === null).length),
      ),
    },
    {
      label: "Meter calls today",
      simulated: false,
      cell: liveCell(inputs.meter, (index) =>
        groupDigits(
          [...index.ends.values()].filter((end) => end.at.slice(0, 10) === utcDay).length,
        ),
      ),
    },
    {
      label: "Simulated hosts eligible",
      simulated: true,
      cell:
        sim === null
          ? liveCell(inputs.sim, () => "")
          : {
              kind: "text",
              text: `${groupDigits(tiles.filter((tile) => tile.eligible).length)} of ${groupDigits(sim.hostCount)}`,
            },
    },
    {
      label: "Simulated work running",
      simulated: true,
      cell:
        sim === null
          ? liveCell(inputs.sim, () => "")
          : { kind: "text", text: groupDigits(tiles.reduce((sum, tile) => sum + tile.running, 0)) },
    },
    {
      label: "Simulated placements",
      simulated: true,
      cell:
        sim === null
          ? liveCell(inputs.sim, () => "")
          : {
              kind: "text",
              text: groupDigits(
                sim.placements.filter(
                  (placement) => placement.atMinute <= minute && placement.chosenHostAlias !== null,
                ).length,
              ),
            },
    },
  ];
  const realWork: LiveSection<readonly RealWorkCard[]> = buildRealWorkSection(inputs);
  const justFinished: LiveSection<readonly JustFinishedEntry[]> = buildJustFinishedSection(inputs);
  const simFleet: LiveSection<readonly LiveGroup[]> = !inputs.sim.ok
    ? section(inputs.sim)
    : (() => {
        const groups = new Map<string, LiveTile[]>();
        for (const host of tiles) {
          const title = `${host.site} - ${host.hostKind}`;
          const baseDetail =
            host.excludeReason ??
            (host.state === "offline"
              ? "left the site network"
              : host.state === "busy"
                ? "user present"
                : "");
          let detail = baseDetail;
          if (host.state === "running" && host.task !== null) {
            const taskLabel = `${host.task.kind}: ${host.task.title}`;
            detail = baseDetail === "" ? taskLabel : `${taskLabel} - ${baseDetail}`;
          }
          const tile: LiveTile = {
            alias: host.alias,
            hostKind: host.hostKind,
            site: host.site,
            simulated: true,
            state: host.state,
            eligible: host.eligible,
            flagged:
              host.running > 0 &&
              !host.eligible &&
              !(host.excludeReason?.startsWith(AGENT_LIMIT_REASON_PREFIX) ?? false),
            running: host.running,
            runningError: null,
            maxAgents: host.maxAgents,
            batteryPercent: host.batteryPercent,
            detail,
          };
          const list = groups.get(title);
          if (list === undefined) {
            groups.set(title, [tile]);
          } else {
            list.push(tile);
          }
        }
        return {
          kind: "ok" as const,
          value: [...groups.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([title, groupTiles]) => ({
              title: `${title} (${String(groupTiles.length)})`,
              tiles: groupTiles,
            })),
        };
      })();
  let hostPanel: HostPanel | null = null;
  let taskPanel: TaskPanel | null = null;
  let callPanel: CallPanel | null = null;
  let auditPanel: AuditPanel | null = null;
  const rawHost = opts?.host ?? null;
  const rawTask = opts?.task ?? null;
  const rawCall = opts?.call ?? null;
  const rawAudit = opts?.audit ?? null;
  if (rawHost !== null) {
    hostPanel = buildHostPanel(inputs, minute, sim, rawHost);
  } else if (rawTask !== null) {
    taskPanel = buildTaskPanel(inputs, minute, sim, rawTask);
  } else if (rawCall !== null) {
    callPanel = buildCallPanel(inputs, rawCall);
  } else if (rawAudit !== null) {
    auditPanel = buildAuditPanel(inputs, rawAudit);
  }
  return {
    renderedAt: nowIso,
    simAt: sim === null ? null : new Date(Date.parse(sim.startAt) + minute * 60000).toISOString(),
    simMinute: sim === null ? null : minute,
    durationMinutes: sim === null ? null : sim.durationMinutes,
    refreshSeconds,
    nextMinute,
    counters,
    realWork,
    justFinished,
    realFleet: !inputs.probes.ok
      ? section(inputs.probes)
      : { kind: "ok", value: realTiles(inputs.probes.value, inputs.dashboard.registry) },
    simFleet,
    activity: !inputs.meter.ok
      ? section(inputs.meter)
      : { kind: "ok", value: activityRows(inputs.meter.value, inputs.dashboard.pricing) },
    ticker: tickerRows(inputs, minute, sim),
    tickerNote: inputs.dashboard.results.ok
      ? null
      : `real events: ${inputs.dashboard.results.failure.kind === "error" ? `error (${inputs.dashboard.results.failure.code})` : `no data (${inputs.dashboard.results.failure.reason})`}`,
    view: opts?.view ?? "overview",
    t: opts?.t ?? minute,
    paused: opts?.paused ?? false,
    hostPanel,
    taskPanel,
    callPanel,
    auditPanel,
  };
}

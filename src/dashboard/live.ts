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
  readonly running: number;
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

export interface LiveModel {
  readonly renderedAt: string;
  readonly simAt: string | null;
  readonly simMinute: number | null;
  readonly durationMinutes: number | null;
  readonly refreshSeconds: number | null;
  readonly nextMinute: number | null;
  readonly counters: readonly LiveCounter[];
  readonly realFleet: LiveSection<readonly LiveTile[]>;
  readonly simFleet: LiveSection<readonly LiveGroup[]>;
  readonly activity: LiveSection<readonly LiveActivityRow[]>;
  readonly ticker: readonly LiveTickerRow[];
  readonly tickerNote: string | null;
}

export interface LiveInputs {
  readonly now: Date;
  readonly minute: number;
  readonly dashboard: DashboardInputs;
  readonly sim: LiveSourced<SimTrace>;
  readonly meter: LiveSourced<UsageIndex>;
  readonly probes: LiveSourced<readonly RecordedProbe[]>;
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

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) {
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
  const task = parseTask(record["task"] ?? null, where);
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
        const task = parseTask(record["task"] ?? null, where);
        placements.push({
          atMinute: reqInt(record, "atMinute", where, 0, durationMinutes),
          at: reqIso(record, "at", where),
          workItemId: reqString(record, "workItemId", where),
          chosenHostAlias: chosenRaw,
          reason: reqString(record, "reason", where),
          task,
        });
        break;
      }
      case "work-end":
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
    running: registry.ok ? openSessionCount(registry.value, probe.hostAlias) : 0,
    maxAgents: null,
    batteryPercent: null,
    detail:
      probe.kind === "reported"
        ? "last probe: reported"
        : `last probe: unavailable: ${(probe.cause ?? "unknown").replace(/-/g, " ")}`,
  }));
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
    const model = start?.model ?? grant?.model ?? "unknown";
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
      role: grant === undefined ? null : "session",
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

export function buildLive(inputs: LiveInputs): LiveModel {
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
  return {
    renderedAt: nowIso,
    simAt: sim === null ? null : new Date(Date.parse(sim.startAt) + minute * 60000).toISOString(),
    simMinute: sim === null ? null : minute,
    durationMinutes: sim === null ? null : sim.durationMinutes,
    refreshSeconds,
    nextMinute,
    counters,
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
  };
}

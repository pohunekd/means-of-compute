/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-assignment */
// Timeline loader for sim-v1. Strict validation, no silent defaults.
import { readInputText, statInputPath } from "../fs/input.js";

export type EventType =
  | "leave"
  | "return"
  | "depart"
  | "rejoin"
  | "window-enter"
  | "window-exit"
  | "battery"
  | "unplug"
  | "plug-in";

const EVENT_TYPES: readonly EventType[] = [
  "leave",
  "return",
  "depart",
  "rejoin",
  "window-enter",
  "window-exit",
  "battery",
  "unplug",
  "plug-in",
];

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const KIND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const HHMM_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface KindDef {
  readonly cores: number;
  readonly memoryTotalMb: number;
  readonly gpuPresent: boolean;
  readonly battery: "none" | "laptop";
  readonly maxConcurrentAgents: number;
  readonly allowedWindow: { readonly start: string; readonly end: string };
  readonly startsIdle: boolean;
  readonly initialInsideWindow: boolean;
}

export interface GeneratorDef {
  readonly kind: string;
  readonly count: number;
  readonly aliasPrefix: string;
  readonly site: string;
}

export interface WaveDef {
  readonly atMinute: number;
  readonly kind: string;
  readonly type: EventType;
  readonly fraction: number;
  readonly staggerMinutes: number;
}

export interface EventDef {
  readonly atMinute: number;
  readonly alias: string;
  readonly type: EventType;
  readonly set?: Readonly<Record<string, unknown>>;
}

export interface WorkDef {
  readonly firstAtMinute: number;
  readonly everyMinutes: number;
  readonly count: number;
  readonly durationMinutes: number;
  readonly idPrefix: string;
}

export interface Timeline {
  readonly schemaVersion: "sim-v1";
  readonly name: string;
  readonly seed: number;
  readonly startAt: string;
  readonly durationMinutes: number;
  readonly speed: number;
  readonly kinds: Readonly<Record<string, KindDef>>;
  readonly generators: readonly GeneratorDef[];
  readonly waves: readonly WaveDef[];
  readonly events: readonly EventDef[];
  readonly work: readonly WorkDef[];
}

const TOP_KEYS = new Set([
  "schemaVersion",
  "name",
  "seed",
  "startAt",
  "durationMinutes",
  "speed",
  "kinds",
  "generators",
  "waves",
  "events",
  "work",
]);

const KIND_KEYS = new Set([
  "cores",
  "memoryTotalMb",
  "gpuPresent",
  "battery",
  "maxConcurrentAgents",
  "allowedWindow",
  "startsIdle",
]);

const WINDOW_KEYS = new Set(["start", "end"]);
const GENERATOR_KEYS = new Set(["kind", "count", "aliasPrefix", "site"]);
const WAVE_KEYS = new Set(["atMinute", "kind", "type", "fraction", "staggerMinutes"]);
const EVENT_KEYS = new Set(["atMinute", "alias", "type", "set"]);
const EVENT_KEYS_NO_SET = new Set(["atMinute", "alias", "type"]);
const WORK_KEYS = new Set([
  "firstAtMinute",
  "everyMinutes",
  "count",
  "durationMinutes",
  "idPrefix",
]);

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  fieldPath: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`Timeline ${fieldPath}: unexpected key "${key}"`);
    }
  }
  for (const key of allowed) {
    if (!(key in record)) {
      throw new Error(`Timeline ${fieldPath}: missing required field "${key}"`);
    }
  }
}

function assertExactKeysOptionalSet(record: Record<string, unknown>, fieldPath: string): void {
  const allowed = record["set"] === undefined ? EVENT_KEYS_NO_SET : EVENT_KEYS;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`Timeline ${fieldPath}: unexpected key "${key}"`);
    }
  }
  for (const key of allowed) {
    if (key === "set" && record["set"] === undefined) {
      continue;
    }
    if (!(key in record)) {
      throw new Error(`Timeline ${fieldPath}: missing required field "${key}"`);
    }
  }
}

function isInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

function parseMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function insideWindowFromStartAt(startAt: string, start: string, end: string): boolean {
  const d = new Date(startAt);
  const nowM = d.getUTCHours() * 60 + d.getUTCMinutes();
  const startM = parseMinutes(start);
  const endM = parseMinutes(end);
  if (startM === endM) {
    return true;
  }
  if (startM <= endM) {
    return nowM >= startM && nowM < endM;
  }
  return nowM >= startM || nowM < endM;
}

function validateAllowedWindow(value: unknown, fieldPath: string): { start: string; end: string } {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Timeline ${fieldPath}: must be an object`);
  }
  const rec = value as Record<string, unknown>;
  assertExactKeys(rec, WINDOW_KEYS, fieldPath);
  const start = rec["start"];
  const end = rec["end"];
  if (typeof start !== "string" || !HHMM_PATTERN.test(start)) {
    throw new Error(`Timeline ${fieldPath}.start: must be HH:MM`);
  }
  if (typeof end !== "string" || !HHMM_PATTERN.test(end)) {
    throw new Error(`Timeline ${fieldPath}.end: must be HH:MM`);
  }
  return { start, end };
}

function validateKinds(raw: unknown, startAt: string): Record<string, KindDef> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Timeline kinds: must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const kinds: Record<string, KindDef> = {};
  for (const [kindName, kindValue] of Object.entries(record)) {
    if (!KIND_NAME_PATTERN.test(kindName)) {
      throw new Error(`Timeline kinds.${kindName}: invalid kind name`);
    }
    if (typeof kindValue !== "object" || kindValue === null) {
      throw new Error(`Timeline kinds.${kindName}: must be an object`);
    }
    const rec = kindValue as Record<string, unknown>;
    assertExactKeys(rec, KIND_KEYS, `kinds.${kindName}`);
    const cores = rec["cores"];
    const memoryTotalMb = rec["memoryTotalMb"];
    const gpuPresent = rec["gpuPresent"];
    const battery = rec["battery"];
    const maxConcurrentAgents = rec["maxConcurrentAgents"];
    const allowedWindow = rec["allowedWindow"];
    const startsIdle = rec["startsIdle"];
    if (!isInteger(cores) || (cores as number) < 1) {
      throw new Error(`Timeline kinds.${kindName}.cores: must be integer >=1`);
    }
    if (!isInteger(memoryTotalMb) || (memoryTotalMb as number) < 1) {
      throw new Error(`Timeline kinds.${kindName}.memoryTotalMb: must be integer >=1`);
    }
    if (typeof gpuPresent !== "boolean") {
      throw new Error(`Timeline kinds.${kindName}.gpuPresent: must be boolean`);
    }
    if (battery !== "none" && battery !== "laptop") {
      throw new Error(`Timeline kinds.${kindName}.battery: must be "none" or "laptop"`);
    }
    if (!isInteger(maxConcurrentAgents) || (maxConcurrentAgents as number) < 1) {
      throw new Error(`Timeline kinds.${kindName}.maxConcurrentAgents: must be integer >=1`);
    }
    const window = validateAllowedWindow(allowedWindow, `kinds.${kindName}.allowedWindow`);
    if (typeof startsIdle !== "boolean") {
      throw new Error(`Timeline kinds.${kindName}.startsIdle: must be boolean`);
    }
    const initialInsideWindow = insideWindowFromStartAt(startAt, window.start, window.end);
    kinds[kindName] = {
      cores: cores as number,
      memoryTotalMb: memoryTotalMb as number,
      gpuPresent: gpuPresent as boolean,
      battery: battery as "none" | "laptop",
      maxConcurrentAgents: maxConcurrentAgents as number,
      allowedWindow: window,
      startsIdle: startsIdle as boolean,
      initialInsideWindow,
    };
  }
  if (Object.keys(kinds).length === 0) {
    throw new Error(`Timeline kinds: must have at least one kind`);
  }
  return kinds;
}

function validateGenerators(raw: unknown, kinds: Record<string, KindDef>): GeneratorDef[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Timeline generators: must be an array`);
  }
  const out: GeneratorDef[] = [];
  const aliasPrefixCounts = new Map<string, number>();
  const allAliases = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Timeline generators[${String(i)}]: must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    assertExactKeys(rec, GENERATOR_KEYS, `generators[${String(i)}]`);
    const kind = rec["kind"];
    const count = rec["count"];
    const aliasPrefix = rec["aliasPrefix"];
    const site = rec["site"];
    if (typeof kind !== "string" || !Object.hasOwn(kinds, kind)) {
      throw new Error(`Timeline generators[${String(i)}].kind: unknown kind "${String(kind)}"`);
    }
    if (!isInteger(count) || (count as number) < 1) {
      throw new Error(`Timeline generators[${String(i)}].count: must be integer >=1`);
    }
    if (typeof aliasPrefix !== "string" || aliasPrefix.length === 0) {
      throw new Error(`Timeline generators[${String(i)}].aliasPrefix: must be non-empty string`);
    }
    const startIndex = aliasPrefixCounts.get(aliasPrefix) ?? 1;
    const countNum = count as number;
    for (let n = 0; n < countNum; n += 1) {
      const suffix = String(startIndex + n).padStart(3, "0");
      const alias = `${aliasPrefix}${suffix}`;
      if (!ALIAS_PATTERN.test(alias)) {
        throw new Error(
          `Timeline generators[${String(i)}].aliasPrefix: alias "${alias}" does not match pattern`,
        );
      }
      if (allAliases.has(alias)) {
        throw new Error(`Timeline generators[${String(i)}]: duplicate alias "${alias}"`);
      }
      allAliases.add(alias);
    }
    aliasPrefixCounts.set(aliasPrefix, startIndex + countNum);
    if (typeof site !== "string" || site.length === 0) {
      throw new Error(`Timeline generators[${String(i)}].site: must be non-empty string`);
    }
    out.push({
      kind: kind as string,
      count: count as number,
      aliasPrefix: aliasPrefix as string,
      site: site as string,
    });
  }
  return out;
}

function validateWaves(
  raw: unknown,
  kinds: Record<string, KindDef>,
  generators: readonly GeneratorDef[],
  durationMinutes: number,
): WaveDef[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Timeline waves: must be an array`);
  }
  const kindCounts = new Map<string, number>();
  for (const g of generators) {
    kindCounts.set(g.kind, (kindCounts.get(g.kind) ?? 0) + g.count);
  }
  const pointerByKind = new Map<string, number>();
  const departByKind = new Map<string, number>();
  const out: WaveDef[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Timeline waves[${String(i)}]: must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    assertExactKeys(rec, WAVE_KEYS, `waves[${String(i)}]`);
    const atMinute = rec["atMinute"];
    const kind = rec["kind"];
    const type = rec["type"];
    const fraction = rec["fraction"];
    const staggerMinutes = rec["staggerMinutes"];
    if (
      !isInteger(atMinute) ||
      (atMinute as number) < 0 ||
      (atMinute as number) > durationMinutes
    ) {
      throw new Error(`Timeline waves[${String(i)}].atMinute: must be integer 0..durationMinutes`);
    }
    if (typeof kind !== "string" || !Object.hasOwn(kinds, kind)) {
      throw new Error(`Timeline waves[${String(i)}].kind: unknown kind`);
    }
    if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) {
      throw new Error(
        `Timeline waves[${String(i)}].type: must be one of ${EVENT_TYPES.join(", ")}`,
      );
    }
    if ((type as string) === "battery") {
      throw new Error(
        `Timeline waves[${String(i)}].type: battery needs a per-host batteryPercent; use an event`,
      );
    }
    if (
      typeof fraction !== "number" ||
      !Number.isFinite(fraction) ||
      fraction < 0 ||
      fraction > 1
    ) {
      throw new Error(`Timeline waves[${String(i)}].fraction: must be number 0..1`);
    }
    if (!isInteger(staggerMinutes) || (staggerMinutes as number) < 0) {
      throw new Error(`Timeline waves[${String(i)}].staggerMinutes: must be integer >=0`);
    }
    const kindStr = kind as string;
    const count = Math.ceil((fraction as number) * (kindCounts.get(kindStr) ?? 0));
    if (type === "rejoin") {
      const departSize = departByKind.get(kindStr);
      if (departSize === undefined) {
        throw new Error(
          `Timeline waves[${String(i)}].type: rejoin needs an earlier depart of kind ${kindStr}`,
        );
      }
      const lastMinute =
        (atMinute as number) + Math.max(0, departSize - 1) * (staggerMinutes as number);
      if (lastMinute > durationMinutes) {
        throw new Error(
          `Timeline waves[${String(i)}].staggerMinutes: wave runs past durationMinutes`,
        );
      }
    } else {
      const lastMinute = (atMinute as number) + Math.max(0, count - 1) * (staggerMinutes as number);
      if (lastMinute > durationMinutes) {
        throw new Error(
          `Timeline waves[${String(i)}].staggerMinutes: wave runs past durationMinutes`,
        );
      }
    }
    if (type === "rejoin") {
      // no pointer advance for rejoin
    } else if (type === "depart") {
      const pointer = pointerByKind.get(kindStr) ?? 0;
      if (pointer + count > (kindCounts.get(kindStr) ?? 0)) {
        throw new Error(
          `Timeline waves[${String(i)}].fraction: wave would wrap and re-select hosts`,
        );
      }
      pointerByKind.set(kindStr, pointer + count);
      departByKind.set(kindStr, count);
    } else {
      const pointer = pointerByKind.get(kindStr) ?? 0;
      if (pointer + count > (kindCounts.get(kindStr) ?? 0)) {
        throw new Error(
          `Timeline waves[${String(i)}].fraction: wave would wrap and re-select hosts`,
        );
      }
      pointerByKind.set(kindStr, pointer + count);
    }
    out.push({
      atMinute: atMinute as number,
      kind: kindStr,
      type: type as EventType,
      fraction: fraction as number,
      staggerMinutes: staggerMinutes as number,
    });
  }
  return out;
}

function validateSetForType(
  type: EventType,
  setValue: unknown,
  fieldPath: string,
): Record<string, unknown> | undefined {
  if (type === "rejoin") {
    if (typeof setValue !== "object" || setValue === null) {
      throw new Error(`Timeline ${fieldPath}.set: rejoin requires set with acPower`);
    }
    const rec = setValue as Record<string, unknown>;
    const allowed = new Set(["acPower", "batteryPercent"]);
    for (const k of Object.keys(rec)) {
      if (!allowed.has(k)) {
        throw new Error(`Timeline ${fieldPath}.set: unexpected key "${k}"`);
      }
    }
    if (!("acPower" in rec)) {
      throw new Error(`Timeline ${fieldPath}.set: rejoin requires acPower`);
    }
    if (typeof rec["acPower"] !== "boolean") {
      throw new Error(`Timeline ${fieldPath}.set.acPower: must be boolean`);
    }
    if ("batteryPercent" in rec) {
      const bp = rec["batteryPercent"];
      if (!isInteger(bp) || (bp as number) < 0 || (bp as number) > 100) {
        throw new Error(`Timeline ${fieldPath}.set.batteryPercent: must be integer 0..100`);
      }
    }
    return rec;
  }
  if (type === "battery") {
    if (typeof setValue !== "object" || setValue === null) {
      throw new Error(`Timeline ${fieldPath}.set: battery requires set with batteryPercent`);
    }
    const rec = setValue as Record<string, unknown>;
    if (Object.keys(rec).length !== 1 || !("batteryPercent" in rec)) {
      throw new Error(`Timeline ${fieldPath}.set: battery requires exactly batteryPercent`);
    }
    const bp = rec["batteryPercent"];
    if (!isInteger(bp) || (bp as number) < 0 || (bp as number) > 100) {
      throw new Error(`Timeline ${fieldPath}.set.batteryPercent: must be integer 0..100`);
    }
    return rec;
  }
  return undefined;
}

function validateEvents(
  raw: unknown,
  allAliases: Set<string>,
  aliasToKind: Map<string, string>,
  kinds: Record<string, KindDef>,
  durationMinutes: number,
): EventDef[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Timeline events: must be an array`);
  }
  const out: EventDef[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Timeline events[${String(i)}]: must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    assertExactKeysOptionalSet(rec, `events[${String(i)}]`);
    const atMinute = rec["atMinute"];
    const alias = rec["alias"];
    const type = rec["type"];
    const setValue = rec["set"];
    if (
      !isInteger(atMinute) ||
      (atMinute as number) < 0 ||
      (atMinute as number) > durationMinutes
    ) {
      throw new Error(`Timeline events[${String(i)}].atMinute: must be integer 0..durationMinutes`);
    }
    if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias)) {
      throw new Error(`Timeline events[${String(i)}].alias: invalid alias`);
    }
    if (!allAliases.has(alias as string)) {
      throw new Error(`Timeline events[${String(i)}].alias: unknown alias "${alias as string}"`);
    }
    if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) {
      throw new Error(
        `Timeline events[${String(i)}].type: must be one of ${EVENT_TYPES.join(", ")}`,
      );
    }
    const eventType = type as EventType;
    const kindName = aliasToKind.get(alias as string);
    const kindDef = kindName !== undefined ? kinds[kindName] : undefined;
    if (
      (eventType === "battery" || eventType === "unplug" || eventType === "plug-in") &&
      kindDef?.battery === "none"
    ) {
      throw new Error(`Timeline events[${String(i)}].type: ${eventType} on battery:none kind`);
    }
    if (setValue !== undefined) {
      if (eventType !== "rejoin" && eventType !== "battery") {
        throw new Error(
          `Timeline events[${String(i)}].set: set allowed only on rejoin and battery`,
        );
      }
      const validated = validateSetForType(eventType, setValue, `events[${String(i)}]`);
      out.push({
        atMinute: atMinute as number,
        alias: alias as string,
        type: eventType,
        set: validated,
      });
    } else {
      if (eventType === "battery") {
        throw new Error(
          `Timeline events[${String(i)}].set: battery requires set with batteryPercent`,
        );
      }
      if (eventType === "rejoin") {
        throw new Error(`Timeline events[${String(i)}].set: rejoin requires set with acPower`);
      }
      out.push({ atMinute: atMinute as number, alias: alias as string, type: eventType });
    }
  }
  return out;
}

function validateWork(raw: unknown, durationMinutes: number): readonly WorkDef[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Timeline work: must be an array of one or more blocks`);
  }
  if (raw.length === 0) {
    throw new Error(`Timeline work: must have at least one block`);
  }
  const seenPrefix = new Set<string>();
  const out: WorkDef[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Timeline work[${String(i)}]: must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    assertExactKeys(rec, WORK_KEYS, `work[${String(i)}]`);
    const firstAtMinute = rec["firstAtMinute"];
    const everyMinutes = rec["everyMinutes"];
    const count = rec["count"];
    const duration = rec["durationMinutes"];
    const idPrefix = rec["idPrefix"];
    if (!isInteger(firstAtMinute) || (firstAtMinute as number) < 0) {
      throw new Error(`Timeline work[${String(i)}].firstAtMinute: must be integer >=0`);
    }
    if (!isInteger(everyMinutes) || (everyMinutes as number) < 1) {
      throw new Error(`Timeline work[${String(i)}].everyMinutes: must be integer >=1`);
    }
    if (!isInteger(count) || (count as number) < 1) {
      throw new Error(`Timeline work[${String(i)}].count: must be integer >=1`);
    }
    if (!isInteger(duration) || (duration as number) < 1) {
      throw new Error(`Timeline work[${String(i)}].durationMinutes: must be integer >=1`);
    }
    if (typeof idPrefix !== "string" || idPrefix.length === 0) {
      throw new Error(`Timeline work[${String(i)}].idPrefix: must be non-empty string`);
    }
    const prefixStr = idPrefix as string;
    if (seenPrefix.has(prefixStr)) {
      throw new Error(`Timeline work: duplicate idPrefix "${prefixStr}"`);
    }
    seenPrefix.add(prefixStr);
    const lastAt = (firstAtMinute as number) + ((count as number) - 1) * (everyMinutes as number);
    if (lastAt > durationMinutes) {
      throw new Error(`Timeline work[${String(i)}].firstAtMinute: work runs past durationMinutes`);
    }
    out.push({
      firstAtMinute: firstAtMinute as number,
      everyMinutes: everyMinutes as number,
      count: count as number,
      durationMinutes: duration as number,
      idPrefix: prefixStr,
    });
  }
  return out;
}

function expandAliases(generators: readonly GeneratorDef[]): {
  aliases: Set<string>;
  aliasToKind: Map<string, string>;
} {
  const counts = new Map<string, number>();
  const aliases = new Set<string>();
  const aliasToKind = new Map<string, string>();
  for (const gen of generators) {
    const start = counts.get(gen.aliasPrefix) ?? 1;
    for (let n = 0; n < gen.count; n += 1) {
      const suffix = String(start + n).padStart(3, "0");
      const alias = `${gen.aliasPrefix}${suffix}`;
      aliases.add(alias);
      aliasToKind.set(alias, gen.kind);
    }
    counts.set(gen.aliasPrefix, start + gen.count);
  }
  return { aliases, aliasToKind };
}

export async function loadTimeline(path: string): Promise<Timeline> {
  const label = "Timeline";
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Timeline ${path}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Timeline ${path}: must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  assertExactKeys(record, TOP_KEYS, "");
  const schemaVersion = record["schemaVersion"];
  if (schemaVersion !== "sim-v1") {
    throw new Error(`Timeline schemaVersion: must be "sim-v1"`);
  }
  const name = record["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Timeline name: must be non-empty string`);
  }
  const seed = record["seed"];
  if (!isInteger(seed) || (seed as number) < 0) {
    throw new Error(`Timeline seed: must be integer >=0`);
  }
  const startAt = record["startAt"];
  if (typeof startAt !== "string") {
    throw new Error(`Timeline startAt: must be ISO-8601 UTC`);
  }
  const d = new Date(startAt);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== startAt) {
    throw new Error(`Timeline startAt: must be ISO-8601 UTC, round-trips through Date`);
  }
  if (!startAt.endsWith("Z")) {
    throw new Error(`Timeline startAt: must end with Z`);
  }
  const durationMinutes = record["durationMinutes"];
  if (
    !isInteger(durationMinutes) ||
    (durationMinutes as number) < 1 ||
    (durationMinutes as number) > 1440
  ) {
    throw new Error(`Timeline durationMinutes: must be integer 1..1440`);
  }
  const speed = record["speed"];
  if (typeof speed !== "number" || !Number.isFinite(speed) || (speed as number) <= 0) {
    throw new Error(`Timeline speed: must be number >0`);
  }
  const kinds = validateKinds(record["kinds"], startAt as string);
  const generators = validateGenerators(record["generators"], kinds);
  const waves = validateWaves(record["waves"], kinds, generators, durationMinutes as number);
  const { aliases, aliasToKind } = expandAliases(generators);
  const events = validateEvents(
    record["events"],
    aliases,
    aliasToKind,
    kinds,
    durationMinutes as number,
  );
  const work = validateWork(record["work"], durationMinutes as number);

  return {
    schemaVersion: "sim-v1",
    name: name as string,
    seed: seed as number,
    startAt: startAt as string,
    durationMinutes: durationMinutes as number,
    speed: speed as number,
    kinds,
    generators,
    waves,
    events,
    work,
  };
}

// Facts loading and validation for the host probe. The --facts and
// --scenario files go through the same strict check: the schema rejects
// wrong types and unknown keys, then code predicates cover what JSON
// Schema cannot (a real calendar date, the sysfs root on Linux).
import Ajv from "ajv/dist/2020";
import factsSchema from "./facts.schema.json" with { type: "json" };
import { assertSysfsRoot, readJson } from "./config.js";

export class FactsError extends Error {}

export type Facts = Partial<{
  secondsSinceInput: number;
  // Simulates a failed user-activity reader: the probe reports activity as
  // unknown (never idle) with this cause instead of reading live input state.
  userActivityError: string;
  // Simulates a host where the login query ran and found no local session
  // of class user (remote sessions excluded): idle when on AC, battery above
  // threshold, inside the window. Requires an explicit secondsSinceInput
  // fact (combine the two in every scenario); without it the probe exits 1.
  // A failed query is userActivityError instead (never idle). The live
  // manager hint failure fallback (/proc/uptime) is covered by the loginctl
  // test double, not by a fact.
  noLocalUserSession: boolean;
  // Fixture override for every sysfs path (power_supply, drm): a scenario
  // may point it at a committed fixture tree, as an absolute path.
  sysfsRoot: string;
  acPower: boolean;
  batteryPercent: number | null;
  cpuCores: number;
  cpuLoad1m: number;
  memoryTotalMb: number;
  memoryFreeMb: number;
  gpuPresent: boolean;
  gpuName: string | null;
  gpuFreeMb: number | null;
  localModelsReachable: boolean;
  localModels: string[];
  hostAlias: string;
  timestamp: string;
  policyAllowedWindowStart: string;
  policyAllowedWindowEnd: string;
}>;

const ajv = new Ajv({ strict: true });
const validateFacts = ajv.compile(factsSchema);

function firstFailureKey(value: Record<string, unknown>): string {
  const errors = validateFacts.errors ?? [];
  for (const error of errors) {
    if (error.keyword === "additionalProperties" && typeof error.params === "object") {
      const extra = (error.params as { additionalProperty?: unknown }).additionalProperty;
      if (typeof extra === "string") return extra;
    }
    if (typeof error.instancePath === "string" && error.instancePath.startsWith("/")) {
      return error.instancePath.slice(1);
    }
  }
  return Object.keys(value)[0] ?? "facts";
}

function failureReason(): string {
  const errors = validateFacts.errors ?? [];
  const first = errors[0];
  if (first?.keyword === "additionalProperties") return "unknown key";
  if (first?.message) return first.message;
  return "invalid value";
}

export function validateFactsValue(
  value: unknown,
  rawPath: string | undefined,
): asserts value is Facts {
  const path = rawPath ?? "facts";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FactsError(`facts ${path}: facts: not an object`);
  }
  const record = value as Record<string, unknown>;
  if (!validateFacts(record)) {
    const key = firstFailureKey(record);
    if (key === "noLocalUserSession") {
      throw new FactsError(`facts ${path}: noLocalUserSession: must be true or absent`);
    }
    throw new FactsError(`facts ${path}: ${key}: ${failureReason()}`);
  }
  const timestamp = record["timestamp"];
  if (typeof timestamp === "string") {
    if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
      throw new FactsError(`facts ${path}: timestamp: not a real calendar date`);
    }
  }
  // The config root is asserted in loadConfig on Linux; a facts override
  // gets the same rule with the matching label.
  if (record["sysfsRoot"] !== undefined && process.platform === "linux") {
    const label = `facts ${path}: invalid sysfsRoot`;
    try {
      assertSysfsRoot(record["sysfsRoot"], label);
    } catch (e) {
      const detail = e instanceof Error ? e.message.split(": ").slice(-1)[0] : String(e);
      throw new FactsError(`facts ${path}: sysfsRoot: ${detail ?? "invalid"}`, { cause: e });
    }
  }
}

export function loadFacts(path: string): Facts {
  const value = readJson<unknown>(path);
  validateFactsValue(value, path);
  return value;
}

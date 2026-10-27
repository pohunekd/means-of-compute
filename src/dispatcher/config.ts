// Typed loader for config/dispatcher.json. Every key is required and no
// extra key is allowed: a missing file or a failed validation is a startup
// error naming the key (exit 2 at the CLI). Tunable values live here, never
// as literals in the dispatcher.
import { readInputText, statInputPath } from "../fs/input.js";

export interface DispatcherConfig {
  readonly baseBranch: string;
  readonly branchPrefix: string;
  readonly waitTimeoutMs: number;
  readonly lostAfterUnreachable: number;
  readonly unreachableBackoffMs: number;
  readonly registryPath: string;
}

const DEFAULT_CONFIG_PATH = "config/dispatcher.json";
const REQUIRED_KEYS = [
  "baseBranch",
  "branchPrefix",
  "waitTimeoutMs",
  "lostAfterUnreachable",
  "unreachableBackoffMs",
  "registryPath",
] as const;

const BASE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const BRANCH_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*\/$/;

function requiredBaseBranch(record: Record<string, unknown>, path: string): string {
  const value = record["baseBranch"];
  if (
    typeof value !== "string" ||
    !BASE_BRANCH_PATTERN.test(value) ||
    value.includes("..") ||
    value.includes("//")
  ) {
    throw new Error(`Dispatcher config ${path}: invalid required key "baseBranch"`);
  }
  return value;
}

function requiredBranchPrefix(record: Record<string, unknown>, path: string): string {
  const value = record["branchPrefix"];
  if (typeof value !== "string" || !BRANCH_PREFIX_PATTERN.test(value)) {
    throw new Error(`Dispatcher config ${path}: invalid required key "branchPrefix"`);
  }
  return value;
}

function requiredInteger(
  record: Record<string, unknown>,
  field: string,
  path: string,
  min: number,
  max: number,
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Dispatcher config ${path}: invalid required key "${field}"`);
  }
  return value;
}

function requiredRegistryPath(record: Record<string, unknown>, path: string): string {
  const value = record["registryPath"];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Dispatcher config ${path}: invalid required key "registryPath"`);
  }
  return value;
}

export async function loadDispatcherConfig(
  path: string = DEFAULT_CONFIG_PATH,
): Promise<DispatcherConfig> {
  const label = "Dispatcher config";
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Dispatcher config ${path}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Dispatcher config ${path}: must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Dispatcher config ${path}: unexpected key "${key}"`);
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) {
      throw new Error(`Dispatcher config ${path}: missing required key "${key}"`);
    }
  }
  return {
    baseBranch: requiredBaseBranch(record, path),
    branchPrefix: requiredBranchPrefix(record, path),
    waitTimeoutMs: requiredInteger(record, "waitTimeoutMs", path, 1, 3600000),
    lostAfterUnreachable: requiredInteger(record, "lostAfterUnreachable", path, 1, 100),
    unreachableBackoffMs: requiredInteger(record, "unreachableBackoffMs", path, 0, 600000),
    registryPath: requiredRegistryPath(record, path),
  };
}

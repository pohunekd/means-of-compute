// Typed loader for config/work.json. Every key is required and no extra
// key is allowed: a missing file or a failed validation names the key.
import { readInputText, statInputPath } from "../fs/input.js";

export interface WorkConfig {
  readonly storePath: string;
  readonly factorySpecsPath: string;
  readonly models: readonly string[];
  readonly maxItemsPerSubmit: number;
  readonly maxItemBytes: number;
  readonly maxStoreItems: number;
}

export const WORK_CONFIG_PATH = "config/work.json";
const REQUIRED_KEYS = [
  "storePath",
  "factorySpecsPath",
  "models",
  "maxItemsPerSubmit",
  "maxItemBytes",
  "maxStoreItems",
] as const;

function requiredPath(record: Record<string, unknown>, path: string, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Work config ${path}: invalid required key "${key}"`);
  }
  return value;
}

function requiredInteger(
  record: Record<string, unknown>,
  path: string,
  key: string,
  min: number,
  max: number,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Work config ${path}: invalid required key "${key}"`);
  }
  return value;
}

export async function loadWorkConfig(path: string = WORK_CONFIG_PATH): Promise<WorkConfig> {
  const label = "Work config";
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} ${path}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} ${path}: must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${label} ${path}: unexpected key "${key}"`);
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) {
      throw new Error(`${label} ${path}: missing required key "${key}"`);
    }
  }
  const models = record["models"];
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    !models.every((entry) => typeof entry === "string" && entry.length > 0) ||
    new Set(models).size !== models.length
  ) {
    throw new Error(`${label} ${path}: invalid required key "models"`);
  }
  return {
    storePath: requiredPath(record, path, "storePath"),
    factorySpecsPath: requiredPath(record, path, "factorySpecsPath"),
    models: [...(models as string[])],
    maxItemsPerSubmit: requiredInteger(record, path, "maxItemsPerSubmit", 1, 500),
    maxItemBytes: requiredInteger(record, path, "maxItemBytes", 1024, 1048576),
    maxStoreItems: requiredInteger(record, path, "maxStoreItems", 1, 100000),
  };
}

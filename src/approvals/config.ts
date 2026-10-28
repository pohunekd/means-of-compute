// Typed loader for config/approvals.json. Every key is required and no
// extra key is allowed: a missing file or a failed validation names the key.
import { readInputText, statInputPath } from "../fs/input.js";

export interface ApprovalsConfig {
  readonly requestsPath: string;
  readonly operators: readonly string[];
  readonly maxPendingRequests: number;
  readonly maxReasonChars: number;
}

export const APPROVALS_CONFIG_PATH = "config/approvals.json";

const REQUIRED_KEYS = [
  "requestsPath",
  "operators",
  "maxPendingRequests",
  "maxReasonChars",
] as const;

const OPERATOR_PATTERN = /^[a-z][a-z0-9-]{0,38}$/;

function requiredPath(record: Record<string, unknown>, path: string, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Approvals config ${path}: invalid required key "${key}"`);
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
    throw new Error(`Approvals config ${path}: invalid required key "${key}"`);
  }
  return value;
}

export async function loadApprovalsConfig(
  path: string = APPROVALS_CONFIG_PATH,
): Promise<ApprovalsConfig> {
  const label = "Approvals config";
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
  const operators = record["operators"];
  if (
    !Array.isArray(operators) ||
    operators.length === 0 ||
    !operators.every((entry) => typeof entry === "string" && OPERATOR_PATTERN.test(entry)) ||
    new Set(operators).size !== operators.length
  ) {
    throw new Error(`${label} ${path}: invalid required key "operators"`);
  }
  return {
    requestsPath: requiredPath(record, path, "requestsPath"),
    operators: [...(operators as string[])],
    maxPendingRequests: requiredInteger(record, path, "maxPendingRequests", 1, 1000),
    maxReasonChars: requiredInteger(record, path, "maxReasonChars", 1, 20000),
  };
}

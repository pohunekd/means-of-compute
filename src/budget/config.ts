// Typed loader for config/budget.json. Every field is required: the guard must
// fail at startup with a clear error instead of silently using a default cap.
// A missing or unreadable file exits 2; the config may never be absent.
import { readInputText, statInputPath } from "../fs/input.js";
import { priceToNanoUsd } from "./money.js";
import type { UnmeasuredAuditBound } from "./cost.js";
export interface BudgetConfig {
  readonly statePath: string;
  readonly escalationLogPath: string;
  readonly dayCapNanoUsd: bigint;
  readonly totalCapNanoUsd: bigint;
  readonly nvidiaDailyRequestLimit: number;
  readonly nvidiaProviderId: string;
  readonly unmeasuredAuditCall: UnmeasuredAuditBound;
}

const DEFAULT_CONFIG_PATH = "config/budget.json";

function requiredString(record: Record<string, unknown>, field: string, path: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Budget config ${path}: missing or invalid required field "${field}"`);
  }
  return value;
}

function requiredCount(record: Record<string, unknown>, field: string, path: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Budget config ${path}: missing or invalid required field "${field}"`);
  }
  return value;
}

function requiredAuditBound(record: Record<string, unknown>, path: string): UnmeasuredAuditBound {
  const value = record["unmeasuredAuditCall"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Budget config ${path}: missing or invalid required field "unmeasuredAuditCall"`,
    );
  }
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  if (keys.length !== 2 || keys[0] !== "inputTokens" || keys[1] !== "outputTokens") {
    throw new Error(
      `Budget config ${path}: missing or invalid required field "unmeasuredAuditCall"`,
    );
  }
  for (const key of keys) {
    const count = entry[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
      throw new Error(
        `Budget config ${path}: missing or invalid required field "unmeasuredAuditCall"`,
      );
    }
  }
  return {
    inputTokens: entry["inputTokens"] as number,
    outputTokens: entry["outputTokens"] as number,
  };
}

function requiredCap(record: Record<string, unknown>, field: string, path: string): bigint {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Budget config ${path}: missing or invalid required field "${field}"`);
  }
  return priceToNanoUsd(value, field, path);
}

export async function loadBudgetConfig(path: string = DEFAULT_CONFIG_PATH): Promise<BudgetConfig> {
  const label = "Budget config";
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Budget config ${path}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Budget config ${path}: must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  return {
    statePath: requiredString(record, "statePath", path),
    escalationLogPath: requiredString(record, "escalationLogPath", path),
    dayCapNanoUsd: requiredCap(record, "dayCapUsd", path),
    totalCapNanoUsd: requiredCap(record, "totalCapUsd", path),
    nvidiaDailyRequestLimit: requiredCount(record, "nvidiaDailyRequestLimit", path),
    nvidiaProviderId: requiredString(record, "nvidiaProviderId", path),
    unmeasuredAuditCall: requiredAuditBound(record, path),
  };
}

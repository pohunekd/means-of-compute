// Typed loader for config/budget.json. Every field is required: the guard must
// fail at startup with a clear error instead of silently using a default cap.
// A missing or unreadable file exits 2; the config may never be absent.
import { readInputText, statInputPath } from "./fs.js";
export interface BudgetConfig {
  readonly ledgerPath: string;
  readonly statePath: string;
  readonly escalationLogPath: string;
  readonly dayCapUsd: number;
  readonly totalCapUsd: number;
  readonly nvidiaDailyRequestLimit: number;
  readonly nvidiaProviderId: string;
}

const DEFAULT_CONFIG_PATH = "config/budget.json";

function requiredString(record: Record<string, unknown>, field: string, path: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Budget config ${path}: missing or invalid required field "${field}"`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, field: string, path: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Budget config ${path}: missing or invalid required field "${field}"`);
  }
  return value;
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
    ledgerPath: requiredString(record, "ledgerPath", path),
    statePath: requiredString(record, "statePath", path),
    escalationLogPath: requiredString(record, "escalationLogPath", path),
    dayCapUsd: requiredNumber(record, "dayCapUsd", path),
    totalCapUsd: requiredNumber(record, "totalCapUsd", path),
    nvidiaDailyRequestLimit: requiredNumber(record, "nvidiaDailyRequestLimit", path),
    nvidiaProviderId: requiredString(record, "nvidiaProviderId", path),
  };
}

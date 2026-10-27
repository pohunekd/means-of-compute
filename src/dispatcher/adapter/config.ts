// Typed loader for config/pohunek-adapter.json (design section 7).
// Every key is required, no extra key is allowed. Any failure is a startup
// error (exit 2 at the CLI) and names the offending key.
import { MAX_SESSION_WAIT_MS, MAX_SESSION_WAIT_TURN_MS } from "@pohunek/sdk";
import { readInputText, statInputPath } from "../../fs/input.js";

export interface PohunekAdapterConfig {
  readonly agentProfile: string;
  readonly project: string;
  readonly cols: number;
  readonly rows: number;
  readonly inputAckTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly cancelWaitTimeoutMs: number;
  readonly hostRoutesFileEnv: string;
}

export const POHUNEK_ADAPTER_CONFIG_PATH = "config/pohunek-adapter.json";

const ALLOWED_KEYS = new Set([
  "agentProfile",
  "project",
  "cols",
  "rows",
  "inputAckTimeoutMs",
  "connectTimeoutMs",
  "cancelWaitTimeoutMs",
  "hostRoutesFileEnv",
]);

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIntegerIn(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
}

export function checkPohunekAdapterConfig(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "must be a JSON object";
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      return `unexpected key "${key}"`;
    }
  }
  for (const key of ALLOWED_KEYS) {
    if (!(key in record)) {
      return `missing required key "${key}"`;
    }
  }
  if (!isNonEmptyString(record["agentProfile"])) {
    return '"agentProfile" must be a non-empty string';
  }
  if (!isNonEmptyString(record["project"])) {
    return '"project" must be a non-empty string';
  }
  if (!isIntegerIn(record["cols"], 20, 1000)) {
    return '"cols" must be an integer in 20..1000';
  }
  if (!isIntegerIn(record["rows"], 20, 1000)) {
    return '"rows" must be an integer in 20..1000';
  }
  if (!isIntegerIn(record["inputAckTimeoutMs"], 1, MAX_SESSION_WAIT_MS)) {
    return `"inputAckTimeoutMs" must be an integer in 1..${String(MAX_SESSION_WAIT_MS)}`;
  }
  if (!isIntegerIn(record["connectTimeoutMs"], 1, 60000)) {
    return '"connectTimeoutMs" must be an integer in 1..60000';
  }
  if (!isIntegerIn(record["cancelWaitTimeoutMs"], 1, MAX_SESSION_WAIT_TURN_MS)) {
    return `"cancelWaitTimeoutMs" must be an integer in 1..${String(MAX_SESSION_WAIT_TURN_MS)}`;
  }
  const envName = record["hostRoutesFileEnv"];
  if (!isNonEmptyString(envName) || !ENV_NAME_PATTERN.test(envName)) {
    return '"hostRoutesFileEnv" must match ^[A-Z][A-Z0-9_]*$';
  }
  return null;
}

export async function loadPohunekAdapterConfig(
  path: string = POHUNEK_ADAPTER_CONFIG_PATH,
): Promise<PohunekAdapterConfig> {
  const label = "Pohunek adapter config";
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
  const structural = checkPohunekAdapterConfig(raw);
  if (structural !== null) {
    throw new Error(`${label} ${path}: ${structural}`);
  }
  const record = raw as Record<string, unknown>;
  return {
    agentProfile: record["agentProfile"] as string,
    project: record["project"] as string,
    cols: record["cols"] as number,
    rows: record["rows"] as number,
    inputAckTimeoutMs: record["inputAckTimeoutMs"] as number,
    connectTimeoutMs: record["connectTimeoutMs"] as number,
    cancelWaitTimeoutMs: record["cancelWaitTimeoutMs"] as number,
    hostRoutesFileEnv: record["hostRoutesFileEnv"] as string,
  };
}

// The dispatcher's wait timeout must fit one daemon turn wait.
export function checkDispatcherWaitTimeout(waitTimeoutMs: number): void {
  if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1) {
    throw new Error(`"waitTimeoutMs" must be an integer in 1..${String(MAX_SESSION_WAIT_TURN_MS)}`);
  }
  if (waitTimeoutMs > MAX_SESSION_WAIT_TURN_MS) {
    throw new Error(
      `"waitTimeoutMs" must be an integer in 1..${String(MAX_SESSION_WAIT_TURN_MS)}`,
    );
  }
}

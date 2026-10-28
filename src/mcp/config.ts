// Typed loader for config/mcp.json. Every key is required and no extra
// key is allowed: a missing file or a failed validation names the key.
import { readInputText, statInputPath } from "../fs/input.js";

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpConfig {
  readonly serverInfo: McpServerInfo;
  readonly callers: readonly string[];
  readonly callLogPath: string;
  readonly maxMessageBytes: number;
  readonly clientTimeoutMs: number;
  readonly workConfigPath: string;
  readonly auditorConfigPath: string;
  readonly dispatcherConfigPath: string;
}

export const MCP_CONFIG_PATH = "config/mcp.json";

const REQUIRED_KEYS = [
  "serverInfo",
  "callers",
  "callLogPath",
  "maxMessageBytes",
  "clientTimeoutMs",
  "workConfigPath",
  "auditorConfigPath",
  "dispatcherConfigPath",
] as const;

const CALLER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function requiredPath(record: Record<string, unknown>, path: string, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`MCP config ${path}: invalid required key "${key}"`);
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
    throw new Error(`MCP config ${path}: invalid required key "${key}"`);
  }
  return value;
}

function requiredServerInfo(record: Record<string, unknown>, path: string): McpServerInfo {
  const value = record["serverInfo"];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>)["name"] !== "string" ||
    ((value as Record<string, unknown>)["name"] as string).length === 0 ||
    typeof (value as Record<string, unknown>)["version"] !== "string" ||
    ((value as Record<string, unknown>)["version"] as string).length === 0
  ) {
    throw new Error(`MCP config ${path}: invalid required key "serverInfo"`);
  }
  const info = value as Record<string, string>;
  return { name: info["name"] as string, version: info["version"] as string };
}

function requiredCallers(record: Record<string, unknown>, path: string): readonly string[] {
  const value = record["callers"];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (entry): entry is string => typeof entry === "string" && CALLER_PATTERN.test(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`MCP config ${path}: invalid required key "callers"`);
  }
  return [...(value as string[])];
}

export async function loadMcpConfig(path: string = MCP_CONFIG_PATH): Promise<McpConfig> {
  const label = "MCP config";
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
  return {
    serverInfo: requiredServerInfo(record, path),
    callers: requiredCallers(record, path),
    callLogPath: requiredPath(record, path, "callLogPath"),
    maxMessageBytes: requiredInteger(record, path, "maxMessageBytes", 1024, 16777216),
    clientTimeoutMs: requiredInteger(record, path, "clientTimeoutMs", 1, 600000),
    workConfigPath: requiredPath(record, path, "workConfigPath"),
    auditorConfigPath: requiredPath(record, path, "auditorConfigPath"),
    dispatcherConfigPath: requiredPath(record, path, "dispatcherConfigPath"),
  };
}

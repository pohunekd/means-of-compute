// Typed loader for config/dashboard.json. Every key is required and no
// extra key is allowed, at the top level and inside baselines. Any failure
// throws DashboardConfigError naming the key, which the CLI reports as
// exit 2. Baseline prices reuse the budget money conversion so no float
// reaches the dashboard either.
import { isIP } from "node:net";
import { priceToNanoUsd } from "../budget/money.js";
import { readInputText, statInputPath } from "../fs/input.js";

export const DASHBOARD_CONFIG_PATH = "config/dashboard.json";

export interface TokenBaseline {
  readonly label: string;
  readonly inputNanoPer1M: bigint;
  readonly outputNanoPer1M: bigint;
  readonly source: string;
  readonly asOf: string;
}

export interface HourBaseline {
  readonly label: string;
  readonly nanoPerHour: bigint;
  readonly source: string;
  readonly asOf: string;
}

export interface Baselines {
  readonly frontierTokens: TokenBaseline | null;
  readonly cloudSandboxHour: HourBaseline | null;
  readonly ownedHostHour: HourBaseline | null;
}

export interface DashboardConfig {
  readonly listenEnv: string;
  readonly listenAlias: string;
  readonly logPath: string;
  readonly maxRequestBytes: number;
  readonly idleTimeoutSec: number;
  readonly workRowLimit: number;
  readonly baselines: Baselines;
}

export class DashboardConfigError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DashboardConfigError";
  }
}

const TOP_LEVEL_KEYS = [
  "listenEnv",
  "listenAlias",
  "logPath",
  "maxRequestBytes",
  "idleTimeoutSec",
  "workRowLimit",
  "baselines",
] as const;

const BASELINE_KEYS = ["frontierTokens", "cloudSandboxHour", "ownedHostHour"] as const;

const TOKEN_BASELINE_KEYS = ["label", "inputPer1M", "outputPer1M", "source", "asOf"] as const;

const HOUR_BASELINE_KEYS = ["label", "perHour", "source", "asOf"] as const;

const LISTEN_ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const LISTEN_ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const LISTEN_VALUE_PATTERN = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9A-Fa-f:.]+)\]):(\d{1,5})$/;

const PINNED_NOW_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function checkKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  what: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new DashboardConfigError(
        `Dashboard config ${path}: ${what} has unexpected key "${key}"`,
      );
    }
  }
  for (const key of allowed) {
    if (!(key in record)) {
      throw new DashboardConfigError(
        `Dashboard config ${path}: ${what} is missing required key "${key}"`,
      );
    }
  }
}

function asRecord(value: unknown, keyPath: string, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DashboardConfigError(
      `Dashboard config ${path}: invalid "${keyPath}": must be a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

function parseText(
  record: Record<string, unknown>,
  field: string,
  keyPath: string,
  path: string,
  pattern: RegExp,
  what: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new DashboardConfigError(
      `Dashboard config ${path}: invalid "${keyPath}": must match ${what}`,
    );
  }
  return value;
}

function parseLabel(value: unknown, keyPath: string, path: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 80 ||
    CONTROL_CHARS_PATTERN.test(value)
  ) {
    throw new DashboardConfigError(
      `Dashboard config ${path}: invalid "${keyPath}": must be 1..80 chars without control characters`,
    );
  }
  return value;
}

function parseSource(value: unknown, keyPath: string, path: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 300 ||
    CONTROL_CHARS_PATTERN.test(value)
  ) {
    throw new DashboardConfigError(
      `Dashboard config ${path}: invalid "${keyPath}": must be 1..300 chars without control characters`,
    );
  }
  return value;
}

function parseAsOf(value: unknown, keyPath: string, path: string): string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new DashboardConfigError(
      `Dashboard config ${path}: invalid "${keyPath}": must be a date YYYY-MM-DD`,
    );
  }
  const stamp = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) {
    throw new DashboardConfigError(
      `Dashboard config ${path}: invalid "${keyPath}": not a calendar date`,
    );
  }
  return value;
}

function parsePrice(value: unknown, keyPath: string, path: string): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new DashboardConfigError(
      `Dashboard config ${path}: invalid "${keyPath}": must be a number >= 0`,
    );
  }
  try {
    return priceToNanoUsd(value, keyPath, path);
  } catch (error: unknown) {
    throw new DashboardConfigError(`Dashboard config ${path}: invalid "${keyPath}"`, {
      cause: error,
    });
  }
}

function parseInteger(
  record: Record<string, unknown>,
  field: string,
  keyPath: string,
  path: string,
  low: number,
  high: number,
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
    throw new DashboardConfigError(
      `Dashboard config ${path}: invalid "${keyPath}": must be an integer in ${String(low)}..${String(high)}`,
    );
  }
  return value;
}

function parseTokenBaseline(value: unknown, keyPath: string, path: string): TokenBaseline | null {
  if (value === null) {
    return null;
  }
  const record = asRecord(value, keyPath, path);
  checkKeys(record, TOKEN_BASELINE_KEYS, path, `"${keyPath}"`);
  return {
    label: parseLabel(record["label"], `${keyPath}.label`, path),
    inputNanoPer1M: parsePrice(record["inputPer1M"], `${keyPath}.inputPer1M`, path),
    outputNanoPer1M: parsePrice(record["outputPer1M"], `${keyPath}.outputPer1M`, path),
    source: parseSource(record["source"], `${keyPath}.source`, path),
    asOf: parseAsOf(record["asOf"], `${keyPath}.asOf`, path),
  };
}

function parseHourBaseline(value: unknown, keyPath: string, path: string): HourBaseline | null {
  if (value === null) {
    return null;
  }
  const record = asRecord(value, keyPath, path);
  checkKeys(record, HOUR_BASELINE_KEYS, path, `"${keyPath}"`);
  return {
    label: parseLabel(record["label"], `${keyPath}.label`, path),
    nanoPerHour: parsePrice(record["perHour"], `${keyPath}.perHour`, path),
    source: parseSource(record["source"], `${keyPath}.source`, path),
    asOf: parseAsOf(record["asOf"], `${keyPath}.asOf`, path),
  };
}

function parseDashboardConfig(raw: unknown, path: string): DashboardConfig {
  const record = asRecord(raw, "config", path);
  checkKeys(record, TOP_LEVEL_KEYS, path, "config");
  const baselines = asRecord(record["baselines"], "baselines", path);
  checkKeys(baselines, BASELINE_KEYS, path, `"baselines"`);
  return {
    listenEnv: parseText(
      record,
      "listenEnv",
      "listenEnv",
      path,
      LISTEN_ENV_PATTERN,
      "^[A-Z][A-Z0-9_]*$",
    ),
    listenAlias: parseText(
      record,
      "listenAlias",
      "listenAlias",
      path,
      LISTEN_ALIAS_PATTERN,
      "^[a-z][a-z0-9-]{0,31}$",
    ),
    logPath: parseLogPath(record["logPath"], path),
    maxRequestBytes: parseInteger(record, "maxRequestBytes", "maxRequestBytes", path, 1, 65536),
    idleTimeoutSec: parseInteger(record, "idleTimeoutSec", "idleTimeoutSec", path, 1, 255),
    workRowLimit: parseInteger(record, "workRowLimit", "workRowLimit", path, 1, 1000),
    baselines: {
      frontierTokens: parseTokenBaseline(
        baselines["frontierTokens"],
        "baselines.frontierTokens",
        path,
      ),
      cloudSandboxHour: parseHourBaseline(
        baselines["cloudSandboxHour"],
        "baselines.cloudSandboxHour",
        path,
      ),
      ownedHostHour: parseHourBaseline(baselines["ownedHostHour"], "baselines.ownedHostHour", path),
    },
  };
}

function parseLogPath(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DashboardConfigError(
      `Dashboard config ${path}: invalid "logPath": must be a non-empty string`,
    );
  }
  return value;
}

function wrapInputError(error: unknown): DashboardConfigError {
  if (error instanceof DashboardConfigError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new DashboardConfigError(message, { cause: error });
}

export async function loadDashboardConfig(
  path: string = DASHBOARD_CONFIG_PATH,
): Promise<DashboardConfig> {
  const label = "Dashboard config";
  let status: string;
  try {
    status = await statInputPath(label, path);
  } catch (error: unknown) {
    throw wrapInputError(error);
  }
  if (status === "absent") {
    throw new DashboardConfigError(`${label} ${path}: file is missing`);
  }
  let text: string;
  try {
    text = await readInputText(label, path);
  } catch (error: unknown) {
    throw wrapInputError(error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new DashboardConfigError(`${label} ${path}: not valid JSON`, { cause: error });
  }
  return parseDashboardConfig(raw, path);
}

// Bind rule: the listen address comes from the env var named by listenEnv,
// in host:port form. The host must be a loopback address (127.0.0.0/8 or
// [::1]); anything else exits 2. Error texts name the variable and the
// listen alias, never the value.
export function resolveDashboardListen(
  config: DashboardConfig,
  env: Readonly<Record<string, string | undefined>>,
): { readonly host: string; readonly port: number } {
  const variable = config.listenEnv;
  const alias = config.listenAlias;
  const raw = env[variable];
  if (raw === undefined || raw === "") {
    throw new DashboardConfigError(`environment variable ${variable} is not set (listen ${alias})`);
  }
  const match = LISTEN_VALUE_PATTERN.exec(raw);
  if (match === null) {
    throw new DashboardConfigError(
      `environment variable ${variable} must be host:port (listen ${alias})`,
    );
  }
  const host = (match[1] ?? match[2] ?? "") as string;
  const port = Number(match[3] as string);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new DashboardConfigError(
      `environment variable ${variable} must use a port in 0..65535 (listen ${alias})`,
    );
  }
  const loopback = (isIP(host) === 4 && host.split(".")[0] === "127") || host === "::1";
  if (!loopback) {
    throw new DashboardConfigError(
      `environment variable ${variable} must be a loopback address (127.0.0.0/8 or [::1]) (listen ${alias})`,
    );
  }
  return { host, port };
}

// Test-only clock pin. Unset means the real clock; a set value must match
// the timestamp form and round-trip through Date, like MOC_BUDGET_NOW.
export function readDashboardNow(env: Readonly<Record<string, string | undefined>>): Date | null {
  const raw = env["MOC_DASHBOARD_NOW"];
  if (raw === undefined) {
    return null;
  }
  if (!PINNED_NOW_PATTERN.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new DashboardConfigError(
      "environment variable MOC_DASHBOARD_NOW must be an ISO-8601 UTC timestamp",
    );
  }
  const now = new Date(Date.parse(raw));
  const normalized = raw.includes(".") ? raw : raw.replace("Z", ".000Z");
  if (now.toISOString() !== normalized) {
    throw new DashboardConfigError(
      "environment variable MOC_DASHBOARD_NOW must be an ISO-8601 UTC timestamp",
    );
  }
  return now;
}

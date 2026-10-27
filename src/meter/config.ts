// Meter configuration: committed tuning values plus private environment
// references. Secrets and addresses are never logged or put into errors.
import { isIP } from "node:net";
import { readInputText, statInputPath } from "../fs/input.js";

export const METER_CONFIG_PATH = "config/meter.json";

export interface MeterConfig {
  readonly listenEnv: string;
  readonly listenAlias: string;
  readonly secretEnv: string;
  readonly hostAddressesFileEnv: string;
  readonly usageLogPath: string;
  readonly sessionModelId: string;
  readonly maxRequestBytes: number;
  readonly maxUsageScanBytes: number;
  readonly clientIdleTimeoutSec: number;
  readonly firstByteTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly unboundGrantTtlMs: number;
  readonly maxInFlightPerSession: number;
}

export interface MeterEnv {
  readonly listen: { readonly host: string; readonly port: number };
  readonly secret: Buffer;
  readonly hostAddresses: ReadonlyMap<string, ReadonlySet<string>>;
  readonly hostAddressesFile: string;
}

export class MeterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeterConfigError";
  }
}

const EXPECTED_KEYS: readonly (keyof MeterConfig)[] = [
  "listenEnv",
  "listenAlias",
  "secretEnv",
  "hostAddressesFileEnv",
  "usageLogPath",
  "sessionModelId",
  "maxRequestBytes",
  "maxUsageScanBytes",
  "clientIdleTimeoutSec",
  "firstByteTimeoutMs",
  "idleTimeoutMs",
  "totalTimeoutMs",
  "drainTimeoutMs",
  "unboundGrantTtlMs",
  "maxInFlightPerSession",
];

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const LISTEN_PATTERN = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9A-Fa-f:.]+)\]):(\d{1,5})$/;

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function checkMeterConfig(raw: unknown): MeterConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MeterConfigError("meter config: must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(EXPECTED_KEYS as readonly string[]).includes(key)) {
      throw new MeterConfigError(`meter config: unexpected key "${key}"`);
    }
  }
  for (const key of EXPECTED_KEYS) {
    if (!(key in record)) {
      throw new MeterConfigError(`meter config: missing key "${key}"`);
    }
  }
  const get = (key: keyof MeterConfig): unknown => record[key];
  const envName = (key: "listenEnv" | "secretEnv" | "hostAddressesFileEnv"): string => {
    const value = get(key);
    if (typeof value !== "string" || !ENV_NAME_PATTERN.test(value)) {
      throw new MeterConfigError(`meter config: key "${key}" must match ^[A-Z][A-Z0-9_]*$`);
    }
    return value;
  };
  const listenAlias = get("listenAlias");
  if (typeof listenAlias !== "string" || !ALIAS_PATTERN.test(listenAlias)) {
    throw new MeterConfigError('meter config: key "listenAlias" must match ^[a-z][a-z0-9-]{0,31}$');
  }
  const usageLogPath = get("usageLogPath");
  if (typeof usageLogPath !== "string" || usageLogPath.length === 0) {
    throw new MeterConfigError('meter config: key "usageLogPath" must be a non-empty string');
  }
  const sessionModelId = get("sessionModelId");
  if (typeof sessionModelId !== "string" || !MODEL_ID_PATTERN.test(sessionModelId)) {
    throw new MeterConfigError(
      'meter config: key "sessionModelId" must match ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$',
    );
  }
  const intKey = (key: keyof MeterConfig, min: number, max: number): number => {
    const value = get(key);
    if (!isIntegerIn(value, min, max)) {
      throw new MeterConfigError(
        `meter config: key "${key}" must be an integer in ${String(min)}..${String(max)}`,
      );
    }
    return value;
  };
  const maxRequestBytes = intKey("maxRequestBytes", 1024, 67108864);
  const maxUsageScanBytes = intKey("maxUsageScanBytes", 1024, 67108864);
  const clientIdleTimeoutSec = intKey("clientIdleTimeoutSec", 1, 255);
  const firstByteTimeoutMs = intKey("firstByteTimeoutMs", 1, 600000);
  const idleTimeoutMs = intKey("idleTimeoutMs", 1, 600000);
  const totalTimeoutMs = intKey("totalTimeoutMs", 1, 86400000);
  if (totalTimeoutMs < firstByteTimeoutMs) {
    throw new MeterConfigError(
      'meter config: key "totalTimeoutMs" must be >= "firstByteTimeoutMs"',
    );
  }
  const drainTimeoutMs = intKey("drainTimeoutMs", 0, 600000);
  const unboundGrantTtlMs = intKey("unboundGrantTtlMs", 1000, 3600000);
  const maxInFlightPerSession = intKey("maxInFlightPerSession", 1, 64);
  return {
    listenEnv: envName("listenEnv"),
    listenAlias,
    secretEnv: envName("secretEnv"),
    hostAddressesFileEnv: envName("hostAddressesFileEnv"),
    usageLogPath,
    sessionModelId,
    maxRequestBytes,
    maxUsageScanBytes,
    clientIdleTimeoutSec,
    firstByteTimeoutMs,
    idleTimeoutMs,
    totalTimeoutMs,
    drainTimeoutMs,
    unboundGrantTtlMs,
    maxInFlightPerSession,
  };
}

export async function loadMeterConfig(path: string = METER_CONFIG_PATH): Promise<MeterConfig> {
  const label = "Meter config";
  if ((await statInputPath(label, path)) === "absent") {
    throw new MeterConfigError(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new MeterConfigError(`${label} ${path}: not valid JSON`);
  }
  return checkMeterConfig(raw);
}

function resolveListen(
  config: MeterConfig,
  env: Readonly<Record<string, string | undefined>>,
): { readonly host: string; readonly port: number } {
  const raw = env[config.listenEnv];
  if (!raw) {
    throw new MeterConfigError(
      `meter: environment variable ${config.listenEnv} is not set (listen ${config.listenAlias})`,
    );
  }
  const match = LISTEN_PATTERN.exec(raw);
  if (match === null) {
    throw new MeterConfigError(
      `meter: environment variable ${config.listenEnv} must be host:port (listen ${config.listenAlias})`,
    );
  }
  const host = (match[1] ?? match[2]) as string;
  const portText = match[3] as string;
  if (isIP(host) === 0) {
    throw new MeterConfigError(
      `meter: environment variable ${config.listenEnv} holds an invalid IP (listen ${config.listenAlias})`,
    );
  }
  if (host.replace(/[0.:]/g, "") === "") {
    throw new MeterConfigError(
      `meter: environment variable ${config.listenEnv} must not be a wildcard (listen ${config.listenAlias})`,
    );
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new MeterConfigError(
      `meter: environment variable ${config.listenEnv} holds a port outside 0..65535 (listen ${config.listenAlias})`,
    );
  }
  return { host, port };
}

function resolveSecret(
  config: MeterConfig,
  env: Readonly<Record<string, string | undefined>>,
): Buffer {
  const raw = env[config.secretEnv];
  if (!raw) {
    throw new MeterConfigError(`meter: environment variable ${config.secretEnv} is not set`);
  }
  if (!STRICT_BASE64_PATTERN.test(raw) || Buffer.from(raw, "base64").toString("base64") !== raw) {
    throw new MeterConfigError(
      `meter: environment variable ${config.secretEnv} must be strict base64`,
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length < 32) {
    throw new MeterConfigError(
      `meter: environment variable ${config.secretEnv} must decode to at least 32 bytes`,
    );
  }
  return decoded;
}

function checkHostAddressesContent(
  file: string,
  content: unknown,
): ReadonlyMap<string, ReadonlySet<string>> {
  const label = `Meter host addresses ${file}`;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new MeterConfigError(`${label}: must be a JSON object`);
  }
  const record = content as Record<string, unknown>;
  const result = new Map<string, ReadonlySet<string>>();
  const owner = new Map<string, string>();
  for (const [alias, value] of Object.entries(record)) {
    if (!ALIAS_PATTERN.test(alias)) {
      throw new MeterConfigError(`${label}: invalid alias "${alias}"`);
    }
    if (!Array.isArray(value) || value.length === 0) {
      throw new MeterConfigError(`${label}: alias "${alias}" must map to a non-empty array`);
    }
    const addresses = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string" || isIP(entry) === 0) {
        throw new MeterConfigError(`${label}: alias "${alias}" holds an invalid IP`);
      }
      if (entry.toLowerCase().startsWith("::ffff:")) {
        throw new MeterConfigError(`${label}: alias "${alias}" must not use a mapped address`);
      }
      if (addresses.has(entry)) {
        throw new MeterConfigError(`${label}: alias "${alias}" lists a duplicate address`);
      }
      const other = owner.get(entry);
      if (other !== undefined && other !== alias) {
        throw new MeterConfigError(
          `${label}: address is shared by aliases "${other}" and "${alias}"`,
        );
      }
      owner.set(entry, alias);
      addresses.add(entry);
    }
    result.set(alias, addresses);
  }
  return result;
}

export async function resolveMeterEnv(
  config: MeterConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<MeterEnv> {
  const listen = resolveListen(config, env);
  const secret = resolveSecret(config, env);
  const file = env[config.hostAddressesFileEnv];
  if (!file) {
    throw new MeterConfigError(
      `meter: environment variable ${config.hostAddressesFileEnv} is not set`,
    );
  }
  const label = "Meter host addresses";
  if ((await statInputPath(label, file)) === "absent") {
    throw new MeterConfigError(`${label} ${file}: file is missing`);
  }
  const text = await readInputText(label, file);
  let content: unknown;
  try {
    content = JSON.parse(text) as unknown;
  } catch {
    throw new MeterConfigError(`${label} ${file}: not valid JSON`);
  }
  const hostAddresses = checkHostAddressesContent(file, content);
  return { listen, secret, hostAddresses, hostAddressesFile: file };
}

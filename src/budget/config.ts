// Typed loader for config/budget.json. Every field is required: the guard must
// fail at startup with a clear error instead of silently using a default cap.
// A missing or unreadable file exits 2; the config may never be absent.
// The top-level caps belong to the main pool (`poolId`), which holds every
// provider outside the named `pools`; each named pool has its own caps and
// meter-call bound, and a provider belongs to at most one named pool.
import { readInputText, statInputPath } from "../fs/input.js";
import { priceToNanoUsd } from "./money.js";
import { type SpendBounds, type UnmeasuredCallBound } from "./cost.js";
export interface BudgetPool {
  readonly id: string;
  /** Null for the main pool: every provider outside the named pools. */
  readonly providers: readonly string[] | null;
  readonly dayCapNanoUsd: bigint;
  readonly totalCapNanoUsd: bigint;
  readonly unmeasuredMeterCall: UnmeasuredCallBound;
}

export interface BudgetConfig {
  readonly statePath: string;
  readonly escalationLogPath: string;
  readonly poolId: string;
  readonly pools: readonly BudgetPool[];
  readonly dayCapNanoUsd: bigint;
  readonly totalCapNanoUsd: bigint;
  readonly nvidiaDailyRequestLimit: number;
  readonly nvidiaProviderId: string;
  readonly unmeasuredAuditCall: UnmeasuredCallBound;
  readonly unmeasuredMeterCall: UnmeasuredCallBound;
}

const DEFAULT_CONFIG_PATH = "config/budget.json";
const POOL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;
const POOL_KEYS = ["dayCapUsd", "id", "providers", "totalCapUsd", "unmeasuredMeterCall"];

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

function requiredCallBound(
  record: Record<string, unknown>,
  field: string,
  path: string,
): UnmeasuredCallBound {
  const value = record[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Budget config ${path}: missing or invalid required field "${field}"`);
  }
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  if (keys.length !== 2 || keys[0] !== "inputTokens" || keys[1] !== "outputTokens") {
    throw new Error(`Budget config ${path}: missing or invalid required field "${field}"`);
  }
  for (const key of keys) {
    const count = entry[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
      throw new Error(`Budget config ${path}: missing or invalid required field "${field}"`);
    }
  }
  return {
    inputTokens: entry["inputTokens"] as number,
    outputTokens: entry["outputTokens"] as number,
  };
}

export function spendBoundsOf(config: BudgetConfig): SpendBounds {
  const meterCallByProvider = new Map<string, UnmeasuredCallBound>();
  for (const pool of config.pools) {
    for (const id of pool.providers ?? []) {
      meterCallByProvider.set(id, pool.unmeasuredMeterCall);
    }
  }
  return {
    auditCall: config.unmeasuredAuditCall,
    meterCall: config.unmeasuredMeterCall,
    meterCallByProvider,
  };
}

export function mainPoolOf(config: BudgetConfig): BudgetPool {
  return {
    id: config.poolId,
    providers: null,
    dayCapNanoUsd: config.dayCapNanoUsd,
    totalCapNanoUsd: config.totalCapNanoUsd,
    unmeasuredMeterCall: config.unmeasuredMeterCall,
  };
}

/** The main pool first, then the named pools in config order. */
export function poolsOf(config: BudgetConfig): readonly BudgetPool[] {
  return [mainPoolOf(config), ...config.pools];
}

export function poolOfProvider(config: BudgetConfig, providerId: string): BudgetPool {
  return (
    config.pools.find((pool) => pool.providers?.includes(providerId) === true) ?? mainPoolOf(config)
  );
}

/** True when the provider's spend counts against the pool. */
export function poolHolds(config: BudgetConfig, pool: BudgetPool, providerId: string): boolean {
  return poolOfProvider(config, providerId).id === pool.id;
}

function requiredPools(
  record: Record<string, unknown>,
  poolId: string,
  nvidiaProviderId: string,
  path: string,
): readonly BudgetPool[] {
  const value = record["pools"];
  if (!Array.isArray(value)) {
    throw new Error(`Budget config ${path}: missing or invalid required field "pools"`);
  }
  const ids = new Set<string>([poolId]);
  const owners = new Set<string>();
  return value.map((raw: unknown, index): BudgetPool => {
    const field = `pools[${String(index)}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Budget config ${path}: invalid field "${field}"`);
    }
    const entry = raw as Record<string, unknown>;
    const keys = Object.keys(entry).sort();
    if (keys.length !== POOL_KEYS.length || keys.some((key, at) => key !== POOL_KEYS[at])) {
      throw new Error(
        `Budget config ${path}: "${field}" needs exactly the keys ${POOL_KEYS.join(", ")}`,
      );
    }
    const id = entry["id"];
    if (typeof id !== "string" || !POOL_ID_PATTERN.test(id) || ids.has(id)) {
      throw new Error(`Budget config ${path}: invalid or duplicate pool id in "${field}"`);
    }
    ids.add(id);
    const providers = entry["providers"];
    if (
      !Array.isArray(providers) ||
      providers.length === 0 ||
      providers.some((provider: unknown) => typeof provider !== "string")
    ) {
      throw new Error(`Budget config ${path}: invalid field "${field}.providers"`);
    }
    for (const provider of providers as string[]) {
      if (!PROVIDER_ID_PATTERN.test(provider) || owners.has(provider)) {
        throw new Error(
          `Budget config ${path}: invalid or repeated provider "${provider}" in "${field}.providers"`,
        );
      }
      if (provider === nvidiaProviderId) {
        throw new Error(
          `Budget config ${path}: nvidiaProviderId "${provider}" must stay in the main pool`,
        );
      }
      owners.add(provider);
    }
    return {
      id,
      providers: [...(providers as string[])],
      dayCapNanoUsd: requiredCap(entry, "dayCapUsd", path),
      totalCapNanoUsd: requiredCap(entry, "totalCapUsd", path),
      unmeasuredMeterCall: requiredCallBound(entry, "unmeasuredMeterCall", path),
    };
  });
}

function requiredCap(record: Record<string, unknown>, field: string, path: string): bigint {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Budget config ${path}: missing or invalid required field "${field}"`);
  }
  return priceToNanoUsd(value, field, path);
}

export async function loadBudgetConfig(path?: string): Promise<BudgetConfig> {
  const configPath = path ?? DEFAULT_CONFIG_PATH;
  const label = "Budget config";
  if ((await statInputPath(label, configPath)) === "absent") {
    throw new Error(`${label} ${configPath}: file is missing`);
  }
  const text = await readInputText(label, configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Budget config ${configPath}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Budget config ${configPath}: must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  const poolId = requiredString(record, "poolId", configPath);
  if (!POOL_ID_PATTERN.test(poolId)) {
    throw new Error(`Budget config ${configPath}: missing or invalid required field "poolId"`);
  }
  const nvidiaProviderId = requiredString(record, "nvidiaProviderId", configPath);
  return {
    statePath: requiredString(record, "statePath", configPath),
    escalationLogPath: requiredString(record, "escalationLogPath", configPath),
    poolId,
    pools: requiredPools(record, poolId, nvidiaProviderId, configPath),
    dayCapNanoUsd: requiredCap(record, "dayCapUsd", configPath),
    totalCapNanoUsd: requiredCap(record, "totalCapUsd", configPath),
    nvidiaDailyRequestLimit: requiredCount(record, "nvidiaDailyRequestLimit", configPath),
    nvidiaProviderId,
    unmeasuredAuditCall: requiredCallBound(record, "unmeasuredAuditCall", configPath),
    unmeasuredMeterCall: requiredCallBound(record, "unmeasuredMeterCall", configPath),
  };
}

// Admission decision for the budget guard, for one budget pool over that
// pool's spend. The guard refuses new sessions, never touches running ones:
// at or above a pool's USD cap every call on the pool is refused, and in the
// main pool, at or above the NVIDIA daily request limit, every route starting
// at the NVIDIA Build provider is refused. Any doubt (unknown spend) refuses.
// Spend and caps are integer nano-USD compared as BigInt; floats never
// decide.
import type { BudgetConfig, BudgetPool } from "./config.js";
import { TOKENS_PER_1M, nanoUsdToDisplayDollars, type SpendSummary } from "./cost.js";

export type RefusalReason =
  | "spend unknown"
  | "daily cap reached"
  | "total cap reached"
  | "NVIDIA Build daily request limit reached";

export interface BudgetDecision {
  readonly admit: boolean;
  readonly reason: string;
  readonly pool: string;
  readonly mainPool: boolean;
  readonly spentTodayUsd: number;
  readonly spentTotalUsd: number;
  readonly nvidiaRequestsToday: number;
}

export interface DecisionOptions {
  readonly route: readonly string[];
  readonly pool: BudgetPool;
}

function refused(reason: RefusalReason, summary: SpendSummary, pool: BudgetPool): BudgetDecision {
  return {
    admit: false,
    reason,
    pool: pool.id,
    mainPool: pool.providers === null,
    spentTodayUsd: nanoUsdToDisplayDollars(summary.spentTodayNanoUsd),
    spentTotalUsd: nanoUsdToDisplayDollars(summary.spentTotalNanoUsd),
    nvidiaRequestsToday: summary.nvidiaRequestsToday,
  };
}

export function decideAdmission(
  summary: SpendSummary,
  config: BudgetConfig,
  options: DecisionOptions,
): BudgetDecision {
  const { pool } = options;
  if (summary.unknownWorkItemIds.length > 0) {
    return refused("spend unknown", summary, pool);
  }
  if (summary.spentTodayNanoTimes1M >= pool.dayCapNanoUsd * TOKENS_PER_1M) {
    return refused("daily cap reached", summary, pool);
  }
  if (summary.spentTotalNanoTimes1M >= pool.totalCapNanoUsd * TOKENS_PER_1M) {
    return refused("total cap reached", summary, pool);
  }
  if (
    pool.providers === null &&
    summary.nvidiaRequestsToday >= config.nvidiaDailyRequestLimit &&
    options.route.length > 0 &&
    options.route[0] === config.nvidiaProviderId
  ) {
    return refused("NVIDIA Build daily request limit reached", summary, pool);
  }
  return {
    admit: true,
    reason: "within budget",
    pool: pool.id,
    mainPool: pool.providers === null,
    spentTodayUsd: nanoUsdToDisplayDollars(summary.spentTodayNanoUsd),
    spentTotalUsd: nanoUsdToDisplayDollars(summary.spentTotalNanoUsd),
    nvidiaRequestsToday: summary.nvidiaRequestsToday,
  };
}

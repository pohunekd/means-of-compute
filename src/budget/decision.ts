// Admission decision for the budget guard. The guard refuses new sessions,
// never touches running ones: at or above a USD cap every route is refused,
// and at or above the NVIDIA daily request limit every route starting at the
// NVIDIA Build provider is refused. Any doubt (unknown spend) refuses.
// Spend and caps are integer nano-USD compared as BigInt; floats never
// decide.
import type { BudgetConfig } from "./config.js";
import { nanoUsdToDisplayDollars, type SpendSummary } from "./cost.js";
import { NANO_PER_USD } from "./pricing.js";

export type RefusalReason =
  | "spend unknown"
  | "daily cap reached"
  | "total cap reached"
  | "NVIDIA Build daily request limit reached";

export interface BudgetDecision {
  readonly admit: boolean;
  readonly reason: string;
  readonly spentTodayUsd: number;
  readonly spentTotalUsd: number;
  readonly nvidiaRequestsToday: number;
}

export interface DecisionOptions {
  readonly route: readonly string[];
}

function refused(reason: RefusalReason, summary: SpendSummary): BudgetDecision {
  return {
    admit: false,
    reason,
    spentTodayUsd: nanoUsdToDisplayDollars(summary.spentTodayNanoUsd),
    spentTotalUsd: nanoUsdToDisplayDollars(summary.spentTotalNanoUsd),
    nvidiaRequestsToday: summary.nvidiaRequestsToday,
  };
}

/** Parses a configured USD cap into integer nano-USD for an exact comparison. */
export function capUsdToNanoUsd(capUsd: number, field: string): bigint {
  if (!Number.isFinite(capUsd) || capUsd < 0) {
    throw new Error(`Budget config: invalid cap "${field}"`);
  }
  const text = capUsd.toString();
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(text);
  if (match === null) {
    throw new Error(`Budget config: invalid cap "${field}"`);
  }
  const whole = BigInt(match[1] as string);
  const frac = (match[2] ?? "").padEnd(9, "0");
  return whole * NANO_PER_USD + BigInt(frac);
}

export function decideAdmission(
  summary: SpendSummary,
  config: BudgetConfig,
  options: DecisionOptions,
): BudgetDecision {
  if (summary.unknownWorkItemIds.length > 0) {
    return refused("spend unknown", summary);
  }
  if (summary.spentTodayNanoUsd >= capUsdToNanoUsd(config.dayCapUsd, "dayCapUsd")) {
    return refused("daily cap reached", summary);
  }
  if (summary.spentTotalNanoUsd >= capUsdToNanoUsd(config.totalCapUsd, "totalCapUsd")) {
    return refused("total cap reached", summary);
  }
  if (
    summary.nvidiaRequestsToday >= config.nvidiaDailyRequestLimit &&
    options.route.length > 0 &&
    options.route[0] === config.nvidiaProviderId
  ) {
    return refused("NVIDIA Build daily request limit reached", summary);
  }
  return {
    admit: true,
    reason: "within budget",
    spentTodayUsd: nanoUsdToDisplayDollars(summary.spentTodayNanoUsd),
    spentTotalUsd: nanoUsdToDisplayDollars(summary.spentTotalNanoUsd),
    nvidiaRequestsToday: summary.nvidiaRequestsToday,
  };
}

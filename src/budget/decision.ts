// Admission decision for the budget guard. The guard refuses new sessions,
// never touches running ones: at or above a USD cap every route is refused,
// and at or above the NVIDIA daily request limit every route starting at the
// NVIDIA Build provider is refused. Any doubt (unknown spend) refuses.
import type { BudgetConfig } from "./config.js";
import type { SpendSummary } from "./cost.js";

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
    spentTodayUsd: summary.spentTodayUsd,
    spentTotalUsd: summary.spentTotalUsd,
    nvidiaRequestsToday: summary.nvidiaRequestsToday,
  };
}

export function decideAdmission(
  summary: SpendSummary,
  config: BudgetConfig,
  options: DecisionOptions,
): BudgetDecision {
  if (summary.unknownWorkItemIds.length > 0) {
    return refused("spend unknown", summary);
  }
  if (summary.spentTodayUsd >= config.dayCapUsd) {
    return refused("daily cap reached", summary);
  }
  if (summary.spentTotalUsd >= config.totalCapUsd) {
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
    spentTodayUsd: summary.spentTodayUsd,
    spentTotalUsd: summary.spentTotalUsd,
    nvidiaRequestsToday: summary.nvidiaRequestsToday,
  };
}

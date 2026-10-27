// Spend math for the budget guard. Money is exact: cost is summed as
// integer nano-USD per 1M tokens in BigInt, and the guard compares those
// integers against the cap. A float appears only for display. A record with
// null token counts on a priced provider is "no data": it is reported in
// unknownWorkItemIds and refuses the session instead of silently counting
// zero.
import type { UsageRecord } from "../../contracts/v1/types.js";
import type { NanoPricing } from "./pricing.js";

export interface SpendSummary {
  readonly spentTodayNanoUsd: bigint;
  readonly spentTotalNanoUsd: bigint;
  readonly nvidiaRequestsToday: number;
  readonly unknownWorkItemIds: readonly string[];
}

export class SpendUnknownError extends Error {
  readonly workItemId: string;
  constructor(workItemId: string) {
    super(`Budget spend unknown: record ${workItemId} has null token counts on a priced provider`);
    this.name = "SpendUnknownError";
    this.workItemId = workItemId;
  }
}

const TOKENS_PER_1M = 1_000_000n;

export function isPriced(pricing: NanoPricing): boolean {
  return (
    pricing.inputNanoPer1M > 0n ||
    pricing.outputNanoPer1M > 0n ||
    (pricing.cachedInputNanoPer1M ?? 0n) > 0n
  );
}

export function utcCalendarDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDayOfRecord(record: UsageRecord): string {
  return utcCalendarDay(new Date(record.finishedAt));
}

export function costOfRecord(
  record: UsageRecord,
  pricing: ReadonlyMap<string, NanoPricing>,
): bigint {
  let cost = 0n;
  for (const entry of record.tokens) {
    const providerPricing = pricing.get(entry.provider);
    if (providerPricing === undefined) {
      throw new Error(
        `Budget cost: unknown provider "${entry.provider}" in record ${record.workItemId}`,
      );
    }
    if (!isPriced(providerPricing)) {
      continue;
    }
    if (entry.inputTokens === null || entry.outputTokens === null) {
      throw new SpendUnknownError(record.workItemId);
    }
    cost +=
      (BigInt(entry.inputTokens) * providerPricing.inputNanoPer1M +
        BigInt(entry.outputTokens) * providerPricing.outputNanoPer1M) /
      TOKENS_PER_1M;
  }
  return cost;
}

export function summarizeSpend(
  records: readonly UsageRecord[],
  pricing: ReadonlyMap<string, NanoPricing>,
  nvidiaProviderId: string,
  now: Date,
): SpendSummary {
  const today = utcCalendarDay(now);
  let spentTodayNanoUsd = 0n;
  let spentTotalNanoUsd = 0n;
  let nvidiaRequestsToday = 0;
  const unknownWorkItemIds: string[] = [];
  for (const record of records) {
    // Request counts are data, not cost: they are tallied before pricing
    // so a spend-unknown record still reports its NVIDIA requests.
    if (utcDayOfRecord(record) === today) {
      for (const entry of record.tokens) {
        if (entry.provider === nvidiaProviderId) {
          nvidiaRequestsToday += entry.requests;
        }
      }
    }
    let cost: bigint;
    try {
      cost = costOfRecord(record, pricing);
    } catch (error: unknown) {
      if (error instanceof SpendUnknownError) {
        unknownWorkItemIds.push(record.workItemId);
        continue;
      }
      throw error;
    }
    spentTotalNanoUsd += cost;
    if (utcDayOfRecord(record) === today) {
      spentTodayNanoUsd += cost;
    }
  }
  return { spentTodayNanoUsd, spentTotalNanoUsd, nvidiaRequestsToday, unknownWorkItemIds };
}

/** Float dollars for display only; decisions never use this value. */
export function nanoUsdToDisplayDollars(nanoUsd: bigint): number {
  return Number(nanoUsd) / 1_000_000_000;
}

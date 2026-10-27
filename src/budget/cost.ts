// Spend math for the budget guard. Cost comes only from the configured
// provider prices. A record with null token counts on a priced provider is
// "no data": it is reported in unknownWorkItemIds and refuses the session
// instead of silently counting zero.
import type { UsageRecord } from "../../contracts/v1/types.js";
import type { ProviderPricing } from "../providers/types.js";

export interface SpendSummary {
  readonly spentTodayUsd: number;
  readonly spentTotalUsd: number;
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

const PER_1M = 1_000_000;

function isPriced(pricing: ProviderPricing): boolean {
  return pricing.inputPer1M > 0 || pricing.outputPer1M > 0 || (pricing.cachedInputPer1M ?? 0) > 0;
}

export function utcCalendarDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDayOfRecord(record: UsageRecord): string {
  return utcCalendarDay(new Date(record.finishedAt));
}

export function costOfRecord(
  record: UsageRecord,
  pricing: ReadonlyMap<string, ProviderPricing>,
): number {
  let cost = 0;
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
      (entry.inputTokens * providerPricing.inputPer1M +
        entry.outputTokens * providerPricing.outputPer1M) /
      PER_1M;
  }
  return cost;
}

export function summarizeSpend(
  records: readonly UsageRecord[],
  pricing: ReadonlyMap<string, ProviderPricing>,
  nvidiaProviderId: string,
  now: Date,
): SpendSummary {
  const today = utcCalendarDay(now);
  let spentTodayUsd = 0;
  let spentTotalUsd = 0;
  let nvidiaRequestsToday = 0;
  const unknownWorkItemIds: string[] = [];
  for (const record of records) {
    let cost: number;
    try {
      cost = costOfRecord(record, pricing);
    } catch (error: unknown) {
      if (error instanceof SpendUnknownError) {
        unknownWorkItemIds.push(record.workItemId);
        continue;
      }
      throw error;
    }
    spentTotalUsd += cost;
    if (utcDayOfRecord(record) === today) {
      spentTodayUsd += cost;
      for (const entry of record.tokens) {
        if (entry.provider === nvidiaProviderId) {
          nvidiaRequestsToday += entry.requests;
        }
      }
    }
  }
  return { spentTodayUsd, spentTotalUsd, nvidiaRequestsToday, unknownWorkItemIds };
}

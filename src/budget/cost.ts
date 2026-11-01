// Spend math for the budget guard. Money is exact: cost is summed as
// integer nano-USD per 1M tokens in BigInt, and the guard compares those
// integers against the cap. A float appears only for display. A record with
// null token counts on a priced provider is "no data": it is reported in
// unknownWorkItemIds and refuses the session instead of silently counting
// zero, except an unmeasured audit call, which counts at the configured
// bound (isBoundedAuditToken). A known-count entry with unmeasuredRequests
// adds the meter-call bound of its provider's pool per unmeasured call
// (bounded, not unknown).
import { AUDITOR_USAGE_SOURCE, type SpendEntry } from "../ledger/types.js";
import type { NanoPricing } from "./pricing.js";

/** Per-call token ceiling for a call that may be billed but reported no usage. */
export interface UnmeasuredCallBound {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SpendBounds {
  /** Audit call that may be billed but reported no usage (auditor-usage, null counts). */
  readonly auditCall: UnmeasuredCallBound;
  /** Metered call that was billed but reported no usage (unmeasuredRequests). */
  readonly meterCall: UnmeasuredCallBound;
  /** The meterCall bound of a named budget pool, by provider id. */
  readonly meterCallByProvider: ReadonlyMap<string, UnmeasuredCallBound>;
}

// An audit call that timed out or returned an unreadable 200 may be billed with
// no usage reported. Its prompt is capped by the auditor's maxDiffBytes, so its
// spend is bounded: it counts at the configured per-call ceiling, not as unknown.
export function isBoundedAuditToken(token: SpendEntry["tokens"][number]): boolean {
  return (
    token.source === AUDITOR_USAGE_SOURCE &&
    (token.inputTokens === null || token.outputTokens === null) &&
    token.requests !== null
  );
}

export interface SpendSummary {
  readonly spentTodayNanoUsd: bigint;
  readonly spentTotalNanoUsd: bigint;
  /** Undivided scope sums: tokens * priceNanoPer1M. Decisions compare these
      against capNano * 1_000_000n; the nano fields above divide once only
      for display. */
  readonly spentTodayNanoTimes1M: bigint;
  readonly spentTotalNanoTimes1M: bigint;
  readonly nvidiaRequestsToday: number;
  readonly unknownWorkItemIds: readonly string[];
  readonly boundedWorkItemIds: readonly string[];
  /** Sorted ids of bounded items with at least one bounded entry finished today. */
  readonly boundedTodayWorkItemIds: readonly string[];
}

export class SpendUnknownError extends Error {
  readonly workItemId: string;
  constructor(workItemId: string) {
    super(`Budget spend unknown: record ${workItemId} has null token counts on a priced provider`);
    this.name = "SpendUnknownError";
    this.workItemId = workItemId;
  }
}

export const TOKENS_PER_1M = 1_000_000n;

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

function utcDayOfEntry(entry: SpendEntry): string {
  return utcCalendarDay(new Date(entry.finishedAt));
}

export function costOfRecord(
  record: SpendEntry,
  pricing: ReadonlyMap<string, NanoPricing>,
  bounds: SpendBounds,
): bigint {
  return costOfRecordNanoTimes1M(record, pricing, bounds) / TOKENS_PER_1M;
}

/** Undivided record cost: tokens * priceNanoPer1M, for scope accumulation. */
function costOfRecordNanoTimes1M(
  record: SpendEntry,
  pricing: ReadonlyMap<string, NanoPricing>,
  bounds: SpendBounds,
  onBounded?: () => void,
): bigint {
  let costNanoTimes1M = 0n;
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
      if (!isBoundedAuditToken(entry)) {
        throw new SpendUnknownError(record.workItemId);
      }
      const requests = BigInt(entry.requests as number);
      const input =
        entry.inputTokens === null
          ? BigInt(bounds.auditCall.inputTokens) * requests
          : BigInt(entry.inputTokens);
      const output =
        entry.outputTokens === null
          ? BigInt(bounds.auditCall.outputTokens) * requests
          : BigInt(entry.outputTokens);
      costNanoTimes1M +=
        input * providerPricing.inputNanoPer1M + output * providerPricing.outputNanoPer1M;
      onBounded?.();
      continue;
    }
    let cost =
      BigInt(entry.inputTokens) * providerPricing.inputNanoPer1M +
      BigInt(entry.outputTokens) * providerPricing.outputNanoPer1M;
    const unmeasured = entry.unmeasuredRequests ?? 0;
    if (unmeasured > 0) {
      // Each billed call without usage counts at its pool's per-call
      // ceiling; the loop checks its input side at startup (compose.ts).
      const meterCall = bounds.meterCallByProvider.get(entry.provider) ?? bounds.meterCall;
      cost +=
        BigInt(unmeasured) *
        (BigInt(meterCall.inputTokens) * providerPricing.inputNanoPer1M +
          BigInt(meterCall.outputTokens) * providerPricing.outputNanoPer1M);
      onBounded?.();
    }
    costNanoTimes1M += cost;
  }
  return costNanoTimes1M;
}

/** The entries with only the token rows whose provider passes `keep`. */
export function entriesOfProviders(
  records: readonly SpendEntry[],
  keep: (providerId: string) => boolean,
): SpendEntry[] {
  return records.map((record) => ({
    ...record,
    tokens: record.tokens.filter((token) => keep(token.provider)),
  }));
}

export function summarizeSpend(
  records: readonly SpendEntry[],
  pricing: ReadonlyMap<string, NanoPricing>,
  nvidiaProviderId: string,
  now: Date,
  bounds: SpendBounds,
): SpendSummary {
  const today = utcCalendarDay(now);
  let spentTodayNanoTimes1M = 0n;
  let spentTotalNanoTimes1M = 0n;
  let nvidiaRequestsToday = 0;
  const unknownWorkItemIds: string[] = [];
  const boundedWorkItemIds: string[] = [];
  const boundedTodayWorkItemIds: string[] = [];
  for (const record of records) {
    // Request counts are data, not cost: they are tallied before pricing
    // so a spend-unknown record still reports its NVIDIA requests. A null
    // request count on the NVIDIA provider is unknown, not zero.
    if (utcDayOfEntry(record) === today) {
      for (const entry of record.tokens) {
        if (entry.provider === nvidiaProviderId) {
          if (entry.requests === null) {
            if (!unknownWorkItemIds.includes(record.workItemId)) {
              unknownWorkItemIds.push(record.workItemId);
            }
          } else {
            nvidiaRequestsToday += entry.requests;
          }
        }
      }
    }
    let costNanoTimes1M: bigint;
    try {
      const seen: { bounded: boolean } = { bounded: false };
      costNanoTimes1M = costOfRecordNanoTimes1M(record, pricing, bounds, () => {
        seen.bounded = true;
      });
      if (seen.bounded) {
        if (!boundedWorkItemIds.includes(record.workItemId)) {
          boundedWorkItemIds.push(record.workItemId);
        }
        // One record finishes on one day, so a bounded record finished
        // today is a bounded entry in the today window.
        if (
          utcDayOfEntry(record) === today &&
          !boundedTodayWorkItemIds.includes(record.workItemId)
        ) {
          boundedTodayWorkItemIds.push(record.workItemId);
        }
      }
    } catch (error: unknown) {
      if (error instanceof SpendUnknownError) {
        if (!unknownWorkItemIds.includes(record.workItemId)) {
          unknownWorkItemIds.push(record.workItemId);
        }
        continue;
      }
      throw error;
    }
    spentTotalNanoTimes1M += costNanoTimes1M;
    if (utcDayOfEntry(record) === today) {
      spentTodayNanoTimes1M += costNanoTimes1M;
    }
  }
  return {
    spentTodayNanoUsd: spentTodayNanoTimes1M / TOKENS_PER_1M,
    spentTotalNanoUsd: spentTotalNanoTimes1M / TOKENS_PER_1M,
    spentTodayNanoTimes1M,
    spentTotalNanoTimes1M,
    nvidiaRequestsToday,
    unknownWorkItemIds,
    boundedWorkItemIds,
    boundedTodayWorkItemIds: boundedTodayWorkItemIds.sort(),
  };
}

/** Float dollars for display only; decisions never use this value. */
export function nanoUsdToDisplayDollars(nanoUsd: bigint): number {
  return Number(nanoUsd) / 1_000_000_000;
}

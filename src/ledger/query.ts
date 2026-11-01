// Ledger query: pure aggregation over records for the dashboard. Pending
// entries are counted in pendingEntries and never mixed into the breakdowns.
import type { UsageRecord } from "../../contracts/v1/types.js";
import type { LedgerContents } from "./types.js";

export type QueryDimension = "provider" | "host" | "model";

export interface ProviderRow {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
  readonly sources: readonly string[];
}

export interface ProviderCoverage {
  readonly measured: number;
  readonly total: number;
  readonly note: string | null;
  readonly emptyReason: string | null;
}

export interface HostRow {
  readonly hostAlias: string;
  readonly seconds: number;
  readonly hours: string;
  readonly sources: readonly string[];
}

export interface ModelRow {
  readonly model: string;
  readonly attempts: number;
  readonly successes: number;
  readonly successRate: string | null;
}

export interface LedgerQueryResult {
  readonly records: number;
  readonly pendingEntries: number;
  readonly byProvider?: readonly ProviderRow[];
  readonly byHost?: readonly HostRow[];
  readonly byModel?: readonly ModelRow[];
  readonly providerCoverage?: ProviderCoverage;
}

function idsHave(ids: readonly string[], what: string): string {
  return `${ids.join(", ")} ${ids.length === 1 ? "has" : "have"} ${what}`;
}

// The token figures cover the records with full token counts: every token
// row reports both counts and has no calls without usage. Excluded records
// add nothing and are named in the note; no count is invented for them.
export function providerCoverageOf(records: readonly UsageRecord[]): {
  readonly measured: readonly UsageRecord[];
  readonly coverage: ProviderCoverage;
} {
  const nullIds = new Set<string>();
  const unmeasuredIds = new Set<string>();
  const measured: UsageRecord[] = [];
  for (const record of records) {
    if (record.tokens.some((token) => token.inputTokens === null || token.outputTokens === null)) {
      nullIds.add(record.workItemId);
    } else if (record.tokens.some((token) => token.unmeasuredRequests !== undefined)) {
      unmeasuredIds.add(record.workItemId);
    } else {
      measured.push(record);
    }
  }
  if (measured.length === records.length) {
    return {
      measured,
      coverage: { measured: measured.length, total: records.length, note: null, emptyReason: null },
    };
  }
  const nulls = [...nullIds].sort();
  const unmeasured = [...unmeasuredIds].sort();
  if (measured.length === 0) {
    const reasons = [
      nulls.length === 0 ? "" : `token counts not reported for ${nulls.join(", ")}`,
      unmeasured.length === 0 ? "" : `calls without usage for ${unmeasured.join(", ")}`,
    ].filter((reason) => reason !== "");
    return {
      measured,
      coverage: { measured: 0, total: records.length, note: null, emptyReason: reasons.join("; ") },
    };
  }
  const excluded = [
    nulls.length === 0 ? "" : idsHave(nulls, "no token counts"),
    unmeasured.length === 0 ? "" : idsHave(unmeasured, "calls without usage"),
  ].filter((reason) => reason !== "");
  return {
    measured,
    coverage: {
      measured: measured.length,
      total: records.length,
      note: `over ${String(measured.length)} of ${String(records.length)} records; ${excluded.join("; ")}`,
      emptyReason: null,
    },
  };
}

function orderStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function queryByProvider(records: readonly UsageRecord[]): {
  readonly rows: readonly ProviderRow[];
  readonly coverage: ProviderCoverage;
} {
  const { measured, coverage } = providerCoverageOf(records);
  const order: string[] = [];
  const groups = new Map<
    string,
    {
      provider: string;
      model: string;
      inputs: number[];
      outputs: number[];
      requests: number;
      sources: Set<string>;
    }
  >();
  for (const record of measured) {
    for (const token of record.tokens) {
      const key = JSON.stringify([token.provider, token.model]);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          provider: token.provider,
          model: token.model,
          inputs: [],
          outputs: [],
          requests: 0,
          sources: new Set<string>(),
        };
        groups.set(key, group);
        order.push(key);
      }
      // Measured records have non-null counts by definition.
      group.inputs.push(token.inputTokens as number);
      group.outputs.push(token.outputTokens as number);
      group.requests += token.requests;
      group.sources.add(token.source);
    }
  }
  const rows = order.map((key) => {
    const group = groups.get(key);
    if (group === undefined) {
      throw new Error(`ledger query: missing provider group ${key}`);
    }
    const inputTokens = group.inputs.reduce((sum, value) => sum + value, 0);
    const outputTokens = group.outputs.reduce((sum, value) => sum + value, 0);
    return {
      provider: group.provider,
      model: group.model,
      inputTokens,
      outputTokens,
      requests: group.requests,
      sources: orderStrings(group.sources),
    };
  });
  rows.sort((a, b) =>
    a.provider === b.provider
      ? a.model < b.model
        ? -1
        : a.model > b.model
          ? 1
          : 0
      : a.provider < b.provider
        ? -1
        : 1,
  );
  return { rows, coverage };
}

function queryByHost(records: readonly UsageRecord[]): readonly HostRow[] {
  const groups = new Map<string, { seconds: number; sources: Set<string> }>();
  for (const record of records) {
    for (const entry of record.sessionSeconds) {
      let group = groups.get(entry.hostAlias);
      if (group === undefined) {
        group = { seconds: 0, sources: new Set<string>() };
        groups.set(entry.hostAlias, group);
      }
      group.seconds += entry.seconds;
      group.sources.add(entry.source);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([hostAlias, group]) => ({
      hostAlias,
      seconds: group.seconds,
      hours: (group.seconds / 3600).toFixed(2),
      sources: orderStrings(group.sources),
    }));
}

function queryByModel(records: readonly UsageRecord[]): readonly ModelRow[] {
  const groups = new Map<string, { attempts: number; successes: number }>();
  for (const record of records) {
    for (const attempt of record.attempts) {
      let group = groups.get(attempt.model);
      if (group === undefined) {
        group = { attempts: 0, successes: 0 };
        groups.set(attempt.model, group);
      }
      group.attempts += 1;
      if (attempt.result === "success") {
        group.successes += 1;
      }
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([model, group]) => ({
      model,
      attempts: group.attempts,
      successes: group.successes,
      successRate: group.attempts === 0 ? null : (group.successes / group.attempts).toFixed(4),
    }));
}

export function queryLedger(
  contents: LedgerContents,
  by: ReadonlySet<QueryDimension>,
): LedgerQueryResult {
  const result: {
    records: number;
    pendingEntries: number;
    byProvider?: readonly ProviderRow[];
    byHost?: readonly HostRow[];
    byModel?: readonly ModelRow[];
    providerCoverage?: ProviderCoverage;
  } = {
    records: contents.records.length,
    pendingEntries: contents.pending.length,
  };
  if (by.has("provider")) {
    const provider = queryByProvider(contents.records);
    result.byProvider = provider.rows;
    result.providerCoverage = provider.coverage;
  }
  if (by.has("host")) {
    result.byHost = queryByHost(contents.records);
  }
  if (by.has("model")) {
    result.byModel = queryByModel(contents.records);
  }
  return result;
}

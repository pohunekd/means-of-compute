// Ledger query: pure aggregation over records for the dashboard. Pending
// entries are counted in pendingEntries and never mixed into the breakdowns.
import type { UsageRecord } from "../../contracts/v1/types.js";
import type { LedgerContents } from "./types.js";

export type QueryDimension = "provider" | "host" | "model";

export interface ProviderRow {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly requests: number;
  readonly sources: readonly string[];
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
}

function nullSum(values: readonly (number | null)[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    sum += value;
  }
  return sum;
}

function orderStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function queryByProvider(records: readonly UsageRecord[]): readonly ProviderRow[] {
  const order: string[] = [];
  const groups = new Map<
    string,
    {
      provider: string;
      model: string;
      inputs: (number | null)[];
      outputs: (number | null)[];
      requests: number;
      sources: Set<string>;
    }
  >();
  for (const record of records) {
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
      group.inputs.push(token.inputTokens);
      group.outputs.push(token.outputTokens);
      group.requests += token.requests;
      group.sources.add(token.source);
    }
  }
  const rows = order.map((key) => {
    const group = groups.get(key);
    if (group === undefined) {
      throw new Error(`ledger query: missing provider group ${key}`);
    }
    return {
      provider: group.provider,
      model: group.model,
      inputTokens: nullSum(group.inputs),
      outputTokens: nullSum(group.outputs),
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
  return rows;
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
  } = {
    records: contents.records.length,
    pendingEntries: contents.pending.length,
  };
  if (by.has("provider")) {
    result.byProvider = queryByProvider(contents.records);
  }
  if (by.has("host")) {
    result.byHost = queryByHost(contents.records);
  }
  if (by.has("model")) {
    result.byModel = queryByModel(contents.records);
  }
  return result;
}

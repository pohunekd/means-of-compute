// Ledger store: every write takes the lock, reads the file, applies a pure
// fold, and persists the whole file with one atomic write.
import { isUsageRecord } from "../../contracts/v1/validate.js";
import type { UsageRecord } from "../../contracts/v1/types.js";
import { writeFileAtomic } from "../fs/write.js";
import { withLedgerLock } from "./lock.js";
import { readLedger } from "./read.js";
import { LedgerDataError, LedgerRefusal } from "./errors.js";
import { isPendingUsage, pendingReason } from "./validate.js";
import type {
  FinalizeInput,
  LedgerContents,
  PendingTokenUsage,
  PendingUsage,
  WriteOutcome,
} from "./types.js";

export { LedgerDataError, LedgerRefusal } from "./errors.js";

const WORK_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function isRecordId(value: unknown): value is string {
  return typeof value === "string" && WORK_ITEM_ID_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkFinalizeInput(input: FinalizeInput): void {
  if (!isRecordId(input.workItemId)) {
    throw new LedgerDataError(`ledger: invalid workItemId ${JSON.stringify(input.workItemId)}`);
  }
  if (input.result !== "success" && input.result !== "blocked") {
    throw new LedgerDataError(`ledger: invalid result ${JSON.stringify(input.result)}`);
  }
  if (!isNonNegativeInteger(input.retries)) {
    throw new LedgerDataError(`ledger: invalid retries ${JSON.stringify(input.retries)}`);
  }
  if (!isNonNegativeInteger(input.humanInterventions)) {
    throw new LedgerDataError(
      `ledger: invalid humanInterventions ${JSON.stringify(input.humanInterventions)}`,
    );
  }
}

const TOKEN_KEY_SEP = "^@";

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

function foldTokens(
  existing: UsageRecord["tokens"] | null,
  pending: readonly PendingUsage[],
): UsageRecord["tokens"] {
  const order: string[] = [];
  const groups = new Map<
    string,
    {
      provider: string;
      model: string;
      source: string;
      inputs: (number | null)[];
      outputs: (number | null)[];
      requests: number[];
    }
  >();
  const collect = (token: PendingTokenUsage): void => {
    if (token.requests === null) {
      throw new LedgerDataError("ledger: cannot fold pending entry with unknown requests");
    }
    const key = `${token.provider}${TOKEN_KEY_SEP}${token.model}${TOKEN_KEY_SEP}${token.source}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        provider: token.provider,
        model: token.model,
        source: token.source,
        inputs: [],
        outputs: [],
        requests: [],
      };
      groups.set(key, group);
      order.push(key);
    }
    group.inputs.push(token.inputTokens);
    group.outputs.push(token.outputTokens);
    group.requests.push(token.requests);
  };
  if (existing !== null) {
    for (const token of existing) {
      collect(token);
    }
  }
  for (const entry of pending) {
    for (const token of entry.tokens) {
      collect(token);
    }
  }
  return order.map((key) => {
    const group = groups.get(key);
    if (group === undefined) {
      throw new Error(`ledger: missing token group ${key}`);
    }
    let requests = 0;
    for (const value of group.requests) {
      requests += value;
    }
    return {
      provider: group.provider,
      model: group.model,
      inputTokens: nullSum(group.inputs),
      outputTokens: nullSum(group.outputs),
      requests,
      source: group.source,
    };
  });
}

function foldSessions(
  existing: UsageRecord["sessionSeconds"] | null,
  pending: readonly PendingUsage[],
): UsageRecord["sessionSeconds"] {
  const order: string[] = [];
  const groups = new Map<string, { hostAlias: string; source: string; seconds: number }>();
  const collect = (hostAlias: string, source: string, seconds: number): void => {
    const key = `${hostAlias}${TOKEN_KEY_SEP}${source}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { hostAlias, source, seconds });
      order.push(key);
    } else {
      group.seconds += seconds;
    }
  };
  if (existing !== null) {
    for (const entry of existing) {
      collect(entry.hostAlias, entry.source, entry.seconds);
    }
  }
  for (const entry of pending) {
    if (entry.kind === "session" && entry.session !== null) {
      collect(entry.session.hostAlias, entry.session.source, entry.session.seconds);
    }
  }
  return order.map((key) => {
    const group = groups.get(key);
    if (group === undefined) {
      throw new Error(`ledger: missing session group ${key}`);
    }
    return { hostAlias: group.hostAlias, seconds: group.seconds, source: group.source };
  });
}

function maxFinishedAt(existing: string | null, pending: readonly PendingUsage[]): string {
  let max = existing === null ? Number.NEGATIVE_INFINITY : Date.parse(existing);
  for (const entry of pending) {
    const at = Date.parse(entry.finishedAt);
    if (at > max) {
      max = at;
    }
  }
  return new Date(max).toISOString();
}

export function foldRecord(
  existing: UsageRecord | null,
  pending: readonly PendingUsage[],
  input: FinalizeInput,
): UsageRecord {
  const attempts: UsageRecord["attempts"] = [
    ...(existing === null ? [] : existing.attempts),
    ...pending.flatMap((entry) =>
      entry.kind === "session" && entry.session !== null
        ? [{ model: entry.startModel, result: entry.session.result }]
        : [],
    ),
  ];
  return {
    schemaVersion: "v1",
    workItemId: input.workItemId,
    finishedAt: maxFinishedAt(existing === null ? null : existing.finishedAt, pending),
    tokens: foldTokens(existing === null ? null : existing.tokens, pending),
    sessionSeconds: foldSessions(existing === null ? null : existing.sessionSeconds, pending),
    attempts,
    retries: input.retries,
    humanInterventions: input.humanInterventions,
    result: input.result,
  };
}

function serialize(contents: LedgerContents): string {
  const lines: string[] = [];
  for (const record of contents.records) {
    lines.push(JSON.stringify(record));
  }
  for (const entry of contents.pending) {
    lines.push(JSON.stringify({ pending: entry }));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export async function appendPending(
  ledgerPath: string,
  entry: PendingUsage,
): Promise<WriteOutcome> {
  if (!isPendingUsage(entry)) {
    throw new LedgerDataError(
      `ledger ${ledgerPath}: invalid pending entry ${pendingReason(entry)}`,
    );
  }
  return withLedgerLock(ledgerPath, async () => {
    const contents = await readLedger("Budget ledger", ledgerPath);
    const same = contents.pending.find((item) => item.entryId === entry.entryId);
    if (same !== undefined) {
      if (Bun.deepEquals(same, entry, true)) {
        return "unchanged";
      }
      throw new LedgerDataError(
        `ledger ${ledgerPath}: pending entry ${entry.entryId} exists with different content`,
      );
    }
    const next: LedgerContents = {
      records: contents.records,
      pending: [...contents.pending, entry],
    };
    await writeFileAtomic("Budget ledger", ledgerPath, serialize(next));
    return "appended";
  });
}

export async function finalizeUsage(
  ledgerPath: string,
  input: FinalizeInput,
): Promise<WriteOutcome> {
  checkFinalizeInput(input);
  return withLedgerLock(ledgerPath, async () => {
    const contents = await readLedger("Budget ledger", ledgerPath);
    const record = contents.records.find((item) => item.workItemId === input.workItemId) ?? null;
    const pending = contents.pending.filter((item) => item.workItemId === input.workItemId);
    if (record !== null) {
      if (input.retries < record.retries || input.humanInterventions < record.humanInterventions) {
        throw new LedgerDataError(
          `ledger ${ledgerPath}: counters must not decrease for ${input.workItemId}`,
        );
      }
    }
    if (pending.length === 0) {
      if (record === null) {
        throw new LedgerRefusal(`no usage recorded for ${input.workItemId}`);
      }
      const next = {
        ...record,
        result: input.result,
        retries: input.retries,
        humanInterventions: input.humanInterventions,
      };
      if (Bun.deepEquals(next, record, true)) {
        return "unchanged";
      }
      if (!isUsageRecord(next)) {
        throw new LedgerDataError(
          `ledger ${ledgerPath}: updated record is not a valid UsageRecord`,
        );
      }
      const records = contents.records.map((item) =>
        item.workItemId === input.workItemId ? next : item,
      );
      await writeFileAtomic(
        "Budget ledger",
        ledgerPath,
        serialize({ records, pending: contents.pending }),
      );
      return "updated";
    }
    if (!pending.some((entry) => entry.kind === "session") && record === null) {
      throw new LedgerRefusal(`no session usage for ${input.workItemId}`);
    }
    const unknownEntries = pending.filter((entry) =>
      entry.tokens.some((token) => token.requests === null),
    );
    if (unknownEntries.length > 0) {
      const ids = unknownEntries.map((entry) => entry.entryId).join(",");
      throw new LedgerRefusal(`usage unknown for ${input.workItemId}: ${ids}`);
    }
    const next = foldRecord(record, pending, input);
    if (!isUsageRecord(next)) {
      throw new LedgerDataError(`ledger ${ledgerPath}: folded record is not a valid UsageRecord`);
    }
    const keptPending = contents.pending.filter((item) => item.workItemId !== input.workItemId);
    const records =
      record === null
        ? [...contents.records, next]
        : contents.records.map((item) => (item.workItemId === input.workItemId ? next : item));
    await writeFileAtomic(
      "Budget ledger",
      ledgerPath,
      serialize({ records, pending: keptPending }),
    );
    return record === null ? "appended" : "updated";
  });
}

// Ledger reader: one UsageRecord line per finished task, one {"pending"}
// line per unfinalized session or audit. Record lines come first, pending
// lines follow. Errors name the label, path and line number and exit 2;
// nothing is ever skipped or defaulted.
import { contractErrors, isUsageRecord } from "../../contracts/v1/validate.js";
import type { UsageRecord } from "../../contracts/v1/types.js";
import { readInputText, statInputPath } from "../fs/input.js";
import { LedgerDataError } from "./errors.js";
import { isPendingUsage, pendingReason } from "./validate.js";
import type { LedgerContents, PendingUsage, SpendEntry } from "./types.js";
import { AUDITOR_USAGE_SOURCE } from "./types.js";

export const LEDGER_CONFIG_PATH = "config/ledger.json";

interface ParsedLine {
  readonly record: UsageRecord | null;
  readonly pending: PendingUsage | null;
}

function parseRecord(
  label: string,
  ledgerPath: string,
  lineNumber: number,
  raw: unknown,
  text: string,
): UsageRecord {
  if (!isUsageRecord(raw)) {
    throw new LedgerDataError(
      `${label} ${ledgerPath} line ${String(lineNumber)}: invalid UsageRecord ${JSON.stringify(contractErrors("usage-record", raw))} in ${text}`,
    );
  }
  return raw;
}

function parsePendingEntry(
  label: string,
  ledgerPath: string,
  lineNumber: number,
  raw: unknown,
  text: string,
): PendingUsage {
  const record = raw as Record<string, unknown>;
  if (!isPendingUsage(record.pending)) {
    throw new LedgerDataError(
      `${label} ${ledgerPath} line ${String(lineNumber)}: invalid pending entry ${pendingReason(record.pending)} in ${text}`,
    );
  }
  return record.pending;
}

function parseLine(
  label: string,
  ledgerPath: string,
  lineNumber: number,
  text: string,
): ParsedLine {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new LedgerDataError(
      `${label} ${ledgerPath} line ${String(lineNumber)}: not valid JSON`,
    );
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    if (keys.length === 1 && keys[0] === "pending") {
      return { record: null, pending: parsePendingEntry(label, ledgerPath, lineNumber, raw, text) };
    }
  }
  return { record: parseRecord(label, ledgerPath, lineNumber, raw, text), pending: null };
}

export async function readLedger(label: string, ledgerPath: string): Promise<LedgerContents> {
  if ((await statInputPath(label, ledgerPath)) === "absent") {
    return { records: [], pending: [] };
  }
  const text = await readInputText(label, ledgerPath);
  if (text === "") {
    return { records: [], pending: [] };
  }
  if (!text.endsWith("\n")) {
    throw new LedgerDataError(`${label} ${ledgerPath}: last line is not terminated`);
  }
  const lines = text.split("\n");
  lines.pop();
  const records: UsageRecord[] = [];
  const pending: PendingUsage[] = [];
  const recordLines = new Map<string, number>();
  const pendingLines = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const lineNumber = index + 1;
    if (line === "") {
      throw new LedgerDataError(
        `${label} ${ledgerPath} line ${String(lineNumber)}: empty line`,
      );
    }
    const parsed = parseLine(label, ledgerPath, lineNumber, line);
    if (parsed.record !== null) {
      const first = recordLines.get(parsed.record.workItemId);
      if (first !== undefined) {
        throw new LedgerDataError(
          `${label} ${ledgerPath}: duplicate record workItemId ${parsed.record.workItemId} on lines ${String(first)} and ${String(lineNumber)}`,
        );
      }
      recordLines.set(parsed.record.workItemId, lineNumber);
      records.push(parsed.record);
      continue;
    }
    const entry = parsed.pending as PendingUsage;
    const first = pendingLines.get(entry.entryId);
    if (first !== undefined) {
      throw new LedgerDataError(
        `${label} ${ledgerPath}: duplicate pending entryId ${entry.entryId} on lines ${String(first)} and ${String(lineNumber)}`,
      );
    }
    pendingLines.set(entry.entryId, lineNumber);
    pending.push(entry);
  }
  return { records, pending };
}

export function spendEntriesOf(contents: LedgerContents): readonly SpendEntry[] {
  const entries: SpendEntry[] = contents.records.map((record) => ({
    workItemId: record.workItemId,
    finishedAt: record.finishedAt,
    tokens: record.tokens.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      requests: entry.requests,
      source: entry.source,
    })),
  }));
  for (const entry of contents.pending) {
    entries.push({
      workItemId: entry.workItemId,
      finishedAt: entry.finishedAt,
      tokens: entry.tokens.map((token) => ({
        provider: token.provider,
        model: token.model,
        inputTokens: token.inputTokens,
        outputTokens: token.outputTokens,
        requests: token.requests,
        source: token.source,
      })),
    });
  }
  return entries;
}

export function authorModelsOf(contents: LedgerContents, workItemId: string): readonly string[] {
  const models = new Set<string>();
  for (const entry of contents.pending) {
    if (entry.kind !== "session" || entry.workItemId !== workItemId) {
      continue;
    }
    models.add(entry.startModel);
    for (const token of entry.tokens) {
      models.add(token.model);
    }
  }
  for (const record of contents.records) {
    if (record.workItemId !== workItemId) {
      continue;
    }
    for (const attempt of record.attempts) {
      models.add(attempt.model);
    }
    for (const token of record.tokens) {
      if (token.source !== AUDITOR_USAGE_SOURCE) {
        models.add(token.model);
      }
    }
  }
  return [...models].sort();
}

export async function loadLedgerConfig(
  path: string = LEDGER_CONFIG_PATH,
): Promise<{ readonly ledgerPath: string }> {
  const label = "Ledger config";
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} ${path}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} ${path}: must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.ledgerPath !== "string") {
    throw new Error(
      `${label} ${path}: exactly one key "ledgerPath" with a non-empty string is required`,
    );
  }
  if (record.ledgerPath.length === 0) {
    throw new Error(
      `${label} ${path}: exactly one key "ledgerPath" with a non-empty string is required`,
    );
  }
  return { ledgerPath: record.ledgerPath };
}

// CLI entry points for the ledger: bun run ledger:record and
// bun run ledger:query. Record appends pending entries and finalizes one
// task; query aggregates records without taking the lock or writing.
import { isUsageRecord } from "../../contracts/v1/validate.js";
import { readInputText, statInputPath } from "../fs/input.js";
import { LedgerDataError, LedgerRefusal } from "./errors.js";
import { queryLedger, type QueryDimension } from "./query.js";
import { readLedger } from "./read.js";
import { appendPending, finalizeUsage } from "./store.js";
import type { FinalizeInput, PendingUsage } from "./types.js";
import { isPendingUsage, pendingReason } from "./validate.js";

const DIMENSIONS: readonly QueryDimension[] = ["provider", "host", "model"];
const WORK_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function takeFlags(args: string[], allowed: readonly string[]): Map<string, string> {
  const seen = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    if (!flag.startsWith("--")) {
      throw new Error(`ledger: unexpected argument ${JSON.stringify(flag)}`);
    }
    if (!allowed.includes(flag)) {
      throw new Error(`ledger: unknown flag ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`ledger: repeated flag ${flag}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`ledger: ${flag} needs a value`);
    }
    seen.set(flag, value);
    index += 1;
  }
  return seen;
}

function requiredFlag(flags: Map<string, string>, flag: string): string {
  const value = flags.get(flag);
  if (value === undefined) {
    throw new Error(`ledger: ${flag} is required`);
  }
  return value;
}

interface CompletionFile {
  readonly pending: readonly PendingUsage[];
  readonly finalize: FinalizeInput;
}

function readFinalize(label: string, value: unknown): FinalizeInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: "finalize" must be an object`);
  }
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "humanInterventions" ||
    keys[1] !== "result" ||
    keys[2] !== "retries" ||
    keys[3] !== "workItemId"
  ) {
    throw new Error(
      `${label}: "finalize" must hold exactly workItemId, result, retries, humanInterventions`,
    );
  }
  if (typeof entry.workItemId !== "string" || !WORK_ITEM_ID_PATTERN.test(entry.workItemId)) {
    throw new Error(`${label}: invalid finalize workItemId ${JSON.stringify(entry.workItemId)}`);
  }
  if (entry.result !== "success" && entry.result !== "blocked") {
    throw new Error(`${label}: invalid finalize result ${JSON.stringify(entry.result)}`);
  }
  for (const key of ["retries", "humanInterventions"] as const) {
    const count = entry[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label}: invalid finalize ${key} ${JSON.stringify(count)}`);
    }
  }
  return {
    workItemId: entry.workItemId,
    result: entry.result,
    retries: entry.retries as number,
    humanInterventions: entry.humanInterventions as number,
  };
}

async function readCompletion(path: string): Promise<CompletionFile> {
  const label = "Ledger completion";
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
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "finalize" || keys[1] !== "pending") {
    throw new Error(`${label} ${path}: must hold exactly "pending" and "finalize"`);
  }
  if (!Array.isArray(record.pending) || record.pending.length === 0) {
    throw new Error(`${label} ${path}: "pending" must be a non-empty array`);
  }
  const pending = record.pending as unknown[];
  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index];
    if (!isPendingUsage(entry)) {
      throw new Error(
        `${label} ${path}: invalid pending entry at index ${String(index)}: ${pendingReason(entry)}`,
      );
    }
  }
  return {
    pending: pending as PendingUsage[],
    finalize: readFinalize(`${label} ${path}`, record.finalize),
  };
}

async function runRecord(args: string[]): Promise<number> {
  const flags = takeFlags(args, ["--ledger", "--completion"]);
  const ledgerPath = requiredFlag(flags, "--ledger");
  const completionPath = requiredFlag(flags, "--completion");
  const completion = await readCompletion(completionPath);
  for (const entry of completion.pending) {
    await appendPending(ledgerPath, entry);
  }
  const outcome = await finalizeUsage(ledgerPath, completion.finalize);
  console.log(`recorded ${completion.finalize.workItemId} (${outcome})`);
  return 0;
}

function parseDimensions(raw: string): ReadonlySet<QueryDimension> {
  if (raw.trim() === "") {
    throw new Error("ledger: --by needs a non-empty comma list");
  }
  const dims = raw.split(",");
  for (const dim of dims) {
    if (!(DIMENSIONS as readonly string[]).includes(dim)) {
      throw new Error(`ledger: unknown dimension ${JSON.stringify(dim)}`);
    }
  }
  if (new Set(dims).size !== dims.length) {
    throw new Error("ledger: --by must not repeat a dimension");
  }
  return new Set(dims as QueryDimension[]);
}

async function runQuery(args: string[]): Promise<number> {
  const flags = takeFlags(args, ["--ledger", "--by", "--record"]);
  const ledgerPath = requiredFlag(flags, "--ledger");
  const by = flags.get("--by");
  const recordId = flags.get("--record");
  if ((by === undefined) === (recordId === undefined)) {
    throw new Error("ledger: exactly one of --by and --record is required");
  }
  const contents = await readLedger("Ledger query", ledgerPath);
  if (recordId !== undefined) {
    const record = contents.records.find((entry) => entry.workItemId === recordId);
    if (record === undefined || !isUsageRecord(record)) {
      throw new LedgerRefusal(`ledger: no record for ${recordId}`);
    }
    console.log(JSON.stringify(record));
    return 0;
  }
  const result = queryLedger(contents, parseDimensions(by as string));
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function report(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.startsWith("ledger") ? message : `ledger: ${message}`;
  console.error(text);
  return error instanceof LedgerRefusal ? 3 : 2;
}

async function run(): Promise<number> {
  const args = Bun.argv.slice(2);
  const command = args[0];
  try {
    if (command === "record") {
      return await runRecord(args.slice(1));
    }
    if (command === "query") {
      return await runQuery(args.slice(1));
    }
    throw new Error(`ledger: unknown command ${JSON.stringify(command ?? "")}`);
  } catch (error: unknown) {
    if (error instanceof LedgerDataError) {
      return report(error);
    }
    return report(error);
  }
}

const code = await run();
process.exit(code);

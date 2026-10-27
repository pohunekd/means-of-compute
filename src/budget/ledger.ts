// Ledger reader for the budget guard. The ledger stores one UsageRecord per
// finished task as JSON lines; the guard only reads it. A missing file means
// zero spend. A present line that fails validation is an error naming the
// line number and is never skipped.
import { lstat, readFile, stat } from "node:fs/promises";
import { contractErrors, isUsageRecord } from "../../contracts/v1/validate.js";
import type { UsageRecord } from "../../contracts/v1/types.js";

function parseLine(ledgerPath: string, lineNumber: number, text: string): UsageRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Budget ledger ${ledgerPath} line ${String(lineNumber)}: not valid JSON`);
  }
  if (!isUsageRecord(raw)) {
    const errors = contractErrors("usage-record", raw);
    throw new Error(
      `Budget ledger ${ledgerPath} line ${String(lineNumber)}: invalid UsageRecord ${JSON.stringify(errors)}`,
    );
  }
  return raw;
}

export async function readUsageLedger(ledgerPath: string): Promise<UsageRecord[]> {
  try {
    await lstat(ledgerPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new Error(
      `Budget ledger ${ledgerPath}: cannot stat path (${String((error as NodeJS.ErrnoException).code)})`,
      { cause: error },
    );
  }
  let isRegularFile: boolean;
  try {
    isRegularFile = (await stat(ledgerPath)).isFile();
  } catch (error: unknown) {
    throw new Error(
      `Budget ledger ${ledgerPath}: cannot stat path (${String((error as NodeJS.ErrnoException).code)})`,
      { cause: error },
    );
  }
  if (!isRegularFile) {
    throw new Error(`Budget ledger ${ledgerPath}: not a regular file`);
  }
  let text: string;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch (error: unknown) {
    throw new Error(
      `Budget ledger ${ledgerPath}: cannot read file (${String((error as NodeJS.ErrnoException).code)})`,
      { cause: error },
    );
  }
  if (text.trim() === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line, index) => parseLine(ledgerPath, index + 1, line));
}

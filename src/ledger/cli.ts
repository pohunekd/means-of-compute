// Ledger CLI: record appends a pending usage line, finalize folds pending
// lines into one UsageRecord line, query lists spend entries (records
// first, pending lines follow). Errors exit 2; finalize refuses exit 1.
import { readLedger, loadLedgerConfig, spendEntriesOf } from "./read.js";
import { isPendingUsage, pendingErrors } from "./validate.js";
import { appendPending, finalizeUsage } from "./store.js";
import type { FinalizeInput } from "./types.js";

function usageError(message: string): never {
  process.stderr.write(`ledger: ${message}\n`);
  process.exit(2);
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function configPathOf(args: readonly string[]): string {
  return flagValue(args, "--config") ?? "config/ledger.json";
}

async function commandRecord(args: readonly string[]): Promise<void> {
  const file = flagValue(args, "--pending-file");
  if (file === undefined) {
    usageError("record needs --pending-file <path>");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(file).text()) as unknown;
  } catch {
    usageError(`cannot read pending file ${file}`);
  }
  if (!isPendingUsage(raw)) {
    usageError(`invalid pending entry: ${JSON.stringify(pendingErrors(raw))}`);
  }
  const { ledgerPath } = await loadLedgerConfig(configPathOf(args));
  await appendPending(ledgerPath, raw);
  process.stdout.write(`recorded ${raw.entryId} for ${raw.workItemId}\n`);
}

async function commandFinalize(args: readonly string[]): Promise<void> {
  const workItemId = flagValue(args, "--work-item-id");
  const result = flagValue(args, "--result");
  const retriesText = flagValue(args, "--retries");
  const interventionsText = flagValue(args, "--human-interventions");
  if (
    workItemId === undefined ||
    (result !== "success" && result !== "blocked") ||
    retriesText === undefined ||
    interventionsText === undefined
  ) {
    usageError(
      "finalize needs --work-item-id <id> --result <success|blocked> --retries <n> --human-interventions <n>",
    );
  }
  const retries = Number(retriesText);
  const humanInterventions = Number(interventionsText);
  if (!Number.isInteger(retries) || !Number.isInteger(humanInterventions)) {
    usageError("retries and human-interventions must be integers");
  }
  const input: FinalizeInput = { workItemId, result, retries, humanInterventions };
  const { ledgerPath } = await loadLedgerConfig(configPathOf(args));
  try {
    const outcome = await finalizeUsage(ledgerPath, input);
    process.stdout.write(`${outcome} ${workItemId}\n`);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "LedgerRefusal") {
      process.stdout.write(`refused: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function commandQuery(args: readonly string[]): Promise<void> {
  const { ledgerPath } = await loadLedgerConfig(configPathOf(args));
  const contents = await readLedger("Ledger", ledgerPath);
  const entries = spendEntriesOf(contents);
  if (args.includes("--json")) {
    for (const entry of entries) {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    }
    return;
  }
  for (const entry of entries) {
    const totals = new Map<string, { inputs: number; outputs: number; requests: number }>();
    for (const token of entry.tokens) {
      const key = `${token.provider} ${token.model}`;
      const total = totals.get(key) ?? { inputs: 0, outputs: 0, requests: 0 };
      total.inputs += token.inputTokens ?? 0;
      total.outputs += token.outputTokens ?? 0;
      total.requests += token.requests ?? 0;
      totals.set(key, total);
    }
    const summary = [...totals]
      .map(
        ([key, total]) =>
          `${key} in=${String(total.inputs)} out=${String(total.outputs)} req=${String(total.requests)}`,
      )
      .join("; ");
    process.stdout.write(`${entry.workItemId} ${entry.finishedAt} ${summary}\n`);
  }
}

const command = process.argv[2];
try {
  if (command === "record") {
    await commandRecord(process.argv.slice(3));
  } else if (command === "finalize") {
    await commandFinalize(process.argv.slice(3));
  } else if (command === "query") {
    await commandQuery(process.argv.slice(3));
  } else {
    usageError("usage: ledger <record|finalize|query> ...");
  }
} catch (error: unknown) {
  process.stderr.write(`ledger: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

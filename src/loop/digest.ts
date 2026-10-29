// Daily digest: one markdown file per finished UTC day, written the day
// after (merged, running, parked and blocked, spend). A temp file plus
// link(2) makes the write exclusive: EEXIST means the file is already
// written. The digest holds no finding, goal or issue text.
import { link, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { utcCalendarDay, summarizeSpend } from "../budget/cost.js";
import { loadPricingForIds } from "../budget/pricing.js";
import { formatUsd, guardScaled } from "../dashboard/money.js";
import { readLedger, spendEntriesOf } from "../ledger/read.js";
import { readLoopState, updateLoopState, type LoopState } from "./state.js";
import type { LoopItem } from "./types.js";
import { LoopStateDataError } from "./state.js";
import { readResults, type ResultLine } from "./results.js";
import { readWorkStore } from "../work/store.js";
import type { LoopLog } from "./log.js";

export interface DigestContext {
  readonly statePath: string;
  readonly storePath: string;
  readonly resultsPath: string;
  readonly ledgerPath: string;
  readonly digestDir: string;
  readonly providersDir: string;
  readonly nvidiaProviderId: string;
  readonly log: LoopLog;
  readonly now: () => Date;
}

export interface DigestInput {
  readonly day: string;
  readonly merged: readonly {
    readonly id: string;
    readonly pull: number;
    readonly headSha: string;
    readonly model: string;
    readonly baseRace: boolean;
  }[];
  readonly running: readonly { readonly id: string; readonly status: string; readonly phase: string; readonly round: number }[];
  readonly parkedBlocked: readonly { readonly id: string; readonly statusReason: string }[];
  readonly daySpend: string;
  readonly totalSpend: string;
}

// One day before today: the digest covers only full days.
function previousDay(today: string): string {
  const date = new Date(`${today}T00:00:00.000Z`);
  return new Date(date.getTime() - 86_400_000).toISOString().slice(0, 10);
}

function formatSpend(summary: { spentTodayNanoTimes1M: bigint; spentTotalNanoTimes1M: bigint; unknownWorkItemIds: readonly string[] }): {
  readonly day: string;
  readonly total: string;
} {
  if (summary.unknownWorkItemIds.length > 0) {
    const text = `no data (spend unknown: ${String(summary.unknownWorkItemIds.length)} items)`;
    return { day: text, total: text };
  }
  return {
    day: formatUsd(guardScaled(summary.spentTodayNanoTimes1M)),
    total: formatUsd(guardScaled(summary.spentTotalNanoTimes1M)),
  };
}

export function renderDigest(input: DigestInput): string {
  const lines = [`# Factory digest ${input.day} (UTC)`, "", "## Merged", ""];
  if (input.merged.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of input.merged) {
      lines.push(
        `- ${entry.id}: PR #${String(entry.pull)}, head ${entry.headSha.slice(0, 12)}, model ${entry.model}${entry.baseRace ? ", base race" : ""}`,
      );
    }
  }
  lines.push("", "## Running", "");
  if (input.running.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of input.running) {
      lines.push(`- ${entry.id}: ${entry.status}, phase ${entry.phase}, round ${String(entry.round)}`);
    }
  }
  lines.push("", "## Parked and blocked", "");
  if (input.parkedBlocked.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of input.parkedBlocked) {
      lines.push(`- ${entry.id}: ${entry.statusReason}`);
    }
  }
  lines.push("", "## Spend", "", `- Day: ${input.daySpend}`, `- Total: ${input.totalSpend}`, "");
  return lines.join("\n");
}

// Joins merged result lines with the loop item (PR) and its round record
// (head and base race). A merged line without either is a data error.
export async function writeDigestFile(dir: string, day: string, text: string): Promise<"written" | "exists"> {
  const tmp = join(dir, `.${day}.md.${String(process.pid)}.${randomUUID()}.tmp`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, join(dir, `${day}.md`));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return "exists";
    }
    throw error;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  return "written";
}

// Runs once per tick after intake: sets a null last run to today without
// writing, skips while the day is covered, otherwise writes yesterday's
// file and advances the day in one state write.
export async function runDigest(ctx: DigestContext): Promise<void> {
  const today = utcCalendarDay(ctx.now());
  const day = await updateLoopState(ctx.statePath, (state) => {
    if (state.lastDigestDay === null) {
      return Promise.resolve({
        next: { ...state, lastDigestDay: today },
        value: null,
      });
    }
    if (state.lastDigestDay >= today) {
      return Promise.resolve({ next: null, value: null });
    }
    return Promise.resolve({ next: null, value: previousDay(today) });
  });
  if (day === null) {
    return;
  }
  const written = await writeDigestFile(ctx.digestDir, day, await digestFor(ctx, day));
  if (written === "written") {
    ctx.log.log({ event: "digest-written", detail: day });
  }
  await updateLoopState(ctx.statePath, (state) =>
    Promise.resolve({ next: { ...state, lastDigestDay: today }, value: undefined }),
  );
}

export async function digestFor(ctx: DigestContext, day: string): Promise<string> {
  const [state, store, results, ledger] = await Promise.all([
    readLoopState(ctx.statePath),
    readWorkStore(ctx.storePath),
    readResults(ctx.resultsPath),
    readLedger("Loop ledger", ctx.ledgerPath),
  ]);
  const merged: { readonly id: string; readonly pull: number; readonly headSha: string; readonly model: string; readonly baseRace: boolean }[] = [];
  for (const line of results) {
    if (line.outcome !== "merged" || utcCalendarDay(new Date(line.at)) !== day) {
      continue;
    }
    merged.push(mergedOf(line, state));
  }
  const running: { readonly id: string; readonly status: string; readonly phase: string; readonly round: number }[] = [];
  const parkedBlocked: { readonly id: string; readonly statusReason: string }[] = [];
  for (const item of store.items) {
    if (item.status === "running" || item.status === "review") {
      const li = state.items[item.id] as unknown as LoopItem | undefined;
      running.push({
        id: item.id,
        status: item.status,
        phase: li === undefined ? "unknown" : li.phase,
        round: li === undefined ? 0 : li.round,
      });
    } else if (item.status === "parked" || item.status === "blocked") {
      parkedBlocked.push({ id: item.id, statusReason: item.statusReason ?? "" });
    }
  }
  const providerIds = new Set<string>();
  for (const entry of spendEntriesOf(ledger)) {
    for (const token of entry.tokens) {
      providerIds.add(token.provider);
    }
  }
  providerIds.add(ctx.nvidiaProviderId);
  const pricing = await loadPricingForIds(ctx.providersDir, [...providerIds]);
  const summary = summarizeSpend(
    spendEntriesOf(ledger),
    pricing,
    ctx.nvidiaProviderId,
    new Date(`${day}T23:59:59.999Z`),
  );
  const spend = formatSpend(summary);
  return renderDigest({
    day,
    merged,
    running,
    parkedBlocked,
    daySpend: spend.day,
    totalSpend: spend.total,
  });
}

function mergedOf(line: ResultLine, state: LoopState): DigestInput["merged"][number] {
  const li = state.items[line.workItemId] as unknown as LoopItem | undefined;
  if (li === undefined || li.pull === null) {
    throw new LoopStateDataError(`digest: merged line ${line.key} has no loop pull`);
  }
  const record = li.rounds.find((entry) => entry.round === line.round);
  if (record === undefined || record.headSha === null) {
    throw new LoopStateDataError(`digest: merged line ${line.key} has no round head`);
  }
  return {
    id: line.workItemId,
    pull: li.pull.number,
    headSha: record.headSha,
    model: line.model,
    baseRace: record.baseRace,
  };
}

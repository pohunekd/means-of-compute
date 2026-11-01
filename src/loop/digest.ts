// Daily digest: one markdown file per finished UTC day, written the day
// after (merged, running, parked and blocked, triage counts, spend). A temp file plus
// link(2) makes the write exclusive: EEXIST means the file is already
// written. The digest holds no finding, goal or issue text.
import { link, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { utcCalendarDay, summarizeSpend, type SpendBounds } from "../budget/cost.js";
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
  readonly spendBounds: SpendBounds;
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
  readonly running: readonly {
    readonly id: string;
    readonly status: string;
    readonly loop: { readonly phase: string; readonly round: number } | null;
  }[];
  readonly parkedBlocked: readonly { readonly id: string; readonly statusReason: string | null }[];
  readonly triage: { readonly auto: number; readonly hold: number; readonly skip: number };
  readonly daySpend: string;
  readonly totalSpend: string;
}

// One day before today: the digest covers only full days.
function previousDay(today: string): string {
  const date = new Date(`${today}T00:00:00.000Z`);
  return new Date(date.getTime() - 86_400_000).toISOString().slice(0, 10);
}

function formatSpend(summary: {
  spentTodayNanoTimes1M: bigint;
  spentTotalNanoTimes1M: bigint;
  unknownWorkItemIds: readonly string[];
  boundedWorkItemIds: readonly string[];
  boundedTodayWorkItemIds: readonly string[];
}): {
  readonly day: string;
  readonly total: string;
} {
  if (summary.unknownWorkItemIds.length > 0) {
    const text = `no data (spend unknown: ${String(summary.unknownWorkItemIds.length)} items)`;
    return { day: text, total: text };
  }
  const daySuffix =
    summary.boundedTodayWorkItemIds.length > 0
      ? ` (upper bound for unmeasured calls of ${String(summary.boundedTodayWorkItemIds.length)} items)`
      : "";
  const totalSuffix =
    summary.boundedWorkItemIds.length > 0
      ? ` (upper bound for unmeasured calls of ${String(summary.boundedWorkItemIds.length)} items)`
      : "";
  return {
    day: `${formatUsd(guardScaled(summary.spentTodayNanoTimes1M))}${daySuffix}`,
    total: `${formatUsd(guardScaled(summary.spentTotalNanoTimes1M))}${totalSuffix}`,
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
      lines.push(
        entry.loop === null
          ? `- ${entry.id}: ${entry.status}, no loop item`
          : `- ${entry.id}: ${entry.status}, phase ${entry.loop.phase}, round ${String(entry.loop.round)}`,
      );
    }
  }
  lines.push("", "## Parked and blocked", "");
  if (input.parkedBlocked.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of input.parkedBlocked) {
      lines.push(`- ${entry.id}: ${entry.statusReason ?? "-"}`);
    }
  }
  lines.push(
    "",
    "## Follow-up triage",
    "",
    `- auto ${String(input.triage.auto)}, hold ${String(input.triage.hold)}, skip ${String(input.triage.skip)}`,
  );
  lines.push("", "## Spend", "", `- Day: ${input.daySpend}`, `- Total: ${input.totalSpend}`, "");
  return lines.join("\n");
}

// Links the temp file to the day's name; EEXIST means the day is
// already written, so the first bytes stay.
async function linkOnce(tmp: string, target: string): Promise<"written" | "exists"> {
  try {
    await link(tmp, target);
    return "written";
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return "exists";
    }
    throw error;
  }
}

// The temp file may be gone already; any other unlink failure is real.
async function removeTemp(tmp: string): Promise<void> {
  try {
    await unlink(tmp);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

// Writes a temp file and links it to <day>.md, so the write is exclusive;
// the temp file is removed on every path.
export async function writeDigestFile(
  dir: string,
  day: string,
  text: string,
): Promise<"written" | "exists"> {
  const tmp = join(dir, `.${day}.md.${String(process.pid)}.${randomUUID()}.tmp`);
  const handle = await open(tmp, "wx", 0o600);
  let outcome: "written" | "exists";
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    outcome = await linkOnce(tmp, join(dir, `${day}.md`));
  } finally {
    await removeTemp(tmp);
  }
  return outcome;
}

// Runs once per tick after intake: sets a null last run to today without
// writing, skips while the day is covered, otherwise writes yesterday's
// file and advances the day in one state write. Returns true only when a
// set day advanced, which starts the day's triage run.
export async function runDigest(ctx: DigestContext): Promise<boolean> {
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
    return false;
  }
  const written = await writeDigestFile(ctx.digestDir, day, await digestFor(ctx, day));
  if (written === "written") {
    ctx.log.log({ event: "digest-written", detail: day });
  }
  await updateLoopState(ctx.statePath, (state) =>
    Promise.resolve({ next: { ...state, lastDigestDay: today }, value: undefined }),
  );
  return true;
}

export async function digestFor(ctx: DigestContext, day: string): Promise<string> {
  const [state, store, results, ledger] = await Promise.all([
    readLoopState(ctx.statePath),
    readWorkStore(ctx.storePath),
    readResults(ctx.resultsPath),
    readLedger("Loop ledger", ctx.ledgerPath),
  ]);
  const merged: {
    readonly id: string;
    readonly pull: number;
    readonly headSha: string;
    readonly model: string;
    readonly baseRace: boolean;
  }[] = [];
  for (const line of results) {
    if (line.outcome !== "merged" || utcCalendarDay(new Date(line.at)) !== day) {
      continue;
    }
    merged.push(mergedOf(line, state));
  }
  const running: DigestInput["running"][number][] = [];
  const parkedBlocked: DigestInput["parkedBlocked"][number][] = [];
  for (const item of store.items) {
    if (item.status === "running" || item.status === "review") {
      const li = state.items[item.id] as unknown as LoopItem | undefined;
      running.push({
        id: item.id,
        status: item.status,
        loop: li === undefined ? null : { phase: li.phase, round: li.round },
      });
    } else if (item.status === "parked" || item.status === "blocked") {
      parkedBlocked.push({ id: item.id, statusReason: item.statusReason });
    }
  }
  const triage = { auto: 0, hold: 0, skip: 0 };
  for (const value of Object.values(state.items)) {
    for (const entry of (value as unknown as LoopItem).followups) {
      if (entry.triage !== undefined && utcCalendarDay(new Date(entry.triage.at)) === day) {
        triage[entry.triage.decision] += 1;
      }
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
    ctx.spendBounds,
  );
  const spend = formatSpend(summary);
  return renderDigest({
    day,
    merged,
    running,
    parkedBlocked,
    triage,
    daySpend: spend.day,
    totalSpend: spend.total,
  });
}

// Joins merged result lines with the loop item (PR) and its round record
// (head and base race). A merged line without either is a data error.
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

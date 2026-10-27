// Once-per-event escalation for the budget guard. The state file keeps
// every escalated event key: "day:<UTC day>" for the daily cap,
// "nvidia:<UTC day>" for the NVIDIA daily limit, "total" for the total
// cap (once regardless of the day), "spend-unknown:<UTC day>" for
// unknown spend (once per day while spend stays unknown). An event
// escalates only when its key is absent; keys are never dropped because the
// set grows by at most a few keys a day. Each escalation appends one JSON
// line to the escalation log and prints one line on stderr for the
// coordinator's daily digest channel.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { utcCalendarDay } from "./cost.js";
import { readInputText, statInputPath } from "./fs.js";
import type { BudgetDecision } from "./decision.js";

export type CapKind = "day" | "total" | "nvidia-daily" | "spend-unknown";

export interface EscalationState {
  readonly escalated: readonly string[];
}

export function capKindOfReason(reason: string): CapKind | null {
  switch (reason) {
    case "daily cap reached":
      return "day";
    case "total cap reached":
      return "total";
    case "NVIDIA Build daily request limit reached":
      return "nvidia-daily";
    case "spend unknown":
      return "spend-unknown";
    default:
      return null;
  }
}

export function eventKeyString(kind: CapKind, now: Date): string {
  switch (kind) {
    case "total":
      return kind;
    case "spend-unknown":
      return `spend-unknown:${utcCalendarDay(now)}`;
    case "day":
      return `day:${utcCalendarDay(now)}`;
    case "nvidia-daily":
      return `nvidia:${utcCalendarDay(now)}`;
  }
}

function eventKey(kind: CapKind, now: Date): string {
  return eventKeyString(kind, now);
}

async function readState(statePath: string): Promise<EscalationState> {
  const label = "Budget escalation state";
  if ((await statInputPath(label, statePath)) === "absent") {
    return { escalated: [] };
  }
  const text = await readInputText(label, statePath);
  if (text.trim() === "") {
    return { escalated: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} ${statePath}: not valid JSON`, { cause: error });
  }
  const record = raw as Partial<EscalationState>;
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray(record.escalated) ||
    record.escalated.some((entry: unknown) => typeof entry !== "string")
  ) {
    throw new Error(`${label} ${statePath}: invalid state document`);
  }
  return { escalated: record.escalated as string[] };
}

async function writeState(statePath: string, state: EscalationState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await Bun.write(statePath, `${JSON.stringify(state)}\n`);
}

export async function maybeEscalate(
  decision: BudgetDecision,
  options: {
    readonly statePath: string;
    readonly escalationLogPath: string;
    readonly now: Date;
    readonly stderr?: (line: string) => void;
  },
): Promise<boolean> {
  if (decision.admit) {
    return false;
  }
  const kind = capKindOfReason(decision.reason);
  if (kind === null) {
    throw new Error(`Budget escalation: unknown refusal reason "${decision.reason}"`);
  }
  const key = eventKey(kind, options.now);
  const state = await readState(options.statePath);
  if (state.escalated.includes(key)) {
    return false;
  }
  const entry = {
    eventKey: key,
    reason: decision.reason,
    spentTodayUsd: decision.spentTodayUsd,
    spentTotalUsd: decision.spentTotalUsd,
    nvidiaRequestsToday: decision.nvidiaRequestsToday,
    at: options.now.toISOString(),
  };
  await mkdir(dirname(options.escalationLogPath), { recursive: true });
  await appendFile(options.escalationLogPath, `${JSON.stringify(entry)}\n`);
  await writeState(options.statePath, { escalated: [...state.escalated, key] });
  if (options.stderr !== undefined) {
    options.stderr(`budget escalation: ${key} (${decision.reason})\n`);
  } else {
    process.stderr.write(`budget escalation: ${key} (${decision.reason})\n`);
  }
  return true;
}

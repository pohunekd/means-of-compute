// Once-per-event escalation for the budget guard. The state file remembers
// the last escalated cap event (cap kind plus UTC day for the daily caps); a
// second refusal for the same event appends nothing and prints nothing. Each
// escalation appends one JSON line to the escalation log and prints one line
// on stderr for the coordinator's daily digest channel.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { utcCalendarDay } from "./cost.js";
import type { BudgetDecision } from "./decision.js";

export type CapKind = "day" | "total" | "nvidia-daily" | "spend-unknown";

export interface EscalationState {
  readonly capKind: CapKind;
  // UTC day for daily kinds (day, nvidia-daily); empty for total and
  // spend-unknown, which escalate once regardless of the day.
  readonly day: string;
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
    case "spend-unknown":
      return kind;
    case "day":
      return `day:${utcCalendarDay(now)}`;
    case "nvidia-daily":
      return `nvidia:${utcCalendarDay(now)}`;
  }
}

function eventKey(kind: CapKind, now: Date): EscalationState {
  switch (kind) {
    case "day":
    case "nvidia-daily":
      return { capKind: kind, day: utcCalendarDay(now) };
    case "total":
    case "spend-unknown":
      return { capKind: kind, day: "" };
  }
}

async function readState(statePath: string): Promise<EscalationState | null> {
  if (!(await Bun.file(statePath).exists())) {
    return null;
  }
  const text = await Bun.file(statePath).text();
  if (text.trim() === "") {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Budget escalation state ${statePath}: not valid JSON`);
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as Record<string, unknown>).capKind !== "string" ||
    typeof (raw as Record<string, unknown>).day !== "string"
  ) {
    throw new Error(`Budget escalation state ${statePath}: invalid state document`);
  }
  return raw as EscalationState;
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
  const previous = await readState(options.statePath);
  if (previous !== null && previous.capKind === key.capKind && previous.day === key.day) {
    return false;
  }
  await writeState(options.statePath, key);
  const entry = {
    capKind: key.capKind,
    day: key.day,
    reason: decision.reason,
    spentTodayUsd: decision.spentTodayUsd,
    spentTotalUsd: decision.spentTotalUsd,
    nvidiaRequestsToday: decision.nvidiaRequestsToday,
    at: options.now.toISOString(),
  };
  await mkdir(dirname(options.escalationLogPath), { recursive: true });
  const existing = (await Bun.file(options.escalationLogPath).exists())
    ? await Bun.file(options.escalationLogPath).text()
    : "";
  await Bun.write(options.escalationLogPath, `${existing}${JSON.stringify(entry)}\n`);
  if (options.stderr !== undefined) {
    options.stderr(`budget escalation: ${key.capKind} cap reached (${decision.reason})\n`);
  } else {
    process.stderr.write(`budget escalation: ${key.capKind} cap reached (${decision.reason})\n`);
  }
  return true;
}

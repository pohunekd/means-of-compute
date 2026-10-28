// Registry session helpers. The request id format is `${workItemId}:${n}`
// (src/dispatcher/dispatcher.ts:475); the dispatcher's pattern is not exported.
import type { RegistryEntry } from "../dispatcher/registry.js";
import { sessionsOf } from "../dispatcher/registry.js";

export const SESSION_REQUEST_ID_PATTERN = /^([a-z0-9][a-z0-9-]{0,62}):(0|[1-9][0-9]*)$/;

// First entry, in file order, whose requestId fails the pattern or whose group 1 !== entry.workItemId:
// returns `requestId "${entry.requestId}" is not "${entry.workItemId}:<n>"`; null when every entry passes.
export function requestIdProblem(entries: readonly RegistryEntry[]): string | null {
  for (const entry of entries) {
    const match = SESSION_REQUEST_ID_PATTERN.exec(entry.requestId);
    if (match === null || match[1] !== entry.workItemId) {
      return `requestId "${entry.requestId}" is not "${entry.workItemId}:<n>"`;
    }
  }
  return null;
}

// Number(group 2); throws Error("dashboard: unchecked registry requestId") when the pattern fails.
export function sessionNumber(entry: RegistryEntry): number {
  const match = SESSION_REQUEST_ID_PATTERN.exec(entry.requestId);
  const group = match === null ? undefined : match[2];
  if (match === null || group === undefined) {
    throw new Error("dashboard: unchecked registry requestId");
  }
  return Number(group);
}

// Highest sessionNumber over sessionsOf(entries, workItemId); null when none.
export function latestSession(
  entries: readonly RegistryEntry[],
  workItemId: string,
): RegistryEntry | null {
  let latest: RegistryEntry | null = null;
  let latestN = -1;
  for (const entry of sessionsOf(entries, workItemId)) {
    const n = sessionNumber(entry);
    if (latest === null || n > latestN) {
      latest = entry;
      latestN = n;
    }
  }
  return latest;
}

// The same over the entries with terminal === null.
export function latestOpenSession(
  entries: readonly RegistryEntry[],
  workItemId: string,
): RegistryEntry | null {
  let latest: RegistryEntry | null = null;
  let latestN = -1;
  for (const entry of sessionsOf(entries, workItemId)) {
    if (entry.terminal !== null) {
      continue;
    }
    const n = sessionNumber(entry);
    if (latest === null || n > latestN) {
      latest = entry;
      latestN = n;
    }
  }
  return latest;
}

// Entries with terminal === null and this hostAlias. Provisional entries count (A3).
export function openSessionCount(entries: readonly RegistryEntry[], hostAlias: string): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.terminal === null && entry.hostAlias === hostAlias) {
      count += 1;
    }
  }
  return count;
}

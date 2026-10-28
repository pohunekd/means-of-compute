// Loop log: one JSON line per event in logs/loop.jsonl. Writes go
// through one in-process chain; the first failed write latches failed()
// and later log calls write nothing. The detail field carries a fixed
// code or an error message, never brief, goal, finding or issue text.
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export type LoopEventName =
  | "factory-start"
  | "factory-stop"
  | "claim"
  | "started"
  | "terminal"
  | "pull"
  | "ci"
  | "verdict"
  | "merged"
  | "round-closed"
  | "parked"
  | "blocked"
  | "escalation"
  | "followup"
  | "merge-base-race"
  | "merge-hold-cleared"
  | "budget-refused"
  | "no-host"
  | "intake-skip"
  | "github-error"
  | "resolve-done"
  | "orphan-session"
  | "routing-steered"
  | "ledger-finalize-refused"
  | "ledger-finalize-error"
  | "digest-written"
  | "unparked";

export interface LoopLogEvent {
  readonly event: LoopEventName;
  readonly workItemId?: string;
  readonly round?: number;
  readonly requestId?: string;
  readonly hostAlias?: string;
  readonly sha?: string;
  readonly code?: string;
  readonly detail?: string;
}

export interface LoopLog {
  log(event: LoopLogEvent): void;
  failed(): boolean;
  close(): Promise<void>;
}

export async function openLoopLog(path: string, now: () => Date): Promise<LoopLog> {
  const handle: FileHandle = await open(path, "a", 0o600);
  let latched = false;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();

  async function writeOnce(event: LoopLogEvent): Promise<void> {
    const line = `${JSON.stringify({ ts: now().toISOString(), ...event })}\n`;
    try {
      await handle.write(line);
      await handle.sync();
    } catch {
      latched = true;
    }
  }

  return {
    log(event: LoopLogEvent): void {
      if (latched || closed) {
        return;
      }
      chain = chain.then(() => {
        if (latched) {
          return;
        }
        return writeOnce(event);
      });
    },
    failed(): boolean {
      return latched;
    },
    async close(): Promise<void> {
      closed = true;
      await chain;
      await handle.close();
    },
  };
}

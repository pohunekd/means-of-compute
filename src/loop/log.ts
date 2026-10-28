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

// The seam the C3 latch test needs: the first write can fail while a
// later write would succeed, which the real filesystem cannot express.
export interface LoopLogFs {
  open(path: string, mode: number): Promise<FileHandle>;
}

const nodeLogFs: LoopLogFs = {
  open(path: string, mode: number): Promise<FileHandle> {
    return open(path, "a", mode);
  },
};

export async function openLoopLog(path: string, now?: () => Date): Promise<LoopLog>;
export async function openLoopLog(
  path: string,
  options: { readonly fs?: LoopLogFs; readonly now?: () => Date },
): Promise<LoopLog>;
export async function openLoopLog(
  path: string,
  nowOrOptions?: (() => Date) | { readonly fs?: LoopLogFs; readonly now?: () => Date },
): Promise<LoopLog> {
  const options = typeof nowOrOptions === "function" ? { now: nowOrOptions } : (nowOrOptions ?? {});
  const now = options.now ?? ((): Date => new Date());
  const fs = options.fs ?? nodeLogFs;
  const handle: FileHandle = await fs.open(path, 0o600);
  let latched = false;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();

  let handleOpen = true;
  function takeHandle(): FileHandle | null {
    if (!handleOpen) {
      return null;
    }
    handleOpen = false;
    return handle;
  }
  async function writeOnce(event: LoopLogEvent): Promise<void> {
    const line = `${JSON.stringify({ ts: now().toISOString(), ...event })}\n`;
    try {
      await handle.write(line);
      await handle.sync();
    } catch {
      // A leaked handle trips the runtime GC guard under the full
      // gates run, so the latched write closes it right away.
      latched = true;
      closed = true;
      await takeHandle()?.close();
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
      try {
        await chain;
      } finally {
        const owned = takeHandle();
        if (owned === null) {
          await handle.close().catch(() => {});
        } else {
          await owned.close();
        }
      }
    },
  };
}

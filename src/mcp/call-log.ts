// MCP call log (L1-L3): one append-only JSONL file per server run.
// Opened once with open(path, "a", 0o600); each entry is one write of one
// JSON line followed by datasync, serialized through a single in-process
// chain. A failed append latches the log: later appends throw
// CallLogUnavailableError and serve.ts reports call-log-unavailable.
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export class CallLogUnavailableError extends Error {
  constructor(message = "call log unavailable") {
    super(message);
    this.name = "CallLogUnavailableError";
  }
}

export class CallLogOpenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CallLogOpenError";
  }
}

export interface CallLog {
  append(entry: Record<string, unknown>): Promise<void>;
}

export interface FileCallLog extends CallLog {
  close(): Promise<void>;
}

export async function openCallLog(path: string): Promise<FileCallLog> {
  let handle: FileHandle;
  try {
    handle = await open(path, "a", 0o600);
  } catch (error: unknown) {
    throw new CallLogOpenError(
      `call log ${path}: cannot open (${String((error as NodeJS.ErrnoException).code)})`,
      { cause: error },
    );
  }
  let chain: Promise<void> = Promise.resolve();
  let failed = false;
  async function writeEntry(entry: Record<string, unknown>): Promise<void> {
    if (failed) {
      throw new CallLogUnavailableError();
    }
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.datasync();
    } catch (error: unknown) {
      failed = true;
      try {
        process.stderr.write(
          `mcp: call log append failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } catch {
        // Stderr is best-effort during a log failure; the latch carries it.
      }
      throw new CallLogUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    append(entry: Record<string, unknown>): Promise<void> {
      const task = chain.then(() => writeEntry(entry));
      chain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    async close(): Promise<void> {
      await chain;
      await handle.close();
    },
  };
}

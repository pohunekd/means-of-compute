// Ledger lock: one writer at a time per ledger file. An in-process promise
// chain serializes callers that share the module; a lock file beside the
// ledger serializes processes. A stale lock (owner pid gone) is removed
// once and retried once; a live owner exits 2. There is no waiting loop:
// the loop runner retries at its next tick.
import { open, readFile, unlink } from "node:fs/promises";
import { LedgerDataError } from "./store.js";

const chains = new Map<string, Promise<unknown>>();

function lockPathOf(ledgerPath: string): string {
  return `${ledgerPath}.lock`;
}

const LOCK_CONTENT_PATTERN = /^[1-9][0-9]*\n$/;

async function readLockPid(lockPath: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (error: unknown) {
    throw new LedgerDataError(
      `ledger lock ${lockPath}: cannot read lock (${String((error as NodeJS.ErrnoException).code)})`,
    );
  }
  if (!LOCK_CONTENT_PATTERN.test(text)) {
    throw new LedgerDataError(`ledger lock ${lockPath}: unreadable content`);
  }
  return Number.parseInt(text, 10);
}

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function acquire(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new LedgerDataError(
          `ledger lock ${lockPath}: cannot take lock (${String((error as NodeJS.ErrnoException).code)})`,
        );
      }
      const pid = await readLockPid(lockPath);
      if (pid === process.pid) {
        throw new LedgerDataError(`ledger lock ${lockPath}: held by this process`);
      }
      if (ownerAlive(pid)) {
        throw new LedgerDataError(`ledger lock ${lockPath}: held by pid ${String(pid)}`);
      }
      try {
        await unlink(lockPath);
      } catch (unlinkError: unknown) {
        throw new LedgerDataError(
          `ledger lock ${lockPath}: cannot remove stale lock (${String((unlinkError as NodeJS.ErrnoException).code)})`,
        );
      }
      process.stderr.write(`ledger: removed stale lock of pid ${String(pid)}\n`);
      continue;
    }
    try {
      await handle.writeFile(`${String(process.pid)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  throw new LedgerDataError(`ledger lock ${lockPath}: lock reappeared after stale removal`);
}

async function release(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LedgerDataError(`ledger lock ${lockPath}: removed by another process`);
    }
    throw error;
  }
}

export async function withLedgerLock<T>(ledgerPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = lockPathOf(ledgerPath);
  const previous = chains.get(lockPath) ?? Promise.resolve();
  let releaseChain: () => void = () => {};
  const current = previous
    .catch(() => {})
    .then(
      () =>
        new Promise<void>((resolve) => {
          releaseChain = resolve;
        }),
    );
  chains.set(lockPath, current);
  await previous.catch(() => {});
  try {
    await acquire(lockPath);
    try {
      return await fn();
    } finally {
      await release(lockPath);
    }
  } finally {
    releaseChain();
    if (chains.get(lockPath) === current) {
      chains.delete(lockPath);
    }
  }
}

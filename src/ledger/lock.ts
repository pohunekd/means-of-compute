// Ledger lock: one writer at a time per ledger file. An in-process promise
// chain keyed by the resolved lock path serializes callers that share the
// module; a kernel flock on the lock file serializes processes. The kernel
// drops the lock when the holder dies, so there is no stale state to take
// over and no waiting loop: the loop runner retries at its next tick.
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { FFIType, dlopen } from "bun:ffi";
import { LedgerDataError } from "./errors.js";

const chains = new Map<string, Promise<unknown>>();

const LOCK_EX = 2;
const LOCK_NB = 4;

type FlockFn = (fd: number, operation: number) => number;

let cachedFlock: FlockFn | null = null;

function loadFlock(lockPath: string): FlockFn {
  if (cachedFlock !== null) {
    return cachedFlock;
  }
  let library: string;
  if (process.platform === "linux") {
    library = "libc.so.6";
  } else if (process.platform === "darwin") {
    library = "libSystem.B.dylib";
  } else {
    throw new LedgerDataError(`ledger lock ${lockPath}: unsupported platform ${process.platform}`);
  }
  let loaded: ReturnType<typeof dlopen>;
  try {
    loaded = dlopen(library, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
  } catch (error: unknown) {
    throw new LedgerDataError(
      `ledger lock ${lockPath}: cannot load flock (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  cachedFlock = loaded.symbols.flock;
  return cachedFlock;
}

function lockPathOf(ledgerPath: string): string {
  return `${ledgerPath}.lock`;
}

async function acquire(lockPath: string): Promise<FileHandle> {
  const flock = loadFlock(lockPath);
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "a", 0o600);
  } catch (error: unknown) {
    throw new LedgerDataError(
      `ledger lock ${lockPath}: cannot open lock (${String((error as NodeJS.ErrnoException).code)})`,
    );
  }
  const held = flock(handle.fd, LOCK_EX | LOCK_NB);
  if (held === 0) {
    return handle;
  }
  try {
    await handle.close();
  } catch {
    // The lock is held by another process; a close failure adds nothing.
  }
  if (held === -1) {
    throw new LedgerDataError(`ledger lock ${lockPath}: held by another process`);
  }
  throw new LedgerDataError(`ledger lock ${lockPath}: flock returned ${String(held)}`);
}

async function release(lockPath: string, handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch (error: unknown) {
    throw new LedgerDataError(
      `ledger lock ${lockPath}: release failed (${String((error as NodeJS.ErrnoException).code)})`,
    );
  }
}

export async function withLedgerLock<T>(ledgerPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = lockPathOf(ledgerPath);
  const key = resolve(lockPath);
  const previous = chains.get(key) ?? Promise.resolve();
  let releaseChain: () => void = () => {};
  const current = previous
    .catch(() => {})
    .then(
      () =>
        new Promise<void>((unlock) => {
          releaseChain = unlock;
        }),
    );
  chains.set(key, current);
  await previous.catch(() => {});
  try {
    const handle = await acquire(lockPath);
    let outcome: { readonly value: T } | { readonly thrown: unknown };
    try {
      outcome = { value: await fn() };
    } catch (error: unknown) {
      outcome = { thrown: error };
    }
    await release(lockPath, handle);
    if ("thrown" in outcome) {
      throw outcome.thrown;
    }
    return outcome.value;
  } finally {
    releaseChain();
    if (chains.get(key) === current) {
      chains.delete(key);
    }
  }
}

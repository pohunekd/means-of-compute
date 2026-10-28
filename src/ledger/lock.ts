// Ledger lock: one writer at a time per ledger file. The body lives in
// src/fs/lock.ts; this module keeps the ledger label and the ledger error
// so a held lock stays LedgerDataError with the same message.
import { FileLockError, withFileLock } from "../fs/lock.js";
import { LedgerDataError } from "./errors.js";

export async function withLedgerLock<T>(ledgerPath: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withFileLock("ledger lock", ledgerPath, fn);
  } catch (error: unknown) {
    if (error instanceof FileLockError) {
      throw new LedgerDataError(error.message, { cause: error });
    }
    throw error;
  }
}

// Ledger error classes. They live here so the reader and the lock can
// throw them without importing the store.
export class LedgerRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "LedgerRefusal";
    this.reason = reason;
  }
}

export class LedgerDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LedgerDataError";
  }
}

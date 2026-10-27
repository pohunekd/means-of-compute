// Ledger error classes. LedgerRefusal is a domain refusal (CLI exit 3);
// LedgerDataError is an input, config or data error (CLI exit 2).
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

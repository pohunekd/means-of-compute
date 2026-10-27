# Ledger

The ledger records what every task used: tokens per provider and model, and
session time per host. One `UsageRecord` (contracts-v1) is written per
`workItemId` when the item reaches `done` (`result: success`) or `blocked`
(`result: blocked`); a later completion updates that record in place. Usage
reported at session end is kept as pending entries and folded into the record
at finalize, so spend is visible to the budget guard from session end instead
of only at task completion.

## File format

The ledger file at `config/ledger.json` `ledgerPath` holds one JSON document
per line:

- A record line is a bare `UsageRecord`. Record lines keep the guard fixtures
  valid and come first, in their existing order.
- A pending line is `{"pending": PendingUsage}`, an object whose only own key
  is `pending`. Pending lines follow the records, in their existing order.

Every write is an atomic rewrite of the whole file: temp file, fsync, rename.
"Append-only" means records are never deleted and usage is never dropped, not
`O_APPEND`. The file holds at most one record line per `workItemId`.

The lock path is always `<ledgerPath>.lock`. Writing takes an exclusive
`flock` on the lock file; the kernel releases the lock when the holder dies,
so there is no stale state to take over and no waiting loop: the loop runner
retries at its next tick. `ledger:query` never takes the lock and never
writes.

## Writer rules

`appendPending` adds one pending entry (`session` or `audit` kind). A replay
of the identical entry returns `unchanged` without a write; the same
`entryId` with different content exits 2.

`finalizeUsage` folds every pending entry of the item into its record:

- No pending entries and no record exits 3: a record is never fabricated.
- Pending entries without a `session` entry and without a record exit 3, since
  `sessionSeconds` and `attempts` need at least one session item.
- A pending token with `requests: null` exits 3 and the entries stay pending,
  so the guard keeps counting them as spend.
- Decreasing `retries` or `humanInterventions` exits 2.
- Tokens group by provider, model and source with null-propagating sums;
  session seconds group by host alias and source; attempts append one entry
  per session pending entry; `finishedAt` is the latest timestamp seen.

A finalize refusal never blocks or reverts the status transition: the item
keeps its `done` or `blocked` status, the loop runner logs the refusal and
retries on every tick while pending entries remain.

An update moves the record to the UTC day of its new `finishedAt`, so the
guard's day spend for the later day rises and for the earlier day falls. The
total spend stays exact.

## Pending usage

A pending entry carries one session or audit report before finalize:

- `kind: "session"` requires `session` to be an object; `kind: "audit"`
  requires `session: null`.
- A session entry must not carry `auditor-usage` tokens; an audit entry must
  only carry `auditor-usage` tokens.
- `finishedAt` is exactly `Date.prototype.toISOString()` form.

## Reader rules

Reading rejects the file with exit 2, naming the label, path and line: a
line that is not valid JSON, an empty line, a missing trailing newline, a
line that fails either schema, a duplicate record `workItemId`, a duplicate
pending `entryId`, or a record line whose `finishedAt` does not parse
(`Date.parse` is `NaN`, for example a leap second). Nothing is ever skipped
or defaulted; a missing file with an existing parent directory means empty.

## Query

`queryLedger` aggregates records for the dashboard. Pending entries are
counted in `pendingEntries` and never mixed into the breakdowns:

- `byProvider` groups record tokens by provider and model. Token counts are
  null-propagating sums, `requests` is the sum, `sources` the sorted unique
  values. Rows sort by provider, then model.
- `byHost` groups `sessionSeconds` by host alias. `seconds` is the sum,
  `hours` is `(seconds / 3600).toFixed(2)` for display only, `sources` the
  sorted unique values. Rows sort by alias.
- `byModel` is attempt-level over every record's attempts: `attempts` counts
  entries with the model, `successes` those with `result: success`,
  `successRate` is `null` when `attempts` is zero, otherwise
  `(successes / attempts).toFixed(4)`. It is attempt-level, not record-level,
  because a record's result is not attributable to one model after a
  fallback.

## CLI

```sh
bun run ledger:record --ledger <path> --completion <file>
bun run ledger:query --ledger <path> (--by <list> | --record <workItemId>)
```

The completion file holds `{"pending": PendingUsage[] (minItems 1),
"finalize": FinalizeInput}` with no other keys. Record appends each entry in
order, then finalizes, prints `recorded <workItemId> (<outcome>)` and exits 0.

Query prints `JSON.stringify(result, null, 2)` for `--by`, a comma list that
is a non-empty, duplicate-free subset of `provider,host,model`, and exits 0.
`--record` prints the record as one JSON line and exits 0, or exits 3 with
`ledger: no record for <id>`.

All flags take a value. A repeated flag, an unknown flag or a missing value
exits 2 with `ledger: <message>`. Exits follow the budget guard: 0 ok,
2 input, config or data error, 3 domain refusal.

## Module layout

- `src/ledger/types.ts` — `PendingUsage`, `LedgerContents`, `FinalizeInput`,
  `SpendEntry`, the auditor-usage source constant.
- `src/ledger/pending.schema.json` — the pending schema, Ajv 2020.
- `src/ledger/validate.ts` — `isPendingUsage`, compiled once at module load.
- `src/ledger/read.ts` — `readLedger`, `spendEntriesOf`, `authorModelsOf`,
  `loadLedgerConfig`.
- `src/ledger/lock.ts` — `withLedgerLock`, the in-process chain plus the
  kernel `flock`.
- `src/ledger/store.ts` — `appendPending`, `finalizeUsage`, `foldRecord`,
  `LedgerRefusal` (exit 3), `LedgerDataError` (exit 2).
- `src/ledger/query.ts` — `queryLedger`, pure aggregation for the dashboard.
- `src/ledger/cli.ts` — the `ledger:record` and `ledger:query` commands.

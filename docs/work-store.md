# Work store

The work store is the factory-wide DAG of `WorkItem`s (contracts-v1). The
MCP server appends submissions through `submit_work`; the loop runner (#17)
reads the ready set and moves items through status transitions; the
dashboard (#14) reads the items as its WorkItems input.

## File format

One JSON document at `config/work.json` `storePath`, validated by
`src/work/store.schema.json`:

```json
{"schemaVersion":"v1","revision":1,
 "items":[ <WorkItem>, ... ],
 "submissions":[{"submissionId":"sub-<16 hex>","digest":"sha256:<64 hex>","itemIds":["demo-a"],"caller":"coordinator","submittedAt":"<ISO Z>"}]}
```

`checkWorkStore` enforces rules (a) to (g): the schema passes, every item
passes `isWorkItem`, item ids are unique, `submissionId`s are unique, every
`itemIds` entry is a store item in exactly one submission, every dependency
is a store item id, and `findCycle` is null. Items are never removed, so
dependencies stay valid for later submissions. Writes also enforce rule
(h), append-only: every stored item id stays present and every stored
submission stays equal under `canonicalJson` at its index (key order may
change on disk), checked on every write.

An absent file with an existing parent reads as revision 0 with no items.
A missing parent, a non-file path, or an I/O error is a `WorkStoreDataError`.

## Writes

Every write is `updateWorkStore(path, fn)`: take the lock file
`<storePath>.lock` with `withFileLock("work store lock", ...)`, read the
store, run `fn`, write nothing when `next` is null, otherwise check rule
(h), persist revision + 1 after `checkWorkStore` passes and return
`r.value`. Lock errors map as: a held lock is `WorkStoreBusyError` for the
caller to retry; `open-failed` is `WorkStoreDataError` with the cause, the
same class a missing parent gives on read; every other lock failure is
`WorkStoreWriteError`, including a release failure after the write already
committed, so a caller re-reads the store before it retries. Readers take
no lock: rename is atomic.

The lock body lives in `src/fs/lock.ts` (`withFileLock` plus `FileLockError`
with the label in front of every message). `src/ledger/lock.ts` keeps the
`withLedgerLock` export as a wrapper that rethrows only a `FileLockError`
as `LedgerDataError`; errors from `fn` pass through untouched.

## Reads

`readyItems(store)` returns items with `status === "queued"` whose every
dependency is `done`, in store order. `findCycle(items)` is an iterative
depth-first search over white, gray and black colours: roots in array
order, dependencies in array order and only into ids present in the input.
The first edge u -> v with v gray returns `{from:u, to:v,
cycle:[v, ..., u, v]}`; a self-dependency gives `{from:x, to:x,
cycle:[x,x]}`.

`canonicalJson` sorts object keys by default sort order, keeps arrays in
order, uses no whitespace, and writes scalars with `JSON.stringify`;
`sha256Hex` digests the canonical text.

## Configuration

`config/work.json` (`loadWorkConfig`): `storePath`, `factorySpecsPath`,
`models` (non-empty, unique; the server never calls `getProviders`, which
would fail on a missing `baseUrlEnv`), `maxItemsPerSubmit` (1-500),
`maxItemBytes` (1024-1048576), `maxStoreItems` (1-100000). Every key is
required, no extra key is allowed.

`config/factory-specs.json` (`loadFactorySpecs`): a non-empty JSON array of
`FactorySpec` entries with unique `repo`. The loop runner reads `mergeMode`
from it.

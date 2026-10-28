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

## Submissions

Submissions arrive through `submit_work` (`src/work/submit.ts`, steps S2
1-12). Steps 1-6 are pure and run before the lock: byte size over
`maxItemBytes`, the WorkItem contract, initial loop state, repo in the
factory specs, model in `models`, and duplicate ids in submission order.
Steps 7-12 run inside `updateWorkStore`: replay on a matching
`sha256:` digest (no write), `id-exists`, `unknown-dependency` (a
sibling or a stored id), `dag-cycle` over submission edges only, and
`store-full` past `maxStoreItems`. All pass appends the items in order
and one submission at revision + 1 with `caller` and `submittedAt`.
A dependency may name a sibling in the same submission or an item
already in the store, which supports follow-ups that wait on an
existing item; a stored item cannot depend on a new id, so cycles only
use submission edges. The predicates run in order and the first failure
is returned; item ids are synthetic slugs.

## Writes

Every write is `updateWorkStore(path, fn)`: take the lock file
`<storePath>.lock` with `withFileLock("work store lock", ...)`, read the
store, run `fn`, write nothing when `next` is null; otherwise build the
next store at revision + 1, run `checkWorkStore` on it, then rule (h)
against the store that was read, and only when both pass persist it and
return `r.value`. A `next` that breaks a W2 rule therefore fails on that
rule (for example rule (b) or (e)) before rule (h) is checked. Lock errors map as: a held lock is `WorkStoreBusyError` for the
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

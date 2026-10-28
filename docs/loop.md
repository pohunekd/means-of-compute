# Loop runner

The loop runner drives factory work items from ready to merged or blocked.

## Stores and owners (S1)

| Store                                   | Owner (writer)                                                                | What it holds for the loop                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| work store `logs/work-items.json`       | MCP `submit_work` (append); loop (item fields)                                | `status`, `statusReason`, `assignedHostAlias`, `branch`, `pullNumber`, `modelRouting`, `retryCount`, `stallRounds`, `dod[].done`. The projection that other components read. |
| loop state `logs/loop-state.json`       | loop only                                                                     | The journal: phase, start intent, rounds, escalations, follow-ups, finalize flag. It is the source of truth for the loop, and the work store is reconciled to it.            |
| result record `logs/loop-results.jsonl` | loop only                                                                     | One line per completed round, schema `src/loop/results.schema.json`.                                                                                                         |
| registry                                | dispatcher                                                                    | Sessions (`requestId`, terminal, `ledgerAppended`).                                                                                                                          |
| ledger                                  | dispatcher (session pending), auditor (audit pending), loop (`finalizeUsage`) | Spend and attempts.                                                                                                                                                          |
| verdict store                           | auditor                                                                       | One verdict per item and head.                                                                                                                                               |
| GitHub                                  | loop through the gh port                                                      | PR, marker comment, merge, issues and comments.                                                                                                                              |

## Loop state (S2)

`src/loop/state.schema.json` validates `{schemaVersion:"v1", revision, items:{<id>: LoopItem}, resolvedApprovals:[...], mergeHold, lastDigestDay:"YYYY-MM-DD"|null}`.

A `LoopStateItem` is typed `Record<string, unknown>` and validated to the
`LoopItem` shape that `src/loop/types.ts` mirrors: phase, round, start
intent, request id, pull, CI start, trial, round records, failures,
excluded hosts, start rejections, escalations, follow-ups, human
interventions, finalize flag, audit and merge attempts, backoff bound.

Writes use `updateLoopState(path, fn)` in `src/loop/state.ts`. It takes the
state lock, reads the file, runs `fn`, checks the schema plus the rules
below, and persists with one atomic write.

The rules: (a) PR 1 checks only the id shape in `state.schema.json`; the
full membership check (every key is a work store id) belongs to a later
recovery slice. (b) `phase === "starting"` iff `start !== null`. (c)
`requestId !== null` for phases `running` to `merging`. (d) Round numbers
are strictly increasing. (e) Attempt counts start at 1. `mergeHold` and
`lastDigestDay` travel with the same write.

A held lock gives `LoopStateBusyError`, which is fatal: only one factory
loop may run on a state. An absent file with an existing parent reads as
empty. Any other read problem is `LoopStateDataError`.

## Write rule (S3)

For every transition the loop writes the loop state first, then the
external effect, then the work store. Every work store field is an
absolute value computed from the loop state, never an increment; replaying
a write is a no-op. The recovery pass rewrites any store item that differs.

## Policy (PR 2)

This slice adds the pure policy the later driver calls:

- `src/loop/types.ts` mirrors `state.schema.json` record shapes.
- `src/loop/policy.ts` holds the outcome classes (table O2), the newly-met
  DoD signal (merged rounds meet every DoD id, minus earlier rounds), the
  stall decision (three stagnant rounds park, then retry, then block), and
  model choice (rule F: used fallback, failure count, result steering).
- `src/loop/results.ts` reads and appends `logs/loop-results.jsonl`: a torn
  tail is ignored on read and repaired on append, duplicate keys keep the
  first line, and rules R-a (key equals `<workItemId>:<round>`) and R-b
  (routing match) guard every line.
- `src/loop/brief.ts` builds the session brief byte-exactly and drops audit
  findings from the end when the `maxBriefBytes` limit requires it.

## GitHub port (PR 3)

`src/loop/github.ts` exposes `GitHubPort` with `createGhPort`: every gh
call goes through one runner with a fixed env, a bounded wait, and
body files under the config dir, and `mergePull` pins the merge with
`--match-head-commit`. `src/loop/merge-rule.ts` holds the pure checks
`ciStatus`, `pullDecision`, `factoryMarkers`, `verdictCheck`,
`markerMatches`, `m1`, `mergeStep`, and `baseCheck`. They encode repo
rules 1, 2, and 4: green checks, valid audit verdicts with matching
markers, and pinned merges; rule 3 stays in PR 5.

## Driver core (PR 5)

`LoopItem` carries `retry`, `park`, `session` and `fallbackUsed`; rule (f) keeps parks on `idle` or `final` and ties a `blocked` park to a `blocked` finalize.
`src/loop/log.ts` appends one JSON line per event through one chain and latches `failed()` on the first failed write.
`src/loop/project.ts` projects every store field from the loop item and `reconcile` rewrites a differing item, reports `busy` on a held lock, and throws the rule (a) text on an unknown id. Rounds with outcome start-rejected or lost never count toward modelRouting.attempts.
`src/loop/rounds.ts` appends the round record, then the result line, logs `round-closed`, and returns the stall decision; `appendMissingResults` backfills missing lines.
`src/loop/approvals-view.ts` re-reads the requests file on every call and reports the pause state and the merge triple match.

## Driver park (PR 5b)

`src/loop/park.ts` advances parked items: every tick first reconciles the fresh loop item as it stands, whatever its phase or park, so a busy store repairs itself on the next tick instead of throwing. A stall park escalates once per retry, retries them up to `stall.maxRetries` times, then turns blocked with a ledger finalize; it edits the item's issue labels when it has one. A lost park waits for the next tick, and an operator park holds for a human.
## Sandbox stub (PR 4)

`src/loop/git.ts` runs the loop's git calls with a fixed env, a bounded
wait and no shell, and exports `fetchRefs`, `remoteBranchSha`,
`revParse`, `isAncestor` and `trialMerge`. `trialMerge` rehearses the
merge in a scratch worktree, cleans leftovers first, and always removes
the worktree. `src/loop/stub/github.ts` implements `GitHubPort` over a
sandbox `origin.git`: live tips, real merges pinned by CAS update-ref,
and a shared counter for PRs and issues. The gh `stderrPrefix` cuts on
UTF-8 boundaries after redacting the token.

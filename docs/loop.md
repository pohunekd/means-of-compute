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
- Rule A (`auditableChoice`): a round starts only on a model that, added to the item's ledger authors (`authorModelsOf`), still leaves an eligible configured auditor. Otherwise it runs on the preferred model when that one does, and logs `fallback-refused`. If neither does, the item parks `operator: no-eligible-auditor` before any session starts. With Spark and Glimmer as the only routine auditors, the failure-count fallback therefore never fires after the preferred model has run on the item: a failing item stays on its model and the stall rule parks, retries and blocks it. Steering at start still moves a whole item to the fallback model.
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
`--match-head-commit`, and `checkAnnotations(repo, checkRunId)` reads a check run's annotations. `src/loop/merge-rule.ts` holds the pure checks
`ciStatus`, `pullDecision`, `factoryMarkers`, `verdictCheck`,
`markerMatches`, `m1`, `mergeStep`, and `baseCheck`. They encode repo
rules 1, 2, and 4: green checks, valid audit verdicts with matching
markers, and pinned merges; rule 3 stays in PR 5.

## Driver core (PR 5)

`LoopItem` carries `retry`, `park`, `session` and `fallbackUsed`; rule (f) keeps parks on `idle` or `final` and ties a `blocked` park to a `blocked` finalize.
`src/loop/log.ts` appends one JSON line per event through one chain and latches `failed()` on the first failed write.
`src/loop/project.ts` projects every store field from the loop item and `reconcile` rewrites a differing item, reports `busy` on a held lock, and throws the rule (a) text on an unknown id. Rounds with outcome start-rejected or lost never count toward modelRouting.attempts.
`src/loop/rounds.ts` appends the round record, then the result line, logs `round-closed`, and returns the stall decision; `appendMissingResults` backfills missing lines. A close with `finalize` moves the item to `finalizing` with a success finalize in the same write.
`src/loop/approvals-view.ts` re-reads the requests file on every call and reports the pause state, the merge triple match and the approved session resolves (`approvedResolves`).

## Driver start (PR 5c)

`src/loop/start.ts` drives work item starts from claim to timeout:

- `claimStart` parks the item as operator `start-rejected` when its rejection count is already at `maxStartRejections`. Otherwise it creates the loop item with `initialLoopItem` for a fresh store item and writes the start intent with the request id derived from the ledger. It makes no store write, because `starting` projects to `queued`. `driveStart` derives the request id again before it calls `dispatcher.start` with the stored intent.
- `rejectStart` closes a `start-rejected` round, and `closeRound` excludes the host and raises `startRejections` in the same write. A start rejection excludes the host for the item until a start succeeds. When every eligible host is excluded, placement tries the excluded hosts again (log `exclusions-retried`); each rejection still counts, and the item parks as operator `start-rejected` at `maxStartRejections`. The rejection code stays in the dispatcher: in the registry terminal detail for a ledgered rejection, and in the dispatcher's `start-rejected` log event otherwise.
- A refused start returns to idle with a `budgetBackoffMs` backoff, and a failing gate logs `budget-gate-error`. On an unreachable host, `driveStart` sleeps `unreachableRetryMs` and retries the same intent until the dispatcher returns `lost`.
- `watchSession` applies the terminal table. It drops a result when the item is no longer `running` with the same request id. `checkSessionTimeout` reads the durable registry `startedAt` and cancels an overdue session; the next watch replays `stalled` and moves the item to `publishing`. On a request drift, `driveStart` cancels every live session of the item before the operator park. An unreachable drift cancel logs `drift-cancel-unreachable` and returns idle; R6 reports the live session meanwhile.

## Driver review (PR 5d)

`src/loop/review.ts` drives an item from its finished session to an audited head:

- `publishStep` takes the session attempt from a watch replay and the branch from the registry entry. It adopts the one open PR of the branch that the factory login authored from the same repository and whose body starts with `<!-- moc:work-item:<id> -->`, or creates one. It parks two such PRs as operator `duplicate-pulls`. When no such PR is open but another PR on the branch is, it parks operator `foreign-pull`, because the factory login may be a human's login; a foreign PR next to the factory's own PR is ignored. When the branch has no new head, it closes the round as `no-push`, `no-new-commit` or `session-failed`. Otherwise it writes the pull, `ciSince` and phase `ci`. The created PR body uses `Closes #<issue>` for intake items (item.issue set) so the merge closes the issue; follow-up issues keep `Refs`. A fix round after `findings` (or any later round) starts on the item's existing branch: the dispatcher first retires the earlier sessions on that host, the new session resumes from `origin/<branch>` with the findings in its brief, and its push moves the head of the same PR, which `publishStep` adopts by its marker.
- `ciStep` reads the PR view first: a moved head on an open PR resets the pull head and `ciSince` without closing the round. Green checks move the item to `auditing`, red checks close `red-ci` with the failing check names, and checks still pending after `ciTimeoutMs` close `ci-timeout`.
- `auditStep` waits out `backoffUntil`, fetches the branch and the base, and returns to `ci` when the fetched head moved. A stored verdict at the head is posted without a new audit. Otherwise it counts the attempt in `auditAttempts` before `runAudit`, and parks `audit-failed` once `1 + audit.retries` attempts at that head were used.
- After `runAudit`: a budget refusal or a failing gate restores the count and sets the backoff; a model error retries, and the `audit-model-error` line carries `detail`, the error message cut to 300 bytes; an empty or oversized diff closes the round; a missing author or auditor parks the item; an `InputPathError` is fatal; any other error parks `audit-error`.
- A valid verdict is posted once as the factory marker, and the item stays in `auditing` for the merge slice. A GitHub or git error keeps the phase and logs `github-error`.
- A red close appends the round and reconciles the store to `queued`; the pull and the branch stay. `previousRoundOf` gives the next brief the outcome of the last session round, the findings of the last audited head, and, while the PR head is still the head of a `red-ci` round, that round's failing check names and its check excerpt. A red close stores the excerpt on the round: the `failure` annotations of each failing check (`GitHubPort.checkAnnotations`), without the runner's generic exit-code line, with the `github.checkExcerpt.stripPrefixes` runner paths removed, cut to `github.checkExcerpt.maxBytes`. The log line records only its size.

## Driver merge (PR 5e)

`src/loop/merge.ts` takes an audited item to merged:

- `mergeCheck` reads a fresh PR view and evaluates M1 to M5 through `mergeStep`: a moved head returns to `ci`, CI that is not green returns to `ci` with a new `ciSince`, findings close the round, an invalid verdict or a closed or wrongly based PR parks the item, and `human-approval` waits for an approval of the exact item, pull and head.
- A ready item merges under one mutex: no merge starts while `mergeHold` is set; a base that is not an ancestor of the head needs a passed trial merge, and a failed trial closes `trial-failed`; the item enters `merging` with the base in `trial`, and a moved base restarts the step. Merge attempts are bounded by `github.mergeRetries`.
- After the merge, the loop claims rule 3 only when the merge commit's parents are exactly the tested base and the head. Otherwise it sets the global merge hold, escalates once, and still finishes the item with `baseRace` in the round record.
- The merged close moves the item to `finalizing` in one write; `finishMerge` runs the ledger finalize, then writes `final`. A merge seen outside `merging` counts as a human intervention.

## Scheduler (PR 6a)

`src/loop/scheduler.ts` runs one tick at a time over every loop item:

- A tick appends missing result lines, reports orphan sessions once and escalates them, clears the merge hold when the base contains the merge and its checks are green, reconciles each item fresh with no call in flight, and launches one step call per item by phase: start, watch, publish, CI (at most every `ciPollMs`), audit and merge in one call, merge, finalize, or the park step. No new call or claim starts after `stop()` or a latched failure, even mid-tick.
- A running item also gets the session timeout check. No step call starts for an item while its timeout check is in flight. A failed call stops the scheduler: the next tick rejects with that error, and `settled()` rejects with it once every non-watch call has settled.
- Unless the fleet is paused, it claims ready items in store order up to `maxActiveItems`, outside their backoff window, with the model rule and rule A, placement over the collected hosts minus the item's excluded hosts and counting `starting` items from earlier ticks and the same tick, and the brief; a brief over `maxBriefBytes` parks the item as operator `brief-too-large`.
- At startup, a `running` or `review` store item without a loop item, or with an idle one, stops the factory with `loop state missing for <ids>`.

## Intake (PR 6b)

`src/loop/intake.ts` imports GitHub issues when `github.intake.enabled` is set, at most once every `pollMs`, after the step calls of a tick and before its claims. An open issue that carries the opt-in and ready labels, comes from a trusted author, has a `## DoD` list, has only closed dependencies, and fits the size limits becomes a queued item `gh-<idPrefix>-<number>`. An issue already imported under its own id is skipped silently; every other skipped issue logs `intake-skip` with its code, and an issue already tracked under another id logs once per process run.

## Follow-ups and digest (PR 7)

`src/loop/followups.ts` files one issue per low finding of the merged verdict before the item turns final, and one blocked issue (rounds, pull request, last findings) when an item is blocked. Each issue starts with a `moc:followup` key marker, finding text sits in code fences longer than any backtick run inside it, the key is recorded before the create, and an existing factory issue with the marker is adopted, so a replay files nothing twice. `src/loop/digest.ts` writes `<digest.dir>/<day>.md` once for the previous UTC day after each new day starts (merged, running, parked and blocked, spend), with no goal, finding or issue text.

## Stub ports (PR 8)

`src/loop/stub/` holds the demo seams. `sandbox.ts` resets only a directory marked `.loop-demo` (the registry file goes, its lock stays), seeds `origin.git` and `checkout/` from the demo repo, creates the factory-owned directories and writes the budget guard copies with state inside the sandbox; its git runner allows only the subcommands the demo needs. `worker.ts` handles each live memory-port session once: one streamed call through the real meter, the scripted patch committed as `moc-demo` and pushed to the sandbox origin, then `finished`; a failed meter or git step completes the session `failed`. The memory port refuses a start while another session on the host holds the branch. `observations.ts` reports the HostCapacity documents of the observations file on every collect. `callProvider` is exported for the stub audit call.

## Stub run (PR 9)

`bun run loop --stub --queue <file>` runs the demo with no login, no env and no network beyond 127.0.0.1. It holds the registry lock for the whole run, resets and seeds the marked sandbox, seeds the queue through the `submit_work` checks, starts the meter over the provider loopback, and drives the real scheduler, dispatcher, budget guard, audit and merge rule with the memory port, the stub GitHub and the stub worker until no queue item can move. It then writes the day's digest, plus `ports.jsonl` (meter, port and dispatcher events) and `github.json` (the stub GitHub snapshot, written on a normal end and on a signal stop) inside the sandbox, prints `loop: stub run done merged=<m> blocked=<b> parked=<p>`, and exits 0 when every item merged or 3 otherwise. Every failure before `loop: running (stub)` exits 2; a runtime fatal after it exits 1. The first SIGINT or SIGTERM stops the run with exit 0, and a second signal is ignored. `src/loop/compose.ts` holds the config loading, the lock, the closers and the scheduler context that production mode reuses.

## Production run (PR 10)

`bun run loop` runs production mode. Before the registry lock it checks the GitHub identity (the token variable named by `github.tokenEnv` is set, `github.factoryLogin` is set, and gh's viewer login equals it), the writable state paths, the factory-owned directories (created when absent) and each checkout; any failure prints `loop: <message>` and exits 2. Startup refuses a `shutdownGraceMs` that does not exceed the largest audit provider `timeoutMs`, so an audit in flight at a stop settles and is ledgered before exit. It then starts the meter, the Pohunek dispatch and host-state ports, runs the recovery pass, prints `loop: running (<n> active)`, and ticks until the first SIGINT or SIGTERM; later signals are ignored. Every exit path stops the scheduler and waits for its steps at most `shutdownGraceMs` before the closers run; a step failure the scheduler reports while it stops makes the run exit 1. The dashboard stays `bun run factory:serve`. Port, meter, dispatcher and host-state events go to `loop-ports.jsonl` next to the loop log.

## Driver park (PR 5b)

`src/loop/park.ts` advances parked items: every tick first reconciles the fresh loop item as it stands, whatever its phase or park, so a busy store repairs itself on the next tick instead of throwing. A stall park escalates once per retry, retries them up to `stall.maxRetries` times, then turns blocked with a ledger finalize; it edits the item's issue labels when it has one. A lost park waits for the next tick, and an operator park holds for a human.

## Sandbox stub (PR 4)

`src/loop/git.ts` runs the loop's git calls with a fixed env, no shell,
each child in its own process group killed at the deadline, and exports
`fetchRefs`, `remoteBranchSha`, `revParse`, `isAncestor` and
`trialMerge`; it needs absolute `dir` and `scratchDir`. `trialMerge`
builds the result, runs step-6 cleanup, then returns it with the
`cleanupFailed` the cleanup set; steps 1 to 5 share one
`start + timeoutMs` deadline, and a git call of steps 1 to 4 past it
gives `reason: "timeout"` with `step: null` while a step command past
it gives `step: <index>`; step 6 shares `cleanupStart + timeoutMs`.
A `GitError` from `git.ts` maps to `rejected` (`failed`, rc 128) or
`unavailable` (other); a non-zero rc of the stub's own git commands in
a port call is `rejected`, a timeout is `unavailable`; the `mergePull`
scratch cleanup is best effort and never changes the result.
`src/loop/stub/github.ts` implements `GitHubPort` over a sandbox
`origin.git` with absolute dirs and async ports; `detail` and the gh
`stderrPrefix` are cut on UTF-8 boundaries; an unspawnable step is
`step-failed` with `rc: null`; merge rc 1 without the conflict line is
`GitError` `failed`.

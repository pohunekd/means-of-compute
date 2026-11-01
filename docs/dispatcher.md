# Dispatcher

The dispatcher turns a queued work item with a placement decision into a
session on the chosen host, watches the session to a terminal result, and
reschedules the item when the session is lost. Everything behind it depends
on the `DispatcherPort` interface, never on the adapter.

## What the dispatcher does

`createDispatcher` (`src/dispatcher/dispatcher.ts` `createDispatcher`) owns the lifecycle:

- `start` (`src/dispatcher/dispatcher.ts` `start`) admits the item through the
  budget gate, derives the `StartRequest`, and opens the session through the
  port under the item lock. The request and the session handle persist in the
  registry file named by `registryPath` (`config/dispatcher.json` `registryPath`).
  The entry the start inserts also records `placement`: the `reason` and
  `candidates` of the `PlacementDecision` it was given, as
  `src/placement/place.ts` produced them, hosts by alias only. Later writes
  keep it. The dashboard Work table shows it.

Handle validation checks the returned session handle and rejects with `invalid-handle` when they fail. The checks include `worktree-unique`: the handle's worktree on its host must not be the worktree of a live (non-terminal) registry entry of another request. The check reads the registry again after the port call.

- `watch` (`src/dispatcher/dispatcher.ts` `watch`) polls `port.wait` with
  `waitTimeoutMs` (`config/dispatcher.json` `waitTimeoutMs`) and persists every
  non-terminal observation. When the port reports a terminal result the
  dispatcher settles the ledger and finishes.
- `cancel` (`src/dispatcher/dispatcher.ts` `cancel`) stops the session with a
  reason (`stall`, `host-left`, `user-returned`, `operator`) and returns the
  terminal result.
- `resolve` (`src/dispatcher/dispatcher.ts` `resolve`) finishes a stuck request:
  an unresolved provisional entry left behind by a transport failure, or any
  unresolved terminal entry. See "Resolving a stuck request".
- Rejected start: when `port.start` refuses with any code other than the two
  conflict codes, the dispatcher settles the meter grant through
  `settleUsage(requestId, "failed")` (`src/dispatcher/dispatcher.ts` `start`).
  With no grant the provisional entry is removed and `start-rejected` is logged,
  as before. With a grant the rejection becomes a terminal `failed` attempt
  (`src/dispatcher/dispatcher.ts` `finishRejected`) with detail
  `start-rejected: <code>`, 0 seconds and the measured usage, appended to the
  ledger before `start-rejected-ledgered` is logged and the same
  `PortRejectedError` is rethrown. The next `start` derives n + 1, so a retry
  on another host or model gets a fresh grant. A crash between the settle and
  the registry write leaves the provisional entry with a closed grant; the
  replay meets `grant-closed` as unreachable and advances n through `lost`.
- Lost detection: after `lostAfterUnreachable` (`config/dispatcher.json`
  `lostAfterUnreachable`) consecutive `wait` misses the
  dispatcher reports `lost` with detail `unreachable <n> times`
  (`src/dispatcher/dispatcher.ts` `watch`, `src/dispatcher/dispatcher.ts` `finishLost`).
- Settling usage: `createDispatcher` takes a required
  `settleUsage(requestId, state)` hook (`src/dispatcher/dispatcher.ts`
  `DispatcherDeps`). `finishLost` settles with `"lost"` before the first
  registry write; the rejected-start path settles with `"failed"`. The factory
  wires it to `meter.settleRequest` (`src/meter/meter.ts` `settleRequest`).
- Pause rule: a non-terminal `wait` becomes a write, a lock release, a sleep
  of `nonTerminalPauseMs` (`config/dispatcher.json` `nonTerminalPauseMs`),
  and a loop (`src/dispatcher/dispatcher.ts` `watch`).
  A revision discarded by a concurrent hold loops at once; a miss sleeps
  `unreachableBackoffMs` (`config/dispatcher.json` `unreachableBackoffMs`).

## The port and its implementations

`DispatcherPort` (`src/dispatcher/port.ts` `DispatcherPort`) is the only seam to the
session daemon: `start`, `wait`, `diff`, `cancel`, `release`, `retire`, `close`, with
`PortUnreachableError` for transport failures and `PortRejectedError` (with
a kebab-case `code`) for daemon refusals. Two implementations exist:

- The memory port (`src/dispatcher/memory-port.ts` `createMemoryPort`) keeps sessions
  in-process. Tests use it; it never touches the network.
- The Pohunek adapter (`src/dispatcher/adapter/pohunek-port.ts` `createPohunekPort`) drives
  real daemons through the SDK behind `openPohunekPort`
  (`src/dispatcher/adapter/pohunek-port.ts` `openPohunekPort`). The port takes a `meterToken` function, or `null`; `start` writes the token into `moc.meterToken`; a `null` port refuses `start` with `no-meter`; a voided start clears the key. A voided start stops the session, clears its `moc.*` binding, then removes it with `session.remove_accepting_unconfirmed` so the branch is free for the retry; a failed removal logs `adapter-void-remove-failed` and leaves the session stopped and unbound. Removal keeps the branch, so a later fresh start of the item on that host checks the existing branch out and, once the base has moved, the daemon reports `base_branch_fallback`; the adapter keeps that start only when `session.diff` against the request's `baseRef` is empty and not truncated, and the session then works from the branch's older head. A non-empty, truncated or failed diff (`adapter-reuse-diff-failed`), a resume start, or a `fetch` warning voids the start (`base-branch-fallback` or `fetch-failed`). The port runs one `start` at a time per host alias, because concurrent worktree creations on one host race on its git fetch; a start waits until every earlier start on its host has settled, accepted or not, and starts on different hosts run in parallel (`src/dispatcher/adapter/pohunek-port.ts` `queuedStart`). It is the only code that
  may import the SDK: no other module imports it
  (`docs/architecture.md` Boundaries).

`retire(ref)` removes a terminal session and its worktree on the host and keeps the branch (Pohunek `session.remove_accepting_unconfirmed`, because a same-user process with an unreadable environment would otherwise block every removal; such processes are not signalled); an unknown session is `absent`; a session the host still reports live is refused `session-live`, so a round whose earlier session was closed as lost but still runs ends start-rejected and escalates. Before every start the dispatcher retires the item's earlier ledgered sessions on the target host and logs `retired`, because a host keeps a finished session's worktree and git refuses a second worktree for that branch (`worktree-branch-in-use`). `dispatcher.retire(requestId)` retires one settled, ledgered entry under the item lock, logs `retired`, and then sets the entry's `retiredAt` for both `removed` and `absent`. An entry that already has `retiredAt` is skipped without a port call. The loop calls it for every closed round. `retiredAt` and `placement` are the optional entry fields, so registries written without them still validate. The retire-before-start loop ignores `retiredAt` and gets `absent` for a session that is already retired.

`release` (`src/dispatcher/port.ts` `ReleaseRef`) stops every session on the host
that is either the known `sessionId` or bound to the `requestId` and removes
the binding of each bound one. It returns the sessions found and stopped, the known
id first then the bound ones in daemon order with no duplicates, or `[]` when
none was there. It never creates a session and never sends input. A refused
`session.list` or connector call gives `PortRejectedError(code)` with that
call's code; a refused stop or unbind gives
`PortRejectedError("void-incomplete")`; a transport failure gives
`PortUnreachableError`; sessions stopped and unbound before the failure stay
so. This trusts that the binding metadata survives a daemon
restart: an empty `session.list` reading means nothing is bound.

## Adapter configuration

`config/pohunek-adapter.json` holds every key below; all are required, no
extra key is allowed, and any violation fails startup with exit 2 naming the
key (`src/dispatcher/adapter/config.ts` `loadPohunekAdapterConfig`):

- `agentProfile`: the agent profile created on the host (non-empty string).
- `project`: the project the session joins (non-empty string).
- `cols`, `rows`: the terminal size, each an integer in `20..1000`.
- `inputAckTimeoutMs`: how long `session.new` waits for the input ack, an
  integer in `1..8000`.
- `connectTimeoutMs`: per-host connection timeout, an integer in `1..60000`.
- `cancelWaitTimeoutMs`: how long `cancel` waits for the terminal, an integer
  in `1..86400000`.
- `diffLogPath`: where the `dispatch:diff` CLI appends one JSON line per
  adapter event (`logs/dispatch-diff.jsonl`).
- `resolveLogPath`: where the `dispatch:resolve` CLI appends one JSON line
  per dispatcher, adapter and meter event (`logs/dispatch-resolve.jsonl`).
- `hostRoutesFileEnv`: the env variable naming the host routes file
  (`MOC_HOST_ROUTES_FILE`).

The routes file maps each host alias to its route. It holds at least one
alias; each alias matches `^[a-z][a-z0-9-]{0,31}$` and each route is a
non-empty string (`src/dispatcher/adapter/routes.ts` `checkRoutesFile`). Errors name the bad
alias and the file path, never the route
(`src/dispatcher/adapter/routes.ts` `checkRoutesFile`). Synthetic example:

```json
{ "laptop-a": "<route>" }
```

## The CLIs

`dispatch:start --dry-run` (`src/dispatcher/cli.ts` `runDryRun`) takes `--item`,
`--decision`, `--provider`, `--model`, `--ledger` and `--brief-file`, prints
the `StartRequest` as JSON (with the brief replaced by its sha256 and byte
count), and exits 0 without calling the gate or the port and without writing
anything. Any other use exits 2.

`dispatch:resolve` (`src/dispatcher/cli.ts` `runResolve`) takes `--request <id>`,
exactly once and required (`src/dispatcher/resolve-command.ts` `parseResolveArgs`).
It prints the `ResolveOutcome` as one JSON line and exits 0; a second run
prints `already-resolved` and exits 0. An unknown or malformed request
exits 2 with `dispatch: <message>`; an unreachable host exits 3 with
`dispatch: <requestId>: unreachable`; a refused release exits 3 with
`dispatch: <requestId>: <code>`; a settled active entry exits 3 with
`dispatch: <requestId>: request-active`; a busy registry exits 3 with
`dispatch: registry busy`. Any other error exits 2 with one line
`dispatch: <message>` (`src/dispatcher/cli.ts` `runResolve`). Output names
only the request id, the host alias and error codes, never routes or port
messages. Every dispatcher, adapter and meter event appends one JSON line
`{"at": <ISO time>, "source": <"dispatcher" | "adapter" | "meter">, ...event}`
to `resolveLogPath` (`logs/dispatch-resolve.jsonl`), creating the parent
directory; nothing from those logs reaches stdout. A failed append prints
one `dispatch: resolve log: <code>` line to stderr per run and drops later
failures silently. A close failure prints one `dispatch: close <meter|port>: <code>`
line and does not change the run's output or exit code.

The CLI holds the registry owner lock (`<registryPath>.lock`) for the whole
run through `withFileLock` (`src/fs/lock.ts` `withFileLock`), so two runs
exclude each other and a running factory is excluded too. The CLI runs the
meter for the length of one resolve because the meter is the only writer
of the usage log; the null meter token keeps `start` refused.

`dispatch:diff` (`src/dispatcher/cli.ts` `runDiff`) takes `--host <alias>`,
`--session <id>` and `--base <ref>`, each exactly once and all required
(`src/dispatcher/diff-command.ts` `parseDiffArgs`). It prints the daemon
`unifiedDiff` to stdout exactly as returned and exits 0; when the daemon reports
`truncated` it also prints `diff truncated by daemon` to stderr
(`src/dispatcher/diff-command.ts` `runDiffCommand`). When the reader closes
stdout early (for example `| head`), the rest of the diff is dropped, nothing
more is printed, and the exit code is the one the command returns anyway: 0 for
a fetched diff (`src/dispatcher/diff-command.ts` `ignoreReaderClosed`). An
unknown flag, a missing value or a missing flag exits 2 without opening the
port. An unreachable host exits 2 with `dispatch: <alias>: unreachable`; a
rejected diff exits 2 with `dispatch: <alias>: <code>`
(`src/dispatcher/diff-command.ts` `runDiffCommand`). Any other error exits 2
with one line `dispatch: <message>` (`src/dispatcher/cli.ts` `runDiff`). Every
adapter event appends one JSON line `{"at": <ISO time>, ...event}` to
`diffLogPath`, creating the parent directory; nothing from the adapter log
reaches stdout or stderr.

## Resolving a stuck request

`resolve` finishes a request that `watch` cannot move: an unresolved
provisional entry left behind by a transport failure, or any unresolved
terminal entry. It runs under the item lock, so a concurrent `start`,
`watch`, `cancel` or `resolve` waits for it. The outcome names which case
ran, in Q order:

| First match                | Port                                                                                    | Registry                                                                                                                      | Ledger                                               | Returns                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Q1: `resolvedAt !== null`  | none                                                                                    | replays the unappended line, if any (`dispatcher.ts:1144`)                                                                    | that replay's outcome, else none                     | `already-resolved` (`dispatcher.ts:1150`); the replay completes an unappended line |
| Q2: settled active entry   | none, no write                                                                          | none                                                                                                                          | none                                                 | `request-active` (`dispatcher.ts:1157`)                                            |
| Q3: unresolved terminal    | `release` over the request's host (`dispatcher.ts:1186`), then one write                | replays the entry's own line first if it is unappended (`dispatcher.ts:1176`), then marks `resolvedAt` (`dispatcher.ts:1203`) | the replay's outcome, else none                      | `resolved`, `from: "terminal"` (`dispatcher.ts:1219`)                              |
| Q4: unresolved provisional | `release` (`dispatcher.ts:1230`), then the meter closes the grant through `settleUsage` | one new `lost` terminal with `resolvedAt` (`dispatcher.ts:702`, `dispatcher.ts:1240`)                                         | exactly one new line, `entryId` `<item>:<requestId>` | `resolved`, `from: "provisional"` (`dispatcher.ts:1252`)                           |

`resolvedAt` (`src/dispatcher/registry.ts` `RegistryEntryBase`) is `null` until
`resolve` marks the entry, and stays set afterwards, so a second run is a
no-op that never touches the port. A settled active entry is refused with
`request-active`: `resolve` only handles entries `watch` cannot move. An
unreachable host or a refused `release` keeps the entry: nothing is marked;
only Q3's replay of the entry's own line may already have been appended,
and the next run retries. A meter failure after the port
was released is the same: the host is already clean, the next run finds
nothing bound and appends the line.

A refused `release` with `void-incomplete` leaves the sessions bound and the
entry unresolved. That is the daemon refusing `stop` or `unbind`; the entry
is safe to retry, but repeated `void-incomplete` needs the operator: clear
the stuck sessions on the host out of band, then run `resolve` again, which
finds nothing bound and finishes the entry.

## Host precondition

The factory machine runs a local daemon, and every fleet host passes the
start preflight before a session is created there: the daemon reports the
required capabilities and serves the configured agent profile
(`src/dispatcher/adapter/pohunek-port.ts` `startPreflight`). A failing host is refused
with `host-unsupported` and nothing is created
(`src/dispatcher/adapter/pohunek-port.ts` `startPreflight`).

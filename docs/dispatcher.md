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
- `watch` (`src/dispatcher/dispatcher.ts` `watch`) polls `port.wait` with
  `waitTimeoutMs` (`config/dispatcher.json` `waitTimeoutMs`) and persists every
  non-terminal observation. When the port reports a terminal result the
  dispatcher settles the ledger and finishes.
- `cancel` (`src/dispatcher/dispatcher.ts` `cancel`) stops the session with a
  reason (`stall`, `host-left`, `user-returned`, `operator`) and returns the
  terminal result.
- `resolve` (`src/dispatcher/dispatcher.ts` `resolve`) finishes a stuck request:
  a provisional entry left behind by a transport failure, or a terminal entry
  whose ledger line was never appended. See "Resolving a stuck request".
- Lost detection: after `lostAfterUnreachable` (`config/dispatcher.json`
  `lostAfterUnreachable`) consecutive `wait` misses the
  dispatcher reports `lost` with detail `unreachable <n> times`
  (`src/dispatcher/dispatcher.ts` `watch`, `src/dispatcher/dispatcher.ts` `finishLost`).
- Pause rule: a non-terminal `wait` becomes a write, a lock release, a sleep
  of `nonTerminalPauseMs` (`config/dispatcher.json` `nonTerminalPauseMs`),
  and a loop (`src/dispatcher/dispatcher.ts` `watch`).
  A revision discarded by a concurrent hold loops at once; a miss sleeps
  `unreachableBackoffMs` (`config/dispatcher.json` `unreachableBackoffMs`).

## The port and its implementations

`DispatcherPort` (`src/dispatcher/port.ts` `DispatcherPort`) is the only seam to the
session daemon: `start`, `wait`, `diff`, `cancel`, `release`, `close`, with
`PortUnreachableError` for transport failures and `PortRejectedError` (with
a kebab-case `code`) for daemon refusals. Two implementations exist:

- The memory port (`src/dispatcher/memory-port.ts` `createMemoryPort`) keeps sessions
  in-process. Tests use it; it never touches the network.
- The Pohunek adapter (`src/dispatcher/adapter/pohunek-port.ts` `createPohunekPort`) drives
  real daemons through the SDK behind `openPohunekPort`
  (`src/dispatcher/adapter/pohunek-port.ts` `openPohunekPort`). The port takes a `meterToken` function, or `null`; `start` writes the token into `moc.meterToken`; a `null` port refuses `start` with `no-meter`; a voided start clears the key. It is the only code that
  may import the SDK: no other module imports it
  (`docs/architecture.md` Boundaries).

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

`dispatch:diff` (`src/dispatcher/cli.ts` `runDiff`) takes `--host <alias>`,
`--session <id>` and `--base <ref>`, each exactly once and all required
(`src/dispatcher/diff-command.ts` `parseDiffArgs`). It prints the daemon `unifiedDiff` to
stdout exactly as returned and exits 0; when the daemon reports `truncated`
it also prints `diff truncated by daemon` to stderr
(`src/dispatcher/diff-command.ts` `runDiffCommand`). An unknown flag, a missing value or a
missing flag exits 2 without opening the port. An unreachable host exits 2
with `dispatch: <alias>: unreachable`; a rejected diff exits 2 with
`dispatch: <alias>: <code>` (`src/dispatcher/diff-command.ts` `runDiffCommand`). Any other
error exits 2 with one line `dispatch: <message>`
(`src/dispatcher/cli.ts` `runDiff`). Every adapter event appends one JSON line
`{"at": <ISO time>, ...event}` to `diffLogPath`, creating the parent
directory; nothing from the adapter log reaches stdout or stderr.

## Resolving a stuck request

`resolve` finishes one request that neither `watch` nor `cancel` can move: a
provisional entry left behind by a transport failure, or a terminal entry
whose own ledger line was never appended. It runs under the item lock, so a
concurrent `start`, `watch`, `cancel` or `resolve` waits for it. The outcome
names which case ran:

| First match | Port | Registry | Ledger | Returns |
| --- | --- | --- | --- | --- |
| `resolvedAt !== null` (already handled) | none | replays the unappended terminal line, if any | that replay's outcome, else none | `already-resolved` |
| Provisional with nothing bound and nothing to release | none | keeps the entry | none | `resolved`, `from: "provisional"`, `state: "lost"` |
| Terminal entry (K2/K4) | `release` over the request's host, then one write | marks `resolvedAt` | replays the unappended line first, if any | `resolved`, `from: "terminal"` |
| Provisional otherwise (K1/K3) | `release`, then the meter closes the grant | exactly one new `lost` terminal with `resolvedAt` | exactly one new line, `entryId` `<item>:<requestId>` | `resolved`, `from: "provisional"`, `state: "lost"` |

`resolvedAt` (`src/dispatcher/registry.ts` `RegistryEntryBase`) is `null` until
`resolve` marks the entry, and stays set afterwards, so a second run is a
no-op that never touches the port. A settled active entry is refused with
`request-active`: `resolve` only handles entries `watch` cannot move. An
unreachable host or a refused `release` keeps the entry: nothing is marked,
nothing is appended, and the next run retries. A meter failure after the port
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

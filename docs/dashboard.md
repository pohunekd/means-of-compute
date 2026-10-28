# Dashboard

One page served by the factory process. It reads the ledger file, verdict
store, prices and host state, and renders server-side; there is no client
JavaScript, no auto-refresh and no external resource. The operator reloads
the page. Every figure names its source; for money, the config price entry.
No estimated numbers: a missing input shows "no data", and an unreadable
one shows an error code with details in `logs/dashboard.jsonl`.

The factory process runs two listeners: the meter's (overlay address,
reachable by fleet hosts) and the dashboard's, on a loopback address. They
are never one listener: the dashboard has no authentication, so it must not
sit on the fleet-reachable meter listener. `factory:serve` starts only the
dashboard in this issue.

## Run

```sh
MOC_DASHBOARD_LISTEN=127.0.0.1:8080 bun run factory:serve [--ledger <path>] [--verdicts <dir>]
MOC_DASHBOARD_NOW=2026-10-27T12:00:00.000Z bun run factory:serve  # tests only
```

- `--ledger` defaults to the `ledgerPath` of `config/ledger.json`.
- `--verdicts` defaults to the `verdictDir` of `config/auditor.json`.
- Each flag is optional and allowed at most once; the value is the next
  argument and must exist and not start with `--`. A repeat, an unknown
  flag, a positional argument or a missing value exits 2.
- `MOC_DASHBOARD_NOW` pins the clock for tests; unset means the real clock.
- Startup prints `factory: dashboard time pinned by MOC_DASHBOARD_NOW: <iso>`
  on stderr when pinned, then
  `factory: dashboard listening (dashboard) port <port>` on stdout. The
  ready line holds a loopback port, never an address.
- `SIGINT` or `SIGTERM` stops the server and exits 0.

The listen address must be loopback: an IPv4 address with the first octet
`127` (`127.0.0.0/8`), or `[::1]` exactly. Anything else, including every
wildcard (`0.0.0.0`, `[::]`), `0:0:0:0:0:0:0:1`, and every overlay or LAN
address, exits 2 naming the variable, never the value. The port is an
integer in `0..65535`; `0` means ephemeral and is used by tests.

Remote viewing is not in v1: run the command on the factory machine, or use
`ssh -L <p>:127.0.0.1:<p> <factory machine>` with the same port number, so
`localhost:<p>` passes the Host check. The request Host header must be
the bound host with the bound port, or `localhost:<port>`: for an IPv4
bind `{<host>:<p>, localhost:<p>}` where `<host>` is the configured
listen host, for a `::1` bind `{[::1]:<p>, localhost:<p>}`; anything
else, including a missing header, gets 421. Method must be `GET` (405) and
the path `/` (404, the query string is ignored).

## Config keys (`config/dashboard.json`)

Every key is required and no extra key is allowed, at the top level and
inside `baselines`; any failure exits 2 naming the key.

| Key                                    | Rule                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `listenEnv`                            | matches `^[A-Z][A-Z0-9_]*$`; currently `MOC_DASHBOARD_LISTEN`                                                                          |
| `listenAlias`                          | matches `^[a-z][a-z0-9-]{0,31}$`; currently `dashboard`                                                                                |
| `logPath`                              | non-empty string; must be writable at startup; currently `logs/dashboard.jsonl`                                                        |
| `maxRequestBytes`                      | integer in `1..65536`; currently `1024`                                                                                                |
| `idleTimeoutSec`                       | integer in `1..255`; currently `10`                                                                                                    |
| `workRowLimit`                         | integer in `1..1000`; currently `50`                                                                                                   |
| `baselines.frontierTokens`             | `null`, or an object with exactly `label`, `inputPer1M`, `outputPer1M`, `source`, `asOf`                                               |
| `baselines.cloudSandboxHour`           | `null`, or an object with exactly `label`, `perHour`, `source`, `asOf`                                                                 |
| `baselines.ownedHostHour`              | `null`, or an object with exactly `label`, `perHour`, `source`, `asOf`                                                                 |
| `label`                                | 1..80 chars, no control characters                                                                                                     |
| `source`                               | 1..300 chars, no control characters; a URL or a citation the owner can re-check. **Required: a baseline without a source is invalid.** |
| `asOf`                                 | a valid `YYYY-MM-DD` date                                                                                                              |
| `inputPer1M`, `outputPer1M`, `perHour` | JSON number `>= 0`, at most 9 decimals                                                                                                 |

## Baselines

The committed baselines are `null`. No number is invented: until the owner
supplies values, Savings shows "no data" with the source
`config/dashboard.json baselines.<key>` and the reason
`no <key> baseline in config/dashboard.json`. Each set baseline must carry
a `label`, a `source` the owner can re-check, and an `asOf` date; the
rendered citation repeats all three with the exact price.

## Panels

Fleet, Work, Usage, Savings, Autonomy, in that order. Token counts and
integers group digits (`1,200,000`); times are ISO UTC. A ledger failure
makes every ledger-derived cell `error(<ledger code>)`; the page shows the
code only, never the message. Figures listed "in order" render in that
order. The Work table shows `showing ${shown} of ${total} items`.

### Fleet

One table, caption `Fleet`, columns
`host, state, free capacity, running, observed`.
Source: `collector round of this request (HostCapacity); running sessions from the dispatcher registry`.

Rows are the sorted unique union of host aliases from the collector round
and from ledger `sessionSeconds`, each rendered as a checked alias cell.
`state`: collector failure when the round fails; `no data (not in this
collector round)` when the alias has no observation; `idle` for a reported
idle capacity; `not idle: <reason>` otherwise; `unavailable: <label>` for an
unavailable host (labels: `unreachable`, `request timed out`,
`daemon too old`, `daemon rejected the request`, `plugin not installed`,
`plugin disabled`, `plugin busy`, `plugin failed`, `plugin timed out`,
`output too large`, `output not UTF-8`, `other plugin package`,
`plugin version not accepted`, `output not JSON`,
`output fails the HostCapacity contract`, `reported alias differs`,
`report too old`, `report from the future`).
`free capacity` (reported hosts only): `CPU <n>% free, memory <free> of
<total> MB free, <gpu>`, where `<gpu>` is `no GPU`,
`GPU free memory unknown`, or `GPU <n> MB free`.
`running`: `no data (dispatcher registry not wired)` in this issue.
`observed`: the observation time, or the same failure/no-data as `state`.

### Work

One table, caption `Work`, columns
`item, status, host, branch, model, verdicts, last activity`.
Source: `work items, dispatcher registry, ledger and verdict store; status rule in docs/dashboard.md`.

Rows are the union of ledger record and pending `workItemId`s, sorted by
latest activity (ISO `finishedAt`) descending, then id ascending, truncated
to `workRowLimit`.

### Status rule (Work)

1. A known work item shows its status (plus reason when set).
2. Otherwise the ledger decides: `done` for a `success` record, `blocked`
   for a `blocked` record, else `session ended, not finalized` for pending
   entries.

`host` lists the item's session aliases, or `no data (no session)`.
`branch` shows `WorkItem.branch` when set, else
`no data (dispatcher registry not wired)`. `model` is
`no data (dispatcher registry not wired)` in this issue. `verdicts` lists
every verdict in store order as
`<sha12> by <auditor>: high <h>, medium <m>, low <l>`, or
`<sha12>: invalid (counts disagree)` when the counts disagree;
`none` when empty; `no data (no verdict store)` when absent; one row's
`verdicts-unreadable` failure stays on that row. `last activity` is the
latest ISO timestamp, or `no data (no timestamp)`.

### Usage

`day = utcCalendarDay(now)`. In order:

| Label                                     | Value                                                                | Source                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Spent today (UTC <day>)`                 | exact scaled sum, or no-data by the unknown rule                     | `ledger records and pending entries finished on <day>, tokens × price; <prices>`                       |
| `Day cap`                                 | `config/budget.json dayCapUsd`                                       | `config/budget.json dayCapUsd`                                                                         |
| `Spent total`                             | exact scaled sum, or no-data by the unknown rule                     | `ledger records and pending entries, tokens × price; <prices>`                                         |
| `Total cap`                               | `config/budget.json totalCapUsd`                                     | `config/budget.json totalCapUsd`                                                                       |
| `NVIDIA Build requests today (UTC <day>)` | `<n> of <limit>`, or no-data by the unknown rule                     | `ledger requests of provider <id> finished on <day>; limit config/budget.json nvidiaDailyRequestLimit` |
| `New sessions`                            | budget guard decision: `admitted (<reason>)` or `refused (<reason>)` | `budget guard decision over the ledger, prices and caps above (docs/budget-guard.md)`                  |

The caps need no ledger or prices; the other figures take the ledger or
pricing failure. With no entries in scope the price part is prefixed with
`no entries; `. Every money figure cites every price entry it used via
`config/providers/<id>.json input $<in> per 1M, output $<out> per 1M`,
joined with `"; "`, plus `; upper bound: cached-input pricing of <ids> not
applied` when a provider prices cached input (there is no cached count to
apply it to).

`Tokens by provider (finished tasks)`: columns
`provider, model, input tokens, output tokens, requests, sources`, from the
ledger query, `sources` joined by `", "`. Source: `ledger records tokens[]`.
Note: `<n> pending entries are not in this table; they count in spend above.`
`Session hours by host (finished tasks)`: columns `host, hours, sources`,
plus a `total` row with `Σ seconds / 3600` to 2 decimals. Source:
`ledger records sessionSeconds[]`.

### Savings (finished tasks only)

In order:

| Label                     | Value                                     | Source                                                                                                                                                                     |
| ------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Frontier-token baseline` | scaled token sums at the frontier prices  | `ledger records tokens (input <n>, output <n>); config/dashboard.json baselines.frontierTokens input $<in> per 1M, output $<out> per 1M (<label>; <source>; as of <asOf>)` |
| `Actual token cost`       | scaled token sums at provider prices      | `ledger records tokens × price; <prices>`                                                                                                                                  |
| `Token savings`           | baseline minus actual                     | `frontier-token baseline minus actual token cost above; <frontier>; <prices>`                                                                                              |
| `Cloud sandbox baseline`  | scaled session seconds at the cloud price | `ledger records sessionSeconds (<n> s); config/dashboard.json baselines.cloudSandboxHour $<p> per hour (<label>; <source>; as of <asOf>)`                                  |
| `Owned compute cost`      | scaled session seconds at the owned price | same, with `baselines.ownedHostHour`                                                                                                                                       |
| `Compute-hour savings`    | cloud baseline minus owned cost           | `cloud sandbox baseline minus owned compute cost above; <cloud>; <owned>`                                                                                                  |
| `Total savings`           | token plus compute-hour savings           | `token savings plus compute-hour savings above; <frontier>; <prices>; <cloud>; <owned>`                                                                                    |

A `null` baseline gives
`no data (no <key> baseline in config/dashboard.json)`. A null count on any
provider gives `no data (token counts not reported for <ids>)` on the
frontier baseline; on a priced provider, the same on actual cost. A derived
figure with a missing operand gives
`no data (needs every figure it is computed from)`. Then a `Scope` figure:
`<n> finished tasks`, sourced
`ledger records; <m> pending entries are not included`.

### Autonomy (finished tasks only)

In order: `Human interventions` (source
`ledger records humanInterventions (<n> records)`), `Retries` (source
`ledger records retries`), `Parked tasks`
(`no data (no work item source (#15, #17))` in this issue; source
`work items with status parked`), `Finished tasks`
(`<s> succeeded, <b> blocked`; source `ledger records result`).
Table `Success rate per model`: columns `model, attempts, successes, rate`
with `(s/a).toFixed(4)`. Source:
`ledger records attempts[] (attempt-level, docs/ledger.md)`.

## Money arithmetic

Every money value is a `bigint` in scaled units; token costs (per 1M) and
hour costs (per 3600 s) add without rounding. Display rounds once, half away
from zero, to 4 decimals (`$0.0000`). Price text is exact: whole dollars
plus the fraction padded to 9 digits with trailing zeros removed
(`100000000n` gives `0.1`, `0n` gives `0`, `3000000000n` gives `3`).
Unknown spend never shows a number: a null count on a priced provider gives
`no data (spend unknown for <ids>)` for `Spent today`/`Spent total`, a null
NVIDIA request count gives `no data (requests not reported for <ids>)` for
the request figure, and a null count on any provider gives
`no data (token counts not reported for <ids>)` on the frontier baseline.
Never a partial sum.

## Failure table

| Input or condition                                                                           | Behaviour                                        | Page                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `config/dashboard.json` missing, invalid, extra key, bad baseline, baseline without `source` | exit 2 naming the key                            | none                                                                     |
| `MOC_DASHBOARD_LISTEN` unset, not `host:port`, not loopback, wildcard, port out of range     | exit 2 naming the variable, never the value      | none                                                                     |
| bind fails (`EADDRINUSE`, …)                                                                 | exit 2 `dashboard listener <alias>: <code>`      | none                                                                     |
| `MOC_DASHBOARD_NOW` invalid                                                                  | exit 2                                           | none                                                                     |
| `logPath` parent missing or not writable                                                     | exit 2                                           | none                                                                     |
| `config/budget.json`, route, route or NVIDIA descriptors                                     | exit 2 (existing loader texts)                   | none                                                                     |
| `config/ledger.json`, `config/auditor.json` (no flag given)                                  | exit 2                                           | none                                                                     |
| ledger absent with parent present                                                            | empty contents                                   | counts 0, spend `$0.0000`                                                |
| ledger parent missing, unreadable, or not a file                                             | `error ledger-unreadable`, logged                | every ledger cell `error (ledger-unreadable)`                            |
| ledger line invalid, duplicate, unterminated                                                 | `error ledger-invalid`, logged                   | every ledger cell `error (ledger-invalid)`                               |
| a ledger provider has no descriptor                                                          | `error pricing-unavailable`, logged              | every money cell except caps and baselines `error (pricing-unavailable)` |
| null counts on a priced provider                                                             | unknown rule above                               | `no data (spend unknown for …)`; never a partial sum                     |
| null counts on any provider (baseline)                                                       | baseline rule above                              | `no data (token counts not reported for …)`                              |
| baseline `null`                                                                              | baseline rule above                              | `no data (no <key> baseline in config/dashboard.json)`                   |
| verdict dir absent                                                                           | no-data                                          | `no data (no verdict store)`                                             |
| verdict file unreadable or invalid                                                           | `error verdicts-unreadable` for that row, logged | that row only                                                            |
| verdict counts disagree with the findings                                                    | that verdict part                                | `<sha12>: invalid (counts disagree)`                                     |
| `hostState === null`                                                                         | no-data                                          | `no data (host state not wired)`                                         |
| `collect()` rejects with an `Error`                                                          | `error fleet-round-failed`, logged               | Fleet state, capacity and observed cells (`running` stays no-data)       |
| one host unavailable                                                                         | its observation                                  | `unavailable: <label>`                                                   |
| alias seen only in ledger                                                                    | no observation                                   | `no data (not in this collector round)`                                  |
| work items                                                                                   | `null`                                           | `no data (no work item source (#15, #17))`                               |
| Host header not allowed or missing                                                           | 421                                              | none                                                                     |
| method not `GET`                                                                             | 405                                              | none                                                                     |
| path not `/`                                                                                 | 404                                              | none                                                                     |
| body over `maxRequestBytes`                                                                  | Bun 413                                          | none                                                                     |
| a throw in build or render, a bad alias, a non-`Error` throw                                 | 500 `dashboard error`, `render-error` logged     | none                                                                     |
| log append fails                                                                             | stderr line, serving continues                   | unchanged                                                                |

## Privacy

Hosts appear by alias only, never by hostname or address. The page carries
no sentinel text, address fragment, or fixed `host-` prefix. The verdict
list shows counts per head SHA, never finding texts.

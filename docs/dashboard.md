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
MOC_DASHBOARD_LISTEN=127.0.0.1:8080 bun run factory:serve [--ledger <path>] [--verdicts <dir>] [--registry <path>] [--results <path>] [--work <path>]
MOC_DASHBOARD_NOW=2026-10-27T12:00:00.000Z bun run factory:serve  # tests only
```

- `--ledger` defaults to the `ledgerPath` of `config/ledger.json`.
- `--verdicts` defaults to the `verdictDir` of `config/auditor.json`.
- `--registry` defaults to the `registryPath` of `config/dispatcher.json`.
- `--results` defaults to the `resultsPath` of `config/loop.json`.
- `--work` defaults to the `storePath` of `config/work.json`.
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

The committed baselines are coordinator estimates (ruling 6478327690). Each
entry carries a `label`, a `source` the owner can re-check, and an `asOf`
date; the rendered citation repeats all three with the exact price. A `null`
baseline still gives `no data (no <key> baseline in
config/dashboard.json)` with the source `config/dashboard.json
baselines.<key>`.

## Layout

The header carries the product name, one line saying what the page is (an
autonomous software factory on company-owned machines, running on Meta
models) and the rendered time in a compact UTC form (`2026-11-01 13:03:54
UTC`) with the full ISO value in the `time` element's `datetime` and `title`.
Below it, a strip of key figure cards reuses figures the panels already
compute, in this order: `Total savings`, `Spent total`, `Spent today`,
`Finished tasks`, `Parked tasks`. Each card shows the figure's value, its
note when it has one, and its source line, small and muted; no card derives a
new number. The same figures still render in their panels below.

Sections render as cards with clear headings. Colours are CSS custom
properties, light by default and dark under `prefers-color-scheme: dark`, on
a system font stack with no web fonts. Tables use one light style (row lines
and zebra rows, no heavy grid), tabular numerals, and right-aligned numeric
columns. On a narrow screen a wide table scrolls inside its card, so the
page itself never scrolls sideways. There is still no script and no external
asset; the inline style stays covered by the CSP `CSS_HASH`.

## Panels

Fleet, Work, Usage, Savings, Autonomy, Models, in that order. Token counts and
integers group digits (`1,200,000`); timestamps render in the compact UTC
form above with the full ISO value in the cell's `title`. A ledger failure
makes every ledger-derived cell `error(<ledger code>)`; the page shows the
code only, never the message. Figures listed "in order" render in that
order. The Work table shows `showing ${shown} of ${total} items`.

A figure's qualifier (an upper bound, the records a value covers) is its note:
a separate line under the value, smaller than the value and larger than the
source line, never part of the value. A figure without a qualifier has no
note.

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
`running`: the `registry-invalid` or `registry-unreadable` failure when the
registry input fails; otherwise `n`, the number of registry entries with
`terminal === null` for that alias. With a `reported` capacity the cell is
`` `<n> of <capacity.policy.maxConcurrentAgents>` `` with grouped digits,
otherwise `` `<n>` ``.
`observed`: the observation time, or the same failure/no-data as `state`.

The snapshot has no collector round; its Fleet reads the host-state events in
`loop-ports.jsonl` (see Static snapshot). Then the source is
`host-state events (ts, kind, cause) in loop-ports.jsonl next to logPath of config/loop.json; running sessions from the dispatcher registry`
and the note is
`a snapshot has no live host state: state and observed are the newest probe recorded at or before <as-of>`.
Rows also take the aliases of the recorded probes. `state`:
`last probe: reported` or `last probe: unavailable: <label>` (labels above),
or `no data (no probe recorded)`. `free capacity`:
`no data (capacity values are not recorded)`. `running`: `n` (no capacity
to compare with). `observed`: the probe's `ts`. Event `detail`, package and
stdout fields never reach the page.

### Work

One table, caption `Work`, columns
`item, status, host, placement, branch, model, verdicts, last activity`.
Source: `work store (storePath of config/work.json), dispatcher registry, ledger and verdict store; status rule in docs/dashboard.md; placement: decision recorded on the item's newest registry entry; last activity: newest ledger finishedAt or registry time of the item`.

Rows are the union of ledger record and pending `workItemId`s, registry
`workItemId`s when the registry is ok and work store item ids when the store
is ok, sorted by latest activity descending,
then id ascending, truncated to `workRowLimit`. Activity is the maximum
`Date.parse` over the item's record `finishedAt`, pending `finishedAt`
and, when the registry is ok, registry `startedAt`, `lastSeenAt` and
`terminal.observedAt`; it is `null` when none exists.

### Status rule (Work)

1. A work store item with the id, when the store is ok, shows its status, as
   `<status> (<statusReason>)` when the reason is set: a parked item shows
   `parked (<reason>)`, the same items `Parked tasks` counts. The Work table shows at most `workRowLimit` rows (its note says `showing <n> of <m> items`), so a counted item with older activity can be off the table.
2. A registry entry for the id has `terminal === null`: the value is that
   entry's `lastSeenState` (`starting` or `running`), taken from the open
   entry with the highest `n`.
3. A ledger record exists: `done` when `result === "success"`, `blocked`
   when `result === "blocked"`.
4. Registry entries exist and all are terminal: `` `session
<terminal.state>` `` of the entry with the highest `n`.
5. Pending entries exist: `session ended, not finalized`.

When none matches, the row came only from a failed source and the cell is
that failure. Rules 2 and 4 apply only when the registry is ok; registry
aliases and work item ids are skipped when the registry fails.

The status cell renders as a coloured pill whose text is the status above,
so the colour is never the only signal: green for `done` and a finished
session, blue for `running`, `starting`, `review` and a session that ended
unfinalized, amber for `parked (<reason>)` with the reason inside the pill,
red for `blocked` and failed, lost or cancelled sessions, and a neutral pill
for any other status. Branch and model ids render in monospace, shortened
in the middle when long, with the full value in a `title` attribute; verdict
head SHAs are already the 12-character form the model records.

The placement cell shows a summary, the chosen host and its score, and the
full recorded text (the chosen host's reason and every other candidate,
excluded ones included) inside a native `<details>` element under that
summary; `no data (...)` stays visible and muted outside any `<details>`.
`host` is the `aliases` cell of the highest-`n` registry entry's
`hostAlias`, else the sorted unique aliases of the item's record
`sessionSeconds` and pending sessions, or `no data (no session)`. `branch`
is the highest-`n` entry's `branch`, else the non-null `WorkItem.branch`,
else `no data (no session)` when the registry is ok, else the registry
failure. `placement` is the `placement` the dispatcher recorded on the
highest-`n` entry (docs/dispatcher.md): the decision `reason` with
`, score <s>` of the chosen candidate, then every other candidate in recorded
order as `<alias>: <reason>` when excluded or `<alias>: eligible, score <s>`,
joined by `; `. Hosts that rejected a start of the item and hosts in a start-rejection cooldown (`hostCooldown`) are left out of placement before the decision, so they are not candidates. Rejected hosts come back only when every other host is excluded and placement retries them (`exclusions-retried`); cooled hosts never do (docs/loop.md).
In an `excluded: not idle (<idleReason>)` reason the page keeps `<idleReason>`
only up to its first `:`: the host probe puts an error message after it
(`user activity unknown: <message>`, `power unknown: <message>`), and a
message can name a path; the snapshot page check stays the backstop. An entry
without `placement` (an optional registry field) shows
`no data (not recorded)`; no entry shows `no data (no session)`, and a failed
registry shows its failure. A recorded placement whose aliases fail the alias pattern, or whose reason does not start with the chosen alias, shows `no data (placement failed alias check)`. `model` is `` `<providerId>/<model>` `` of the highest-`n` entry,
else `no data (no session)` when the registry is ok, else the registry
failure. `verdicts` lists
every verdict in store order as
`<sha12> by <auditor>: high <h>, medium <m>, low <l>`, or
`<sha12>: invalid (counts disagree)` when the counts disagree;
`none` when empty; `no data (no verdict store)` when absent; one row's
`verdicts-unreadable` failure stays on that row. `last activity` is the
item's activity above as an ISO timestamp, or `no data (no timestamp)` when
it is `null`. It is always a recorded time, never the page clock `now`.

### Usage

`day = utcCalendarDay(now)`. In order:

| Label                                     | Value                                            | Source                                                                                                 |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `Spent today (UTC <day>)`                 | exact scaled sum, or no-data by the unknown rule | `ledger records and pending entries finished on <day>, tokens × price; <prices>`                       |
| `Spent total`                             | exact scaled sum, or no-data by the unknown rule | `ledger records and pending entries, tokens × price; <prices>`                                         |
| `NVIDIA Build requests today (UTC <day>)` | `<n> of <limit>`, or no-data by the unknown rule | `ledger requests of provider <id> finished on <day>; limit config/budget.json nvidiaDailyRequestLimit` |

The spent figures sum every pool. The figures take the ledger or pricing
failure. With no entries in scope the price part is prefixed with
`no entries; `. Every money figure cites every price entry it used via
`config/providers/<id>.json input $<in> per 1M, output $<out> per 1M`,
joined with `"; "`, plus `; upper bound: cached-input pricing of <ids> not
applied` when a provider prices cached input (there is no cached count to
apply it to). When the scope holds bounded unmeasured entries, the spent-today and spent-total values carry the note `includes the upper bound for unmeasured calls of <sorted ids>`. The spent-today ids are bounded entries finished that day; the spent-total ids are every bounded entry.

`Budget pools`, the first table: one row per budget pool
(docs/budget-guard.md), main pool first, columns
`pool, providers, spent today, day cap, spent total, total cap, new sessions`.
`providers` is the pool's list, or `every provider outside the other pools`
for the main pool. Spend is the pool's own token rows, priced and marked
unknown as above; `new sessions` is the guard decision for the pool,
`admitted (<reason>)` or `refused (<reason>)`. The caps need no ledger or
prices; the spend and decision cells take the ledger or pricing failure.
Source:
`caps: config/budget.json poolId, dayCapUsd, totalCapUsd and pools[]; spend: ledger records and pending entries of the pool's providers, tokens × price as above; new sessions: budget guard decision per pool (docs/budget-guard.md)`.
Note: `pool <id> includes the upper bound for unmeasured calls of <sorted ids>`
per pool with bounded entries, joined with `"; "`, or none.

`Tokens by provider (finished tasks)`: columns
`provider, model, input tokens, output tokens, requests, sources`, from the
ledger query over records with full token counts (every `tokens[]` row reports both counts and has no `unmeasuredRequests`), the same coverage rule as Savings, `sources` joined by `", "`. Source: `ledger records tokens[] with full token counts`.
Note: `over <n> of <m> records; <ids> have no token counts; <ids> have calls without usage` when some records are excluded (each clause only when it has ids, `has` for one id), or `token counts not reported for <ids>; calls without usage for <ids>` when no record is covered (each clause only when it has ids), plus `; <n> pending entries are not in this table; they count in spend above.`
`Session hours by host (finished tasks)`: columns `host, hours, sources`,
plus a `total` row with `Σ seconds / 3600` to 2 decimals. Source:
`ledger records sessionSeconds[]`.
The table note says that each value is rounded to two decimals and the total is rounded from the unrounded seconds.

### Savings (finished tasks only)

In order:

| Label                     | Value                                     | Source                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Frontier-token baseline` | scaled token sums at the frontier prices  | `ledger records with full token counts (input <n>, output <n>); config/dashboard.json baselines.frontierTokens input $<in> per 1M, output $<out> per 1M (<label>; <source>; as of <asOf>)` |
| `Actual token cost`       | scaled token sums at provider prices      | `ledger records with full token counts, tokens × price; <prices>`                                                                                                                          |
| `Token savings`           | baseline minus actual                     | `frontier-token baseline minus actual token cost above, over the same records; <frontier>; <prices>`                                                                                       |
| `Cloud sandbox baseline`  | scaled session seconds at the cloud price | `ledger records sessionSeconds (<n> s); config/dashboard.json baselines.cloudSandboxHour $<p> per hour (<label>; <source>; as of <asOf>)`                                                  |
| `Owned compute cost`      | scaled session seconds at the owned price | same, with `baselines.ownedHostHour`                                                                                                                                                       |
| `Compute-hour savings`    | cloud baseline minus owned cost           | `cloud sandbox baseline minus owned compute cost above; <cloud>; <owned>`                                                                                                                  |
| `Total savings`           | token plus compute-hour savings           | `token savings plus compute-hour savings above; <frontier>; <prices>; <cloud>; <owned>`                                                                                                    |

A `null` baseline gives
`no data (no <key> baseline in config/dashboard.json)`. The three token
figures cover the same records: those with full token counts, where every
`tokens[]` row reports both counts and has no `unmeasuredRequests`, on any
provider, priced or not. The other records add nothing to them; no count and
no upper bound is used for them. When some records are excluded, the three
values carry the note
`over <n> of <m> records; <ids> have no token counts; <ids> have calls without usage`
(each clause only when it has ids, `has` for one id). When records exist and
none has full token counts, the three show
`no data (token counts not reported for <ids>; calls without usage for <ids>)`
(each clause only when it has ids). `Total savings` adds the token savings
and the compute-hour savings, which covers every record (session seconds
are never null); with excluded records its note is
`token savings over <n> of <m> records; <ids> have no token counts; compute-hour savings over all <m> records`.
A derived figure with a missing operand gives
`no data (needs every figure it is computed from)`. Then a `Scope` figure:
`<n> finished tasks`, sourced
`ledger records; <m> pending entries are not included`.

### Autonomy (finished tasks only)

In order: `Human interventions` (source
`ledger records humanInterventions (<n> records)`), `Retries` (source
`ledger records retries`), `Parked tasks`
(the number of work store items with status `parked`; source
`work items with status parked (work store, storePath of config/work.json)`),
`Finished tasks` (`<s> succeeded, <b> blocked`; source `ledger records result`).
Park state lives only in the work store (projected from the loop state by
`src/loop/project.ts`). `gatherInputs` reads it once per request with
`readWorkStore`, so `Parked tasks` and the Work statuses of status rule 1
come from the same read. The store's `statusReason` is fixed text and numbers
(`operator: <code>`, `session lost`, `stalled: <n> rounds ...`,
`blocked: <n> retries used`).
Table `Sessions per model (finished tasks)`: columns `model, sessions, ended ok`,
from the ledger query `byModel`: `sessions` counts record attempts with the
model (one per dispatcher session entry, so a ledgered start rejection counts
as a `failure` session), `ended ok` those with result `success` (the session
ended in state `finished`). It shows no rate: a session that ended ok is not a
merged round, and Models excludes start rejections. Source:
`ledger records attempts[], one per dispatcher session entry, ledgered start rejections included; ended ok: attempt result success (docs/ledger.md)`.

### Models (closed loop rounds only)

One table, caption `Models`, columns
`model, rounds, successes, failures, excluded, success rate`.
Source: `loop results (resultsPath of config/loop.json, read through readResults)`.

Per model, over the lines `readResults` returns (a repeated `key` keeps
only its first line, `src/loop/results.ts` `readResults`, see
[loop.md](loop.md)): `rounds` counts the lines for the model, `successes`
counts lines with `routingResult === "success"`, `failures` counts lines
with `routingResult === "failure"`, and `excluded` counts lines with
`routingResult === "excluded"`. The success rate covers non-excluded
rounds only (`successes / (successes + failures)`, `(s/(s+f)).toFixed(4)`)
and is `n/a` when there are none. Rows sort by `rounds` descending, then
model id ascending. This is the only success rate on the page: a success is
a merged round, and excluded rounds (`start-rejected`, `lost`, `ci-timeout`,
`trial-failed`) say nothing about the model.

A middle line that `readResults` rejects is a data error shown as one row
of `error (results-invalid)` cells; a torn last line is ignored as
`readResults` ignores it. An unreadable results path (missing parent,
not a file, cannot read) shows one row of `error (results-unreadable)`
cells. An absent results file renders an explicit empty state
(`no closed rounds yet`), never invented numbers.

## Money arithmetic

Every money value is a `bigint` in scaled units; token costs (per 1M) and
hour costs (per 3600 s) add without rounding. Display rounds once, half away
from zero, to 4 decimals (`$0.0000`). Price text is exact: whole dollars
plus the fraction padded to 9 digits with trailing zeros removed
(`100000000n` gives `0.1`, `0n` gives `0`, `3000000000n` gives `3`).
Unknown spend never shows a number: a null count on a priced provider gives
`no data (spend unknown for <ids>)` for `Spent today`/`Spent total`, a null
NVIDIA request count gives `no data (requests not reported for <ids>)` for
the request figure. Spend is never a partial sum. The savings token figures
and the usage token table sum the records with full token counts and state that coverage in their
note (Savings above and Usage above).

## Failure table

| Input or condition                                                                           | Behaviour                                        | Page                                                                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `config/dashboard.json` missing, invalid, extra key, bad baseline, baseline without `source` | exit 2 naming the key                            | none                                                                                                  |
| `MOC_DASHBOARD_LISTEN` unset, not `host:port`, not loopback, wildcard, port out of range     | exit 2 naming the variable, never the value      | none                                                                                                  |
| bind fails (`EADDRINUSE`, …)                                                                 | exit 2 `dashboard listener <alias>: <code>`      | none                                                                                                  |
| `MOC_DASHBOARD_NOW` invalid                                                                  | exit 2                                           | none                                                                                                  |
| `logPath` parent missing or not writable                                                     | exit 2                                           | none                                                                                                  |
| `config/budget.json`, route, route or NVIDIA descriptors                                     | exit 2 (existing loader texts)                   | none                                                                                                  |
| `config/ledger.json`, `config/auditor.json` (no flag given)                                  | exit 2                                           | none                                                                                                  |
| `config/dispatcher.json` (no `--registry` given)                                             | exit 2                                           | none                                                                                                  |
| ledger absent with parent present                                                            | empty contents                                   | counts 0, spend `$0.0000`                                                                             |
| ledger parent missing, unreadable, or not a file                                             | `error ledger-unreadable`, logged                | every ledger cell `error (ledger-unreadable)`                                                         |
| ledger line invalid, duplicate, unterminated                                                 | `error ledger-invalid`, logged                   | every ledger cell `error (ledger-invalid)`                                                            |
| a ledger provider has no descriptor                                                          | `error pricing-unavailable`, logged              | every money cell except caps and baselines `error (pricing-unavailable)`                              |
| null counts on a priced provider                                                             | unknown rule above                               | `no data (spend unknown for …)`; never a partial sum                                                  |
| null counts or calls without usage in some records (savings and usage)                       | coverage rule above                              | savings token values and usage token table over the records with full counts, coverage note           |
| no record with full token counts (savings and usage)                                         | coverage rule above                              | savings `no data (token counts not reported for …)` and usage table with exclusion reason in its note |
| baseline `null`                                                                              | baseline rule above                              | `no data (no <key> baseline in config/dashboard.json)`                                                |
| verdict dir absent                                                                           | no-data                                          | `no data (no verdict store)`                                                                          |
| verdict file unreadable or invalid                                                           | `error verdicts-unreadable` for that row, logged | that row only                                                                                         |
| verdict counts disagree with the findings                                                    | that verdict part                                | `<sha12>: invalid (counts disagree)`                                                                  |
| `hostState === null`                                                                         | no-data                                          | `no data (host state not wired)`                                                                      |
| `collect()` rejects with an `Error`                                                          | `error fleet-round-failed`, logged               | Fleet state, capacity and observed cells (`running` from the registry)                                |
| one host unavailable                                                                         | its observation                                  | `unavailable: <label>`                                                                                |
| alias seen only in ledger or registry                                                        | no observation                                   | `no data (not in this collector round)`                                                               |
| snapshot: ports log absent with parent present                                               | no-data                                          | Fleet `no data (no probe recorded; a snapshot has no live host state)`                                |
| snapshot: ports log line not JSON, or a bad host-state ts, alias, kind or cause              | `host-state-log-invalid` on stderr, exit 2       | none                                                                                                  |
| snapshot: ports log parent missing, not a file, or unreadable                                | `host-state-log-unreadable` on stderr, exit 2    | none                                                                                                  |
| registry absent with parent present                                                          | empty contents                                   | `running` `0`                                                                                         |
| registry invalid or a bad `requestId`                                                        | `error registry-invalid`, logged                 | `error (registry-invalid)`, logged, registry cells                                                    |
| registry unreadable                                                                          | `error registry-unreadable`, logged              | `error (registry-unreadable)`                                                                         |
| loop results absent with parent present                                                      | empty contents                                   | panel `Models` shows `no closed rounds yet`                                                           |
| loop results middle line invalid                                                             | `error results-invalid`, logged                  | panel `Models` shows one row of `error (results-invalid)` cells                                       |
| loop results path missing parent, not a file, or unreadable                                  | `error results-unreadable`, logged               | panel `Models` shows one row of `error (results-unreadable)` cells                                    |
| work store absent with parent present                                                        | no-data                                          | `Parked tasks` `no data (work store not wired)`; status rule 1 skipped                                |
| work store not JSON, or fails the store shape or rules                                       | `error work-store-invalid`, logged               | `Parked tasks` `error (work-store-invalid)`; status rule 1 skipped                                    |
| work store parent missing, not a file, or unreadable                                         | `error work-store-unreadable`, logged            | `Parked tasks` `error (work-store-unreadable)`; status rule 1 skipped                                 |
| Host header not allowed or missing                                                           | 421                                              | none                                                                                                  |
| method not `GET`                                                                             | 405                                              | none                                                                                                  |
| path not `/`                                                                                 | 404                                              | none                                                                                                  |
| body over `maxRequestBytes`                                                                  | Bun 413                                          | none                                                                                                  |
| a throw in build or render, a bad alias, a non-`Error` throw                                 | 500 `dashboard error`, `render-error` logged     | none                                                                                                  |
| log append fails                                                                             | stderr line, serving continues                   | unchanged                                                                                             |

## Privacy

Hosts appear by alias only, never by hostname or address. The page carries
no sentinel text, address fragment, or fixed `host-` prefix. Registry
paths, session ids, cursors, details and repo are never shown. The verdict
list shows counts per head SHA, never finding texts.

## Benchmark numbers (demo:numbers)

Run `bun run demo:numbers --ledger <run-ledger>` to print a markdown table of benchmark figures from ledger records plus config prices.

The command reuses dashboard figures via `buildDashboard` (`src/dashboard/model.ts`). It builds `DashboardInputs` with ledger and pricing `ok: true`, hosts and results `ok: false`, registry empty, verdicts empty and workItems `ok: false`, then reads figures by panel id and label (`figureOf`). A figure with a note prints as `<value> (<note>)`. The
`Sessions per model (finished tasks)` section copies the Autonomy table of
that caption: `model, sessions, ended ok`, with no rate.

`Local token share` is a new figure computed over record `tokens[]` (input plus output, auditor-usage included). Locality is from `config/demo-numbers.json` with `localProviderIds` and `cloudProviderIds`. Checks in order: null token counts → `no data (token counts not reported for <ids>)`; unmeasured requests → `no data (requests without usage for <ids>)`; zero total → `no data (no tokens in ledger records)`; else `<ratio> local (<local> of <total> tokens)` with ratio to 4 decimals and counts via `groupDigits`.

Classification config `config/demo-numbers.json` must contain exactly `localProviderIds` and `cloudProviderIds`, each an array of unique provider ids with descriptors, disjoint. Current content: local `["local"]`; cloud `["meta-api", "meta-wonder", "nvidia-build"]`. `buildNumbers` fails fast if a provider in records or pending entries is not classified.

`--sources` adds a `sources` column. The flag takes no value and may appear once; repeating it exits 2. With `--sources`, each row cites the ledger rows by `workItemId` or `entryId` and the config entry it was computed from. A row citation is an id, not a line number: records are cited by `workItemId` and pending entries by `entryId`. The source format is `<base>; rows: <citation>`, with count rows appending `; config: none (count, no price)`. For money rows the base names the `config/providers/<id>.json` price or the `config/dashboard.json` baseline; for the share row the base names `config/demo-numbers.json`. Ids are sorted ascending and joined with `, `; an empty list is `none`.

## Static snapshot (dashboard:snapshot)

```sh
bun run dashboard:snapshot -- --as-of <iso> --out <file> [--ledger <path>] [--verdicts <dir>] [--registry <path>] [--results <path>] [--work <path>] [--ports <path>] [--hosts <path>]
```

The command renders the page once, without a listener, through the server's
path (`gatherInputs`, `buildDashboard`, `renderDashboard`; `src/factory/snapshot.ts`)
and writes it atomically to `--out`. `--ledger`, `--verdicts`, `--registry`,
`--results` and `--work` default as for `factory:serve`, and the flag rules are the
same. `--as-of` is required, in the `MOC_DASHBOARD_NOW` form, and is the page
clock: the header's "Rendered" time, the UTC day of the Usage figures and the
budget guard decision. The same files and `--as-of` give a byte-identical page.
The coordinator passes the latest ledger `finishedAt` as `--as-of`. When no
registry time is newer, the newest Work row's `last activity` equals the
header time: both are that recorded time.

Host state is not collected: a collector round is live fleet I/O, not recorded
data. The Fleet shows what the loop recorded instead: the newest host-state
event per alias with `ts` at or before `--as-of` in the loop ports log
(`--ports`, default `loop-ports.jsonl` next to `logPath` of `config/loop.json`,
the file the loop writes). Only `ts`, `hostAlias`, `kind` and `cause` are read;
a host-state line needs a `toISOString` `ts`, an alias matching
`^[a-z][a-z0-9-]{0,31}$`, and `kind` `reported` with a null `cause` or
`unavailable` with a known cause. Lines of other sources are skipped and an
unterminated last line is ignored, so a log the loop is appending to reads
the same at the same `--as-of`. Capacity values are not recorded, so free
capacity shows `no data (capacity values are not recorded)` (Fleet above).

Before writing, the page is checked. No `evidenceDenyPatterns` entry of
`config/coordinator.json` may match it, and no host name from the host map
(`--hosts`, default `config/hosts.json`) whose alias differs from it may appear.
A host-map name matches case-insensitively anywhere in the page, also inside a
longer token; any hit exits 3 and writes no file. The host map is gitignored; when it
is absent the command says so on stderr and checks the deny patterns only. A
hit prints `dashboard:snapshot: page matches deny pattern <index> of config/coordinator.json`
or `dashboard:snapshot: page contains the host name mapped to alias <alias>`,
never the matched text, and exits 3. A usage or config error, or any input
error that the server would show as `error (<code>)`, exits 2. Neither writes
the file. Success prints `dashboard:snapshot: wrote <file> as of <iso>`.

The committed snapshot is `docs/demo/dashboard.html`. It is generated, so it is
listed in `.prettierignore` and never edited by hand; the coordinator
regenerates and commits it.

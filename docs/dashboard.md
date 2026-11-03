# Dashboard

Four tabs served by the factory process: Live, Work, Models and Cost. They
read the ledger file, verdict store, prices, host state and, for Live, the
meter usage log and a simulated trace, and render server-side; there is no
client JavaScript and no external resource. While the replay runs, a tab
advances through a meta refresh (see Live view); the static snapshot is one
stacked page. Every figure names its source; for money, the config price entry.
No estimated numbers: a missing input shows "no data", and an unreadable
one shows an error code with details in `logs/dashboard.jsonl`.

The factory process runs two listeners: the meter's (overlay address,
reachable by fleet hosts) and the dashboard's, on a loopback address. They
are never one listener: the dashboard has no authentication, so it must not
sit on the fleet-reachable meter listener. `factory:serve` starts only the
dashboard in this issue.

## Run

```sh
MOC_DASHBOARD_LISTEN=127.0.0.1:8080 bun run factory:serve [--ledger <path>] [--verdicts <dir>] [--registry <path>] [--results <path>] [--work <path>] [--sim-trace <path>] [--meter-usage <path>] [--ports <path>] [--loop-log <path>]
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
the path `/` (404 for any other path). Query grammar on `/` is `view,t,pause,host,task,call,audit` where `view` is one of `live,work,models,cost` (unknown →404), `t` a non-negative integer past duration →404, `pause` only `1`, and selection keys match `^[a-z][a-z0-9-]{0,31}$` for host alias, `^[a-z0-9][a-z0-9-]{0,62}$` for task, `call` as `[^|]+\|[^|]+`, `audit` as `[^@]+@[^@]+` with precedence `host>task>call>audit`; well-formed unknown selection →404. The old view names redirect (301) to the tab that holds their content, keeping `t` and `pause` and dropping any selection: `fleet` and `overview` → `live`, `autonomy` → `work`, `usage` → `models`, `savings` → `cost`; without live sources a redirect to `live` goes to `work`. Without `view`, `/` is `live` when live sources are wired (a `--sim-trace` is given) and `work` otherwise; without live sources there is no Live tab (`view=live` →404) and no page carries simulated text. Work, Models and Cost accept a known host selection and ignore it; any other selection on them →404. Every tab carries the same header and tab bar (active marked). Only Live carries the simulated clock, the synthetic-fleet tagline and the replay controls (pause/resume, restart t=0, step ±5, jumps 0/60/120/180/240 filtered by duration); paused has no refresh meta and a paused badge, otherwise meta refresh to `t+5` preserving `view=live` and the open panel. Work, Models and Cost show the real clock and the real tagline, have no replay controls and no refresh. Tab links keep `t,pause` and drop the selection. `GET /live` 301 → `/?t=<t>` (no t → `/`).

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
| `placementMaxAgeSec`                   | integer in `1..86400`; seconds a placement entry decides a real tile; currently `600`                                                  |
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

One visual system serves every page: one stylesheet (`DASHBOARD_CSS` in
`src/dashboard/render.ts`, covered by the CSP `CSS_HASH`), one header, one
tab bar, one card, one boxed section with a heading, one table style, one
pill and chip style, one type scale and one colour token set, light by
default and dark under `prefers-color-scheme: dark`, on a system font stack
with no web fonts. Base text is 16 px; everything a viewer reads is at least
15 px, and only source cites, the long `sources` cells and the tile legend
are smaller. There is no `style` attribute, no script and no external asset.

The header carries the product name, the real clock in a compact UTC form
(`2026-11-01 13:03:54 UTC`, the full ISO value in the `time` element's
`datetime` and `title`), on Live the simulated clock and a paused badge,
and one honesty tagline: the synthetic-fleet line on Live, the real line
on Work, Models and Cost. The tab bar lists Live (only with live
sources), Work, Models and Cost, with the replay controls on the right
on Live. Model names read in one form on the framed tabs and Live: the model
without its namespace, then the provider in parentheses where the cell
names it (`muse-spark-open-1026 (baseten)`), never cut in the middle; the
cell's `title` keeps the recorded value.
Under it each tab carries its one-line subtitle:

| Tab    | Subtitle                                                                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live   | one fleet grid, the four real machines as the first group and the simulated company evening after them, replayed through the real placement engine; on the right, the live work of the real machines, model activity and events. |
| Work   | every task the factory has taken: its status, its machine, its model and its audit verdict. All real.                                                                                                                            |
| Models | every real model call the factory made: which model, which provider, how many tokens, what it cost.                                                                                                                              |
| Cost   | what the factory spent, against its budget caps.                                                                                                                                                                                 |

Each tab fills exactly one 1920x1080 frame and shows only its own figures,
all computed by `buildDashboard` and its panels; the renderer derives no
number:

- **Work**: the Autonomy figures (`Finished tasks`, `Parked tasks`, `Human
interventions`, `Retries`) as cards, then the Work table, newest first,
  with its first 15 rows and `showing N of M items` over every work item.
- **Models**: the Usage figures as cards, then the Models table, the
  Autonomy `Sessions per model (finished tasks)` table and, with live
  sources, the newest real meter calls (as on Live, linked to the call
  panel), beside the Usage `Tokens by provider` and `Session hours by host`
  tables. A table shows at most 6 rows and says `showing N of M rows` when
  it leaves rows out.
- **Cost**: first `Budget caps`, the Usage budget pools table with a bar of
  each pool's spent total against its total cap (read from the row's own
  cells, with the same share as text: `0% of cap` for no spend, `<1% of cap`
  under 1%, the rounded whole percent such as `37% of cap` up to the cap
  (`100%` only once spent reaches it), `over cap (143%)` past it; a row
  without both dollar values reads `no data` there); then the spend the
  Savings panel computes, `Actual token cost` and `Owned compute cost`, as
  cards; then every Savings figure, labels as the panel has them, with its
  note and full source in one `Frontier list price comparison` table, and
  directly under it one assumptions line: the NVIDIA Build free tier is
  priced at $0, neither side applies a cache discount, the frontier side is
  assumed to use the same tokens, and only the factory ledger is counted.
  No figure is a hero card or styled as a gain.

On a framed tab a card's note is cut to two lines and its source to one,
each with the full text in the card's `title`; the stacked snapshot shows
them in full. The stacked page (the snapshot) carries the same header with
the rendered time and UTC day, a line on what "no data" and "error" mean, a
strip of key figure cards (`Spent total`, `Spent today`, `Finished tasks`,
`Parked tasks`, reused from the panels), then every panel in order; the
Savings panel is headed `Frontier list price comparison` and carries the same
assumptions line as Cost under its figures. Stacked section anchors are the
model panel ids, so `#savings` holds the frontier comparison. On a narrow screen a wide table scrolls inside its box and the
frame grows with its content.

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

## Live view (`/live`)

The Live tab (`/?view=live`; `GET /live` redirects to it) is the script-free
page for watching the factory at scale: Real work now cards for the real
machines, the Just finished strip, a simulated fleet replayed from a
simulator trace, the real meter activity feed and an event ticker. It is
built by `buildLive` (`src/dashboard/live.ts`) and rendered by `renderLive`
(`src/dashboard/live-render.ts`) in the shared frame; the dashboard panels
are not involved, and simulated data never enters their inputs, the ledger,
Work, Models, Cost or `demo:numbers`.

Run it through `factory:serve` with four extra flags, each at most once:

```sh
MOC_DASHBOARD_LISTEN=127.0.0.1:8080 bun run factory:serve --sim-trace logs/sim/evening-100.jsonl --loop-log logs/loop.jsonl
```

- `--sim-trace <path>` has no default. Without it the simulated groups show
  `no data (no simulated input)`; the real sections still serve.
- `--meter-usage <path>` defaults to `usageLogPath` of `config/meter.json`.
  The usage log is replayed read-only on every request; nothing writes to it.
- `--ports <path>` defaults to `loop-ports.jsonl` next to `logPath` of
  `config/loop.json`. The real tiles are the newest recorded probe per alias
  at or before the page clock, as in the static snapshot's Fleet.
- `--loop-log <path>` defaults to `logPath` of `config/loop.json`. It is read
  read-only on every request; only `placement` events are used (shape in
  `docs/loop.md`), newest per real host alias at or before the page clock, and
  an unterminated last line is ignored. Each request reads the whole loop log, which is about
  1 MB on 2026-11-03 and grows with the loop's events. A missing log reads `no data (no loop
log)`; an unreadable one `error (loop-log-unreadable)`; a line that is not a
  JSON object or a `placement` event with a bad `ts`, `workItemId`,
  `chosenHostAlias` or candidate `error (loop-log-invalid)`. The real tiles
  then fall back to the probe mapping below.

The cursor is the query: `/live?t=<minute>` shows the simulated fleet at
that minute of the trace. A `t` that is not a non-negative integer, or one
past the end of the trace, is 404. The parsed trace is cached in the server
process keyed by its path, size and modification time, so a refresh never
reparses an unchanged file. Each frame
advances 5 sim-minutes and carries a meta refresh of
`ceil(5 * 60 / speed)` seconds (clamped to 2..30; 5 seconds at the trace
speed 60); the `+5` control is the plain next-frame link, so the page
works even where a refresh does not fire. The final frame carries no
refresh. There is no script and no external
resource: every page carries the one stylesheet under the CSP `CSS_HASH`. A
meta refresh is a navigation, not a resource load, so `default-src 'none'`
does not block it.

Live fits one 1920x1080 frame, with or without a panel open: one fleet grid
beside the right rail. The rail holds Real work now, Just finished (real),
Model activity (the newest 3 rows) and Events, or the open panel, which
scrolls inside the rail when it is longer than the frame.

The fleet heading reads `Fleet · <n> real + <n> simulated`, then the
simulated counters from the trace at the cursor minute, labelled:
`<eligible> of <hosts> eligible · <n> work running · <n> placements
(simulated)`. The real machines are the first group, `real (<n>)`, in the
same group heading as the simulated groups, with a solid `REAL` chip where
those have the dashed `SIMULATED` chip, and the same per-state counts. The
simulated tiles are grouped by site and kind, in group order, each heading
with its name and host count, the `SIMULATED` chip and the per-state counts
(`19 running · 11 eligible`). Every machine is one tile of one component: the
full alias at 15 px and the load, the state as the tile's left border colour
with the legend under the grid, and a link to its host panel; the open tile
carries the shared `selected` outline. A simulated tile's load is
`running/maxAgents`. A real tile's load is the open session count its card
holds (`1` while a session is open, `0` otherwise, `–` when the registry,
results log or work store cannot be read); the live model carries no agent
limit for real hosts. States: `eligible` (can take work now), `running`,
`blocked` (idle but excluded; the placement reason is in the tile title),
`busy` (user present), `offline` (left the site network), and `unavailable`.
The amber edge marks simulated tiles only.

A real tile's state is read only from its card's fields. An open session is
`running`; a registry, results or work store failure keeps `unavailable`;
next, the newest entry for the host from either a loop `placement` or a loop
`host-assessment` event (docs/loop.md) decides while it is younger than
`placementMaxAgeSec`, so a real tile shows the host's state with an empty
queue too. It is matched on the stable prefix of the engine's reason; for
`excluded: not idle (<inner>)` on the probe's inner idle reason
(`derive_idle` in `crates/moc-host-state/src/idle_rule.rs`):

| Newest placement or assessment entry for the host               | State         |
| --------------------------------------------------------------- | ------------- |
| not excluded (chosen, eligible, or eligible not chosen)         | `eligible`    |
| `excluded: not idle (not on AC power)`                          | `blocked`     |
| `excluded: not idle (battery at ...)`                           | `blocked`     |
| `excluded: not idle (outside the policy window)`                | `blocked`     |
| `excluded: not idle (user activity unknown: ...)`               | `unavailable` |
| `excluded: not idle (power unknown: ...)`                       | `unavailable` |
| `excluded: not idle (...)`, any other inner reason (user input) | `busy`        |
| `excluded: not on AC power`                                     | `blocked`     |
| `excluded: battery at ...`                                      | `blocked`     |
| `excluded: host state unavailable ...`                          | `unavailable` |
| any other excluded reason                                       | `blocked`     |

With no fresh entry, the probe mapping applies:

| Card                                                                      | State         |
| ------------------------------------------------------------------------- | ------------- |
| open session (stage `implement`)                                          | `running`     |
| idle, probe reported, `no work queued` or `<n> queued, not placed`        | `eligible`    |
| idle, probe `plugin-busy` (`person at the desk`)                          | `busy`        |
| idle, probe `host-unreachable`, `request-timeout` or `stale`              | `offline`     |
| idle, no recorded probe                                                   | `offline`     |
| idle, any other probe cause, or a registry, results or work store failure | `unavailable` |

`unavailable` covers both a host-side probe cause (the host answered but its
probe failed, e.g. `daemon-rejected`) and a dashboard source failure (the
registry, results log or work store could not be read); the card's state line
in the host panel names which one: `Idle: <cause> (...)` for the host,
`state: error (<code>)` or `state: no data (<reason>)` for the source. The
probes alone have no cause the simulated tiles call `blocked`; a placement
entry gives one. A real tile's title ends with the newest entry (`placement`
or `assessment`), its `HH:MM:SS` time and `chosen` or the verbatim reason,
and the real host panel has a `Last placement` block: time, item (linked to
its task panel) or `host assessment`, `chosen`, `excluded`, `eligible` or
`eligible, not chosen`, and the verbatim reason, marked when it is older than
`placementMaxAgeSec`.

Real work now: one table row per open real session: host, task title (linked
to the task panel), stage (`implement`, the only stage the model has), model
`name (provider)`, elapsed time from registry `startedAt`, and tokens and
cost so far priced by `tokenCostScaled`. With no open session it reads `no
real session open` and names the newest last-finished item.

The real host panel opens with a `Now` block, the card: the stage and task
with its issue and PR links (PR shows `PR not opened yet` when null), the
model in use, elapsed time, tokens and cost so far and the latest model call
(time, in/out, ms); or for an idle host why, in probe terms (`Idle: no work
queued`, `Idle: person at the desk (...)`), the last round when it is not a
merge (`last round: <outcome>`; a findings round reads `(verdict missing)`
when the verdict store holds no verdict for the item and `(verdicts: error
(<code>))` or `(verdicts: no data (<reason>))` when the store cannot be
read), the last finished item at `HH:MM:SS` UTC (date first when not today)
and today's totals. Sources: dispatcher registry, recorded probes
(`loop-ports.jsonl` via `readRecordedProbes`), work store, loop results and
verdict store, meter usage log for tokens, cost and latest call, ledger for
today's totals.

Just finished (real): the newest 3 merged results as table rows: task title
link, host, outcome, audit counts (recounted via `verdictCounts`, linked to
the audit panel), cost and time. Sources: `loop-results.jsonl` newest 3, work
store title, verdict store counts, ledger cost.

Model activity is real only: the newest 12 meter `call-end` records, each
joined to its `call-start` for provider and model and to its grant for the
work item and host. The role is `session` when the grant is found (planner
and auditor calls are not metered, so they never appear). Cost is priced
with the dashboard's own arithmetic; a null token count shows `no data`
with the reason in the cell title, never 0. The ticker keeps the two clocks
apart: a Real events block and a Simulated events block, each newest first
with the newest 3 rows shown on Live; a simulated placement reads
`placed <item> on <host> because <reason>` with the reason verbatim from
the placement engine, or `<kind>: <title> placed on <host> because <reason>` when the placement carries a `task` (e.g. `research: Supplier research 012 placed on desk-121 because desk-121 is idle, ...`). A running simulated tile's title is `<alias>: running - <kind>: <title>` followed by the existing exclusion or idle detail, so `desk-121: running - data-analysis: Sales data analysis 033`; the tile face stays one line. Ticker rows are one line each, clipped
with an ellipsis and their full text in the row title, so the frame height
never depends on event text; a tile is as wide as its alias, so no alias
clips. A simulated tile that is running but whose last host line excludes
it carries an amber edge and a `!` marker when it is running, now excluded
for a reason other than its agent limit (the legend reads the same), with
the reason in the tile title.

The detail rail lives in the right rail (the fleet column does not move): a breadcrumb reads `Fleet / <host> / <task> / <audit>` with `back to live`; precedence is host → task → call → audit, well-formed unknown or malformed selection →404 without echoing the value. Work rows link as `/?view=live&task=<id>` only on the Work tab (no figure changes); the stacked snapshot has no such links. Links exist only when the server has live sources and the id is known (a known work item); otherwise the cell is plain text. They are built with `pageHref` from `view=live` plus `t`, `pause`, `task`, never wrapping model-written verdict text. The audit PR link is shown only when `panel.workItemRepo !== null && verdict.repo === panel.workItemRepo`; otherwise it is plain `#<n>` with `(repo differs)` when both repos are known. A call with a broken meter shows only breadcrumb, `Call <endedAt>` and one `error (<code>)` line, no `ms 0` or `-` fillers, and `|nosuch` is rejected with 404. Each panel keeps one block per source: both host panels use the same labelled blocks and tables, times as `HH:MM:SS` UTC with the date only when it is not the page's UTC day and the full ISO value in the `title`: a simulated host shows site, kind, state, running/max load, battery, task, then running tasks, latest events and placements as tables; a real host shows its probe (kind, time and cause), then open sessions (each linked to its task, model through the shared model name), recent results and recent meter calls as tables, both model columns as `name (provider)`; a simulated task shows kind, title, brief, placed at sim clock with verbatim placement reason and eligible count, host link and status running/ended via work-end clock; a real task shows title, status, repo, issue/PR links, branch, host link, preferred model, retry count, goal excerpt (first 280 chars with ellipsis and full goal in title; model names are never truncated, task goal excerpts are the one text cut, at 280 chars, with the full text on hover), DoD, rounds (with provider-stripped model), verdicts (recounted), ledger tokens and sessions as one block; a call shows provider, model as `name (provider)`, role, work item and host links, grouped tokens, ms and priced cost or no-data; an audit shows head SHA, recounted counts (`invalid (counts disagree)` on mismatch), repo, auditor, authors, findings and PR link when the repos match; each block keeps its own source with its heading, so a failed ledger renders one `Ledger: error (<code>)` line and other blocks keep data.

Failure rule, per section as on `/`: a missing input shows `no data`, an
unreadable or invalid one shows an error code with details in the
dashboard log. One invalid alias fails the whole simulated source with
`error (sim-trace-invalid)` and the real sections still render. Every
alias is checked against `^[a-z][a-z0-9-]{0,31}$` before it can reach the
page, and every value is escaped as on `/`. Every page reuses one `renderCell` with a `RenderContext` and the `verdictCounts` helper used by the model and both panel sites, with links built only through `pageHref`; `dashboard:snapshot` renders the stacked page through `renderDashboard` (`docs/demo/dashboard.html`).

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

# Budget guard

The budget guard refuses new model sessions at the daily or total spend cap.
Running sessions are never killed: they finish and their cost still lands in
the ledger. Escalation emits exactly one event per cap event, routed to the
coordinator's daily digest channel.

## Inputs

- Spend source: `UsageRecord` documents (contracts-v1) and pending usage
  entries as JSON lines in the ledger file at `config/ledger.json`
  `ledgerPath`. A record line is a bare `UsageRecord`; a pending line is a
  `{"pending": PendingUsage}` object. The guard reads both through
  `spendEntriesOf`: pending lines count as spend, so tokens are visible to
  the caps from session end instead of only at task completion. A missing
  file with an existing parent directory means zero spend; a missing or
  dangling parent, or a parent that is not a directory, exits 2 naming the
  path. A present line that fails validation is an error
  naming the line number and is never skipped. That includes a record line
  whose `finishedAt` passes the schema but does not parse (for example a
  leap second): the reader rejects it the same way.
- NVIDIA requests: a token on the NVIDIA provider with `requests: null` on
  the evaluation day is unknown spend, not zero: its `workItemId` is
  reported once in `unknownWorkItemIds` and the guard refuses with reason
  `spend unknown`. Null `inputTokens`/`outputTokens` on a priced provider
  keep the existing `SpendUnknownError` path.
- Prices: one descriptor per needed provider id at
  `config/providers/<id>.json` (see `config/providers/schema.json`), where the
  needed ids are every route id, `nvidiaProviderId` and every ledger provider.
  Other files in the directory are ignored, so a stale copy has no effect.
  The descriptor `id` must equal the file name stem; a missing, dangling or
  non-regular path exits 2. A descriptor is validated at runtime against
  `config/providers/schema.json` (Ajv 2020, `pricing` required): an invalid
  descriptor exits 2 with the validation errors and the file name. The value
  used is the JSON number as parsed: each validated price number goes through
  `Number.prototype.toString()`; the guard rejects a `toString()` result
  containing `e`/`E` or with more than 9 decimals. A source text with more
  digits than a double holds is outside the rule and is not detected. The
  guard prices all input tokens at `inputPer1M` and output tokens at
  `outputPer1M` per 1M tokens. All sums and cap comparisons are exact BigInt: cost accumulates undivided as tokens *
  priceNanoPer1M per scope and is compared with capNano * 1_000_000; a
  float appears only for display. Cached pricing is not applied because
  contracts-v1 `TokenUsage` has no cached-token count, so spend is an upper
  bound. Meta Contributor prices (0.10 input, 0.20 output USD per 1M) and the
  Muse Wonder Standard prices (4.00 input, 0.20 cached input, 20.00 output USD
  per 1M; `config/providers/meta-wonder.json`; source https://dev.meta.ai/docs/pricing-rate-limits,
  read 2026-10-28) and the unmetered NVIDIA Build (0) come from those
  descriptors, never from literals in code.
- Caps: `config/budget.json` (`dayCapUsd` 12, `totalCapUsd` 140,
  `nvidiaDailyRequestLimit`, `nvidiaProviderId`, `unmeasuredAuditCall`). Every field is required; a
  missing or unreadable file exits 2. Caps are validated JSON numbers
  converted by the same rule (no float on the decision path); the CLI
  `--spend`/`--day-cap`/`--total-cap` flag strings go through the same
  conversion directly. The route comes from
  `config/providers/route.json`, which must exist and hold a non-empty array
  of unique string ids in `providers`. `nvidiaProviderId` must be in the
  route and every route id must have a descriptor, or the run exits 2.

## Rules

- Day = UTC calendar day of `finishedAt`.
- Null token counts on a priced provider are "no data", never 0 USD silently:
  the guard refuses with reason `spend unknown`. An audit call that may be billed but reported no usage (a timeout or an unreadable 200; `source: auditor-usage`, null token counts, known `requests`) is not unknown: it counts at `config/budget.json` `unmeasuredAuditCall` per request, an upper bound because the audit prompt is capped by `maxDiffBytes`. `budget:check` then ends its line with `bounded items <n>`, and the dashboard and the digest mark the spend as including that bound. A metered entry with `unmeasuredRequests` counts each such call at `config/budget.json` `unmeasuredMeterCall`, whose `inputTokens` must be at least `config/meter.json` `maxRequestBytes` (the loop refuses to start otherwise), so the bound is hard on the input side. Every other null-token entry on a priced provider still refuses as `spend unknown`.
- At or above a USD cap, all new sessions are refused. NVIDIA daily requests
  at or above the limit refuse only sessions whose route starts at NVIDIA
  Build (reason names it).
- The bound mark belongs to the day that holds the bounded entries: a day line carries it only for bounded entries finished that day, while the total line carries it for every bounded entry.
- Decision output: `{ admit, reason, spentTodayUsd, spentTotalUsd,
nvidiaRequestsToday }`.

## Escalation

One per cap event: the state file under the configured `statePath`
(gitignored under `logs/`) keeps every escalated event key,
`{"escalated": ["total", "day:<UTC day>", ...]}`. The four key forms
are: `day:<UTC day>` for the daily cap, `nvidia:<UTC day>` for the
NVIDIA daily limit, `total` for the total cap (once regardless of the
day), `spend-unknown:<UTC day>` for unknown spend (once per day while
spend stays unknown). An event escalates only when its key is absent;
keys are never dropped because the set grows by at most a few keys a day.
The log line is appended first, then the state is persisted. Each
escalation appends one JSON line to `logs/budget-escalations.log` and
prints one line on stderr. A second
refusal for the same event writes nothing.

## CLI

```sh
bun run budget:check                                    # real config + ledger
bun run budget:check --spend 3.20 --day-cap 12 --total-cap 140   # admit (exit 0)
bun run budget:check --spend 12.00 --day-cap 12 --total-cap 140  # refuse (exit 3)
```

Exits 0 on admit, 3 on refuse, 2 on a config or data error. `MOC_BUDGET_NOW`
is test-only: when set, it must match
`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$` and round-trip
through `new Date(v).toISOString()` (impossible calendar dates like
2026-02-30 are rejected), and pins the evaluation time the CLI uses for
"today"; the CLI then prints `evaluation time pinned by
MOC_BUDGET_NOW: <now.toISOString()>` on stderr. An invalid value exits 2. The
`--spend` / `--day-cap` / `--total-cap` flags are a test override that
injects totals into the same decision function; `--day-cap` or `--total-cap`
without `--spend` exits 2, and the override path never writes escalation
state or the log — it only prints `would escalate: <event key>` on stderr.

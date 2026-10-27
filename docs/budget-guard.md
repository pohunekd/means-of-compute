# Budget guard

The budget guard refuses new model sessions at the daily or total spend cap.
Running sessions are never killed: they finish and their cost still lands in
the ledger. Escalation emits exactly one event per cap event, routed to the
coordinator's daily digest channel.

## Inputs

- Spend source: `UsageRecord` documents (contracts-v1) as JSON lines in the
  ledger file at `config/budget.json` `ledgerPath`. The guard only reads it;
  the ledger writer lives in #12. A missing file with an existing parent
  directory means zero spend; a missing or dangling parent, or a parent
  that is not a directory, exits 2 naming the path and the error code.
  A present line that fails `contracts/v1/validate.ts` is an error naming the
  line number and is never skipped.
- Prices: one descriptor per needed provider id at
  `config/providers/<id>.json` (see `config/providers/schema.json`), where the
  needed ids are every route id, `nvidiaProviderId` and every ledger provider.
  Other files in the directory are ignored, so a stale copy has no effect.
  The descriptor `id` must equal the file name stem; a missing, dangling or
  non-regular path exits 2. A descriptor without a `pricing` block is a load
  error naming the file; "free" must be stated with explicit zero prices.
  Prices are read from the JSON source text with a small tokenizer into
  integer nano-USD per 1M tokens (at most 9 decimals; the JSON parser would
  lose the decimal text), so the descriptors stay plain JSON numbers and
  the schema is unchanged. The guard prices all input tokens at `inputPer1M`
  and output tokens at `outputPer1M` per 1M tokens. All sums and cap
  comparisons use BigInt nano-USD; a float appears only for display. Cached pricing is not applied because
  contracts-v1 `TokenUsage` has no cached-token count, so spend is an upper
  bound. Meta Contributor prices (0.10 input, 0.20 output USD per 1M) and the
  unmetered NVIDIA Build (0) come from those descriptors, never from
  literals in code.
- Caps: `config/budget.json` (`dayCapUsd` 12, `totalCapUsd` 140,
  `nvidiaDailyRequestLimit`, `nvidiaProviderId`). Every field is required; a
  missing or unreadable file exits 2. The route comes from
  `config/providers/route.json`, which must exist and hold a non-empty array
  of unique string ids in `providers`. `nvidiaProviderId` must be in the
  route and every route id must have a descriptor, or the run exits 2.

## Rules

- Day = UTC calendar day of `finishedAt`.
- Null token counts on a priced provider are "no data", never 0 USD silently:
  the guard refuses with reason `spend unknown`.
- At or above a USD cap, all new sessions are refused. NVIDIA daily requests
  at or above the limit refuse only sessions whose route starts at NVIDIA
  Build (reason names it).
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
The log line is
line to `logs/budget-escalations.log` and prints one line on stderr. A second
refusal for the same event writes nothing.

## CLI

```sh
bun run budget:check                                    # real config + ledger
bun run budget:check --spend 3.20 --day-cap 12 --total-cap 140   # admit (exit 0)
bun run budget:check --spend 12.00 --day-cap 12 --total-cap 140  # refuse (exit 3)
```

Exits 0 on admit, 3 on refuse, 2 on a config or data error. `MOC_BUDGET_NOW`
is test-only: when set, it must match
`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$` and parse to a
valid date, and pins the evaluation time the CLI uses for "today"; the
CLI then prints `evaluation time pinned by MOC_BUDGET_NOW: <ts>` on
stderr. An invalid value exits 2. The
`--spend` / `--day-cap` / `--total-cap` flags are a test override that
injects totals into the same decision function; `--day-cap` or `--total-cap`
without `--spend` exits 2, and the override path never writes escalation
state or the log — it only prints `would escalate: <event key>` on stderr.

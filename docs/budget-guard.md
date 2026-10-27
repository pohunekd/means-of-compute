# Budget guard

The budget guard refuses new model sessions at the daily or total spend cap.
Running sessions are never killed: they finish and their cost still lands in
the ledger. Escalation emits exactly one event per cap event, routed to the
coordinator's daily digest channel.

## Inputs

- Spend source: `UsageRecord` documents (contracts-v1) as JSON lines in the
  ledger file at `config/budget.json` `ledgerPath`. The guard only reads it;
  the ledger writer lives in #12. A missing file means zero spend. A present
  line that fails `contracts/v1/validate.ts` is an error naming the line
  number and is never skipped.
- Prices: provider descriptors under `config/providers/` (see
  `config/providers/schema.json`). A descriptor without a `pricing` block is
  a load error naming the file; "free" must be stated with explicit zero
  prices. The guard prices all input tokens at `inputPer1M` and output tokens
  at `outputPer1M` per 1M tokens. Cached pricing is not applied because
  contracts-v1 `TokenUsage` has no cached-token count, so spend is an upper
  bound. Meta Contributor prices (0.10 input, 0.20 output USD per 1M) and the
  unmetered NVIDIA Build (0) come from those descriptors, never from
  literals in code.
- Caps: `config/budget.json` (`dayCapUsd` 12, `totalCapUsd` 140,
  `nvidiaDailyRequestLimit`, `nvidiaProviderId`). Every field is required; a
  missing one is a startup error.

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
`{"escalated": ["total", "day:<UTC day>", ...]}`: `day:<UTC day>` for
the daily cap, `nvidia:<UTC day>` for the NVIDIA daily limit, `total` for the
total cap (once regardless of the day). An event escalates only when its key
is absent; keys are never dropped because the set grows by at most a few
keys a day. The log line is
appended first, then the state is persisted. Each escalation appends one JSON
line to `logs/budget-escalations.log` and prints one line on stderr. A second
refusal for the same event writes nothing.

## CLI

```sh
bun run budget:check                                    # real config + ledger
bun run budget:check --spend 3.20 --day-cap 12 --total-cap 140   # admit (exit 0)
bun run budget:check --spend 12.00 --day-cap 12 --total-cap 140  # refuse (exit 3)
```

Exits 0 on admit, 3 on refuse, 2 on a config or data error. `MOC_BUDGET_NOW`
is test-only: when set, it must be an ISO-8601 UTC timestamp and pins the
evaluation time the CLI uses for "today"; an invalid value exits 2. The
`--spend` / `--day-cap` / `--total-cap` flags are a test override that
injects totals into the same decision function; `--day-cap` or `--total-cap`
without `--spend` exits 2, and the override path never writes escalation
state or the log — it only prints `would escalate: <event key>` on stderr.

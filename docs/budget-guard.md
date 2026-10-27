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
  `config/providers/schema.json`). The guard multiplies input, cached input
  and output tokens by `inputPer1M`, `cachedInputPer1M`, `outputPer1M` per 1M
  tokens. Meta Contributor prices (0.10 input, 0.002 cached input, 0.20 output
  USD per 1M) and the unmetered NVIDIA Build (0) come from those descriptors,
  never from literals in code.
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
(gitignored under `logs/`) remembers the last escalated cap kind plus UTC day.
Each escalation appends one JSON line to `logs/budget-escalations.log` and
prints one line on stderr. A second refusal for the same event writes nothing.

## CLI

```sh
bun run budget:check                                    # real config + ledger
bun run budget:check --spend 3.20 --day-cap 12 --total-cap 140   # admit (exit 0)
bun run budget:check --spend 12.00 --day-cap 12 --total-cap 140  # refuse (exit 3)
```

Exits 0 on admit, 3 on refuse, 2 on a config or data error. The `--spend` /
`--day-cap` / `--total-cap` flags are a test override that injects totals into
the same decision function; they change neither stored config nor the ledger.

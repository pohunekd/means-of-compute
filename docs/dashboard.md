# Dashboard

One page served by the factory process. It reads the ledger file and config
prices and renders server-side; there is no client JavaScript, no
auto-refresh and no external resource. The operator reloads the page.

## Run

```sh
MOC_DASHBOARD_LISTEN=127.0.0.1:8080 bun run factory:serve --ledger <path> [--verdicts <dir>]
```

- `--ledger` defaults to the `ledgerPath` of `config/ledger.json`.
- `--verdicts` defaults to the `verdictDir` of `config/auditor.json`.
- `MOC_DASHBOARD_NOW` pins the clock for tests; unset means the real clock.
- The listen address must be loopback (`127.0.0.0/8` or `[::1]`); anything
  else exits 2.

Remote viewing is not in v1: run the command on the factory machine, or use
`ssh -L <p>:127.0.0.1:<p> <factory machine>` with the same port number.

## Panels

Fleet, Work, Usage, Savings, Autonomy. Every figure names its source; for
money, the config price entry. No estimated numbers: a missing input shows
"no data", and an unreadable one shows an error code with details in
`logs/dashboard.jsonl`.

## Status rule (Work)

1. A known work item shows its status (plus reason when set).
2. Otherwise the ledger decides: `done` for a `success` record, `blocked`
   for a `blocked` record, else `session ended, not finalized` for pending
   entries.

## Privacy

Hosts appear by alias only, never by hostname or address. The verdict table
shows counts per head SHA, never finding texts.

# Means of Compute: submission

## What it is

Means of Compute is an autonomous software factory that runs coding-agent work on
machines a company already owns. A coordinator on a Meta model turns a goal into a
dependency graph of work items. A loop places each item on an idle machine, runs a
coding session there, has a different model audit the result, and merges only what
passes a fixed rule. The human sets goals, reads one digest a day, and can revert.

## What was built during the hackathon

The repository was created on 2026-10-26 and holds only work created from that date
on. The factory built much of itself: of the twenty merges from the handover commit
`4f2112a` (PR #144) through `a8670d9`, twelve come from the loop's own `moc/`
branches (step 7 of [docs/demo/script.md](docs/demo/script.md)). Each carries a
`moc:work-item` marker and a Muse Spark audit verdict bound to the merged head
commit. These production runs ran on one host, display alias `desktop`.

## Architecture

Details: [docs/architecture.md](docs/architecture.md).

- Coordinator: Muse Code turns one goal file into work items over MCP.
- MCP server: `submit_work` stores a DAG of work items.
- Loop: place, run, audit, merge by rule, stall and retry, follow-ups, daily digest.
- Placement: a pure function over each machine's reported capacity.
- Dispatcher: starts and watches sessions through `DispatcherPort`.
- Metering proxy: holds the provider keys, records per-session token usage.
- Ledger and budget guard: usage per item, read before every new model session.
- Dashboard: one loopback-only page.
- Merge rule: required checks green and a valid audit verdict for that exact head
  commit, to which the merge is pinned.

## Meta models

- Muse Glimmer 30B, open weights (`meta/muse-glimmer-30b`, NVIDIA Build): the main
  coder; work items start on it (`config/loop.json`). It also audits work written by
  Muse Spark (`config/auditor.json`).
- Muse Spark Contributor (`muse-spark-1.3-contributor`, Meta API): coordinator and
  planner, routine auditor of Glimmer work, and fallback coder: the loop routing can
  start a whole item on Spark. A model never audits its own work.
- The coordinator runs Muse Code with
  `--model muse-spark-1.3-contributor --contributor-mode on`; the model id is fixed
  in `config/coordinator.json` and checked on load.
- Every Muse Spark call uses the Contributor variant: `muse-spark-1.3-contributor`
  is the only Muse Spark id in the provider descriptors (`config/providers/`).
- Muse Wonder (`muse-wonder-1.0`) audits only when an audit is marked
  `--phase-critical yes`. It is never in the provider route.
- Every runtime model call goes to a Meta model. Each provider descriptor is
  validated on load against `config/providers/schema.json`, which accepts only Meta
  model ids. A fleet session never picks its model: the metering proxy sets it. The
  route is NVIDIA Build, then the Meta API (`config/providers/route.json`). The
  same schema covers the local open-weights descriptor
  (`config/providers/local.json`, `muse-glimmer-30b`), which is not in the route
  today.

## Pohunek

Pohunek is the owner's session daemon, an external project that existed before this
repository. Means of Compute uses it only as a dependency through `@pohunek/sdk`
(0.38.1, see `package.json`), behind `DispatcherPort`. No Pohunek code,
documentation or instruction text is in this repository. Pohunek itself is not
judged.

## Try it without a login

The stub demo needs no account, login, API key or Pohunek daemon. Follow the "Stub
demo" and "Dashboard over the demo data" steps of the [README](README.md), or the
checklist in [docs/demo/script.md](docs/demo/script.md):

```sh
bun install --frozen-lockfile
bun run loop --stub --queue tests/fixtures/loop/queue.json
```

It runs the real scheduler, dispatcher, meter, budget guard, auditor and merge rule
on recorded model replies served over loopback, so no paid call is made. Success is
`loop: stub run done merged=3 blocked=0 parked=0`.

To see the production numbers without running anything, download [docs/demo/dashboard.html](docs/demo/dashboard.html) and open it in a browser. It is the dashboard page rendered from the recorded production data as of the time in its header, with hosts shown by display alias.

## Spend caps

The budget guard reads `config/budget.json` before every new model session and every
audit call:

- `dayCapUsd` 12: at or above this spend in the current UTC day, new sessions and
  audit calls are refused.
- `totalCapUsd` 140: at or above this total spend, the same refusal.
- `nvidiaDailyRequestLimit` 1000: at or above this many NVIDIA Build requests in the
  current UTC day, sessions whose route starts at NVIDIA Build are refused.

A running session is never killed at a cap. Unmeasured spend also refuses new
sessions. See [docs/budget-guard.md](docs/budget-guard.md).

## Numbers

After the stub run:

```sh
bun run demo:numbers --ledger logs/loop-demo/ledger.jsonl --sources
```

Each figure names its ledger rows and config price entry. The stub run shows 3 tasks
succeeded and 0 blocked; local token share 0.0000 (0 of 6,352 tokens; NVIDIA Build
is a cloud provider); actual token cost $0.0001 against a frontier-token baseline of
$0.0310; 0 human interventions and 0 retries; `meta/muse-glimmer-30b` 4
sessions, 4 ended ok. These come from recorded replies, not from a production run.

## License

[Business Source License 1.1](LICENSE), with these parameters:

- Licensor: Martin Zajíc
- Licensed Work: Means of Compute
- Additional Use Grant: "You may make production use of the Licensed Work,
  provided that you do not offer the Licensed Work, or any service based on it, to
  third parties for a fee or as a hosted or managed service, and provided that (a)
  as an individual, you run it on no more than 5 hosts, or (b) as a legal entity
  with annual revenue below EUR 1,000,000, you run it on no more than 10 hosts."
- Change Date: 2030-11-04
- Change License: Apache License, Version 2.0

## Multi-host run

This section is filled from the #18 run record.

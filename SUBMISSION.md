# Means of Compute: submission

## What it is

Means of Compute is an autonomous software factory that runs coding-agent work on
machines a company already owns. A coordinator on a Meta model turns a goal into a
dependency graph of work items. A loop places each item on an idle machine, runs a
coding session there, has a different model audit the result, and merges only what
passes a fixed rule. The human sets goals, reads one digest a day, and can revert.

Video: <video link>

## What was built during the hackathon

The repository was created on 2026-10-26 and holds only work created from that date on. Since the handover commit `4f2112a` (2026-10-30), 52 of the repository's 190 merged pull requests came from the loop's own `moc/` branches. Each carries a `moc:work-item` marker and an audit verdict from a different Meta model bound to the exact merged commit. The work includes code, docs and non-code tasks such as a report written from the git history.

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

- Muse Glimmer 30B, open weights (NVIDIA Build), coder for most factory tasks (45 successful sessions)
- Muse Spark Open (`meta-models/muse-spark-open-1026`, Baseten), default coder for GitHub intake items (14 successful sessions)
- Muse Spark Contributor (`muse-spark-1.3-contributor`, Meta API), coordinator and planner, auditor of factory pull requests and fallback coder (8 successful sessions)
- The coordinator runs Muse Code with `--model muse-spark-1.3-contributor --contributor-mode on`; the model id is fixed in `config/coordinator.json` and checked on load.
- Every Muse Spark call uses the Contributor variant: `muse-spark-1.3-contributor` is the only Muse Spark id in the provider descriptors (`config/providers/`).
- Muse Wonder (`muse-wonder-1.0`) audits only when an audit is marked `--phase-critical yes`. It is never in the provider route.
- A model never audits its own work.
- Every runtime model call goes to a Meta model. Each provider descriptor is validated on load against `config/providers/schema.json`, which accepts only Meta model ids. A fleet session never picks its model: the metering proxy sets it. The route is NVIDIA Build, then the Meta API (`config/providers/route.json`). The same schema covers the local open-weights descriptor (`config/providers/local.json`, `muse-glimmer-30b`), which is not in the route today.

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

The budget guard reads `config/budget.json` before every new model session and every audit call:

- Meta pool (`meta`): 12 USD per UTC day and 140 USD total (`dayCapUsd` 12, `totalCapUsd` 140)
- Baseten pool (`baseten`): 19 USD per day and 75 USD total (`dayCapUsd` 19, `totalCapUsd` 75) for provider `baseten`
- NVIDIA Build limit of 1000 requests per UTC day (`nvidiaDailyRequestLimit` 1000)

A running session is never killed at a cap. Unmeasured spend also refuses new sessions. See [docs/budget-guard.md](docs/budget-guard.md).

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

Production ledger (2026-10-30 to 2026-11-03):

- 49 work items succeeded and 1 was blocked
- 52 merged pull requests authored by the factory
- Factory model spend 14.89 USD on Baseten and 0.29 USD on the Meta API, Glimmer on NVIDIA Build free
- Cached input metered from the provider's `cached_tokens`, 94% of input cached on long tasks

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

The factory ran on four machines shown by display alias. Every machine runs the host probe and the loop records a placement decision with a reason for each machine at least every two minutes.

Work sessions ran on `desktop` (29 items, 7.95 hours) and `laptop-b` (24 items, 5.37 hours), and briefly on `laptop-mac` (2 items). `laptop-a` was eligible most of the week but never chosen: placement scores free CPU, memory and GPU, and `laptop-b` had more free memory. In the demo it is unplugged and shown as blocked with the reason "not on AC power".

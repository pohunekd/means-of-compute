# Means of Compute

Means of Compute is an autonomous software factory that runs coding-agent work on
machines a company already owns. A coordinator turns a goal into a dependency graph
of work items. A loop places each item on an idle machine, runs a coding session
there, has a different model audit the result, and merges only what passes a fixed
rule. The human sets goals, reads one digest a day, and can revert.

The factory builds itself. The repository was created on 2026-10-26 and holds only
work created from that date on. The handover commit `4f2112a` (2026-10-30) merges an
item of the first goal that the Meta coordinator dispatched through the factory's MCP
server ([docs/demo/handover-goal.json](docs/demo/handover-goal.json)). Since then the loop
has opened, audited and merged its own pull requests, for example #158, #163, #165,
#172 and #173. Each one carries a `moc:work-item` marker in its body and a Muse Spark
audit verdict bound to the merged head commit. The loop acts on GitHub under the
account configured as `github.factoryLogin`. Pull request #173 shows a full cycle:
the first head got three high findings and one medium finding, the next round fixed
them, and the merged head has a clean verdict.

At runtime every model call goes to a Meta model. The provider schema
(`config/providers/schema.json`) accepts only Meta model ids.

Built for the Meta Global AI Developer Hackathon (2026-10-26 to 2026-11-04).

## How Meta models are used

| Role                  | Model                                                       | Provider     |
| --------------------- | ----------------------------------------------------------- | ------------ |
| Main coder            | Muse Glimmer 30B, open weights (`meta/muse-glimmer-30b`)    | NVIDIA Build |
| Fallback coder        | Muse Spark Contributor (`muse-spark-1.3-contributor`)       | Meta API     |
| Intake coder          | Muse Spark Open (`meta-models/muse-spark-open-1026`)        | Baseten      |
| Coordinator / planner | Muse Code with Muse Spark Contributor                       | Meta API     |
| Routine auditor       | Muse Spark Contributor, or Muse Glimmer 30B (see the rule)  | as above     |
| Phase-critical audit  | Muse Wonder (`muse-wonder-1.0`), only when explicitly asked | Meta API     |

- Every Muse Spark call uses the Contributor variant `muse-spark-1.3-contributor`. Muse Spark Open
  is a separate open-weights model served by Baseten, not a Muse Spark API variant.
- The coordinator runs Muse Code with
  `--model muse-spark-1.3-contributor --contributor-mode on`
  (`config/coordinator.json`).
- Work items start on their preferred model; GitHub intake items start on Muse Spark
  Open, paid from the separate `baseten` budget pool. The loop routing
  (`config/loop.json`) can move a whole item to Muse Spark Contributor before its
  first round, from Glimmer or from Spark Open.
- A model never audits its own work. The auditor is the first entry of `auditors` in
  `config/auditor.json` that is not an author of the item. Glimmer work is audited
  by Spark, Spark Open work by Spark Contributor, and Spark work by Glimmer. When no eligible auditor is left, the item
  parks instead of starting.
- Muse Wonder is the `mergeAuditor`. It runs only for an audit marked
  `--phase-critical yes` and is never in the provider route.

## Architecture

The full description is in [docs/architecture.md](docs/architecture.md).

- **Coordinator** ([docs/coordinator.md](docs/coordinator.md)): Muse Code turns one
  goal file into work items and calls the factory over MCP.
- **MCP server** ([docs/mcp.md](docs/mcp.md)): `submit_work` stores a DAG of work
  items. Fleet-level requests such as approvals and pauses wait for a human to
  confirm them through the `approvals` CLI.
- **Loop** ([docs/loop.md](docs/loop.md)): drives each item through place, run,
  audit and merge, plus stall and retry handling, follow-up issues and a daily
  digest.
- **Placement**: a pure function over each machine's reported capacity. A machine is
  used only when it is idle, on AC power, above the battery floor and inside its
  policy window. The capacity comes from a probe that ships to each machine as a
  plugin package.
- **Dispatcher** ([docs/dispatcher.md](docs/dispatcher.md)): starts and watches
  sessions through `DispatcherPort`, the only seam to the session daemon, and
  reschedules an item whose machine leaves or whose session is lost.
- **Meter** ([docs/meter.md](docs/meter.md)): every model call from a fleet session
  goes through a metering proxy. The proxy holds the provider keys and records
  per-session token usage.
- **Ledger and budget guard** ([docs/ledger.md](docs/ledger.md),
  [docs/budget-guard.md](docs/budget-guard.md)): the ledger stores usage per item,
  and the guard reads it before every new model session.
- **Dashboard** ([docs/dashboard.md](docs/dashboard.md)): one loopback-only page
  with fleet, work, usage and savings, rendered on the server.
- **Merge rule**: the loop merges a pull request only when its required checks are
  green and a valid audit verdict exists for that exact head commit. The merge is
  pinned to that commit.

## Pohunek

Pohunek is the owner's session daemon, an external project that existed before this
repository. Means of Compute uses it only as a dependency through `@pohunek/sdk`
(version 0.38.1, see `package.json`), behind `DispatcherPort`. No other module
imports the SDK, and no Pohunek code, documentation or instruction text is copied
into this repository.

### Pohunek setup

The stub demo needs none of this: it runs an in-memory port behind `DispatcherPort`.
A production run needs:

- The Pohunek release that matches the SDK pin,
  [v0.38.1](https://github.com/zajca/pohunek/releases/tag/v0.38.1). It is public and also
  holds the `pohunek-ts-sdk-0.38.1.tgz` tarball that `bun install` downloads.
- A daemon from that release, installed and started on the factory machine and on every
  fleet machine as Pohunek's own
  [install guide](https://github.com/zajca/pohunek/blob/v0.38.1/docs/install.md) describes.
- The connection settings in `config/pohunek-adapter.json`. The adapter talks to the
  daemon on the factory machine over its local socket, and reaches each fleet machine's
  Pohunek daemon through the route that the routes file named by `MOC_HOST_ROUTES_FILE`
  maps to its display alias. The routes file names private routes, so keep it outside
  the repository.
- The Pohunek agent profile `moc-worker` (`agentProfile`) on every fleet machine. Each
  session starts with that profile in the project `means-of-compute` (`project`), and the
  start preflight refuses a machine whose daemon does not serve it. The profile setup is
  in the "Host setup" section of [docs/meter.md](docs/meter.md), and the start checks in
  the "Host precondition" section of [docs/dispatcher.md](docs/dispatcher.md).

## Self-hosted install

Prerequisites:

- Bun 1.4.2 (the `packageManager` version; CI uses the same).
- git.
- Network access for `bun install`: `@pohunek/sdk` is downloaded as a GitHub
  release tarball.

First commands, from a fresh clone:

```sh
bun install --frozen-lockfile
bun run gates
```

`bun run gates` prints one line per gate. Success is eight lines with `rc=0`:
`format`, `lint`, `typecheck`, `contracts`, `providers`, `plugin-digest`, `docs-links` and
`test`.

### Stub demo

```sh
bun run loop --stub --queue tests/fixtures/loop/queue.json
```

The stub run needs no login, no environment variables, no config file to copy and
no network beyond `127.0.0.1`. It runs the real scheduler, dispatcher, meter,
budget guard, auditor and merge rule against a local sandbox under
`logs/loop-demo/`. The model replies are recorded
(`tests/fixtures/loop/recordings.json`) and served over loopback, so no paid call is
made. Success looks like this, with exit code 0, in a few seconds:

```text
loop: running (stub)
loop: stub run done merged=3 blocked=0 parked=0
```

The run also writes a daily digest to `logs/loop-demo/digest/`. It can be run again;
each run resets the sandbox.

### Dashboard over the demo data

```sh
MOC_DASHBOARD_LISTEN=127.0.0.1:8080 bun run factory:serve \
  --ledger logs/loop-demo/ledger.jsonl \
  --verdicts logs/loop-demo/verdicts \
  --registry logs/loop-demo-registry.json \
  --results logs/loop-demo/loop-results.jsonl \
  --work logs/loop-demo/work-items.json
```

Success is the line `factory: dashboard listening (dashboard) port 8080`. Then
`http://localhost:8080/` lists three `done` items with their audit verdicts and the
spend against the caps. Fleet columns show "no data (host state not wired)" in this
mode, which is expected. Without the flags the dashboard reads the production paths
under `logs/`.

A static snapshot of the production dashboard is committed as [docs/demo/dashboard.html](docs/demo/dashboard.html). It was rendered by `bun run dashboard:snapshot` from the recorded ledger, verdicts, registry and loop results, as of the time in its header. GitHub shows the file as source, so download it and open it in a browser. The "Static snapshot" section of [docs/dashboard.md](docs/dashboard.md) describes the command.

### Production run (outline)

A production run needs more than this section covers. See the "Production run"
section of [docs/loop.md](docs/loop.md), and [docs/meter.md](docs/meter.md) and
[docs/dispatcher.md](docs/dispatcher.md). In short:

- A Pohunek daemon 0.38.1 or later on every fleet machine, running the probe plugin
  package built with `bun run plugin:build --out logs/plugin`. The output directory must
  be absent or empty, and `logs/` is gitignored.
- `cp config/hosts.example.json config/hosts.json`, then map each hostname to a
  display alias. `config/hosts.json` is gitignored.
- The GitHub CLI logged in as the account named in `github.factoryLogin`.
- Environment variables, set by name and never committed: `META_API_KEY`,
  `NVIDIA_API_KEY`, `MOC_GITHUB_TOKEN`, `MOC_METER_SECRET`, `MOC_METER_LISTEN`,
  `MOC_METER_HOST_ADDRESSES_FILE`, `MOC_HOST_ROUTES_FILE` and `MOC_DASHBOARD_LISTEN`.
- Then `bun run loop` for the loop and `bun run coord --goal <file> --phase full`
  for the coordinator.

## Spend caps

The budget guard reads `config/budget.json` before every new model session and every
audit call:

- `dayCapUsd` (12): at or above this spend in the current UTC day, new sessions and
  audit calls are refused.
- `totalCapUsd` (140): at or above this total spend, new sessions and audit calls
  are refused.
- `pools`: providers paid from a separate credit, each pool with its own day and
  total cap. The two caps above belong to the main pool (`poolId`), which holds
  every other provider; a pool at its cap refuses only calls on its own providers.
- `nvidiaDailyRequestLimit` (1000): at or above this many NVIDIA Build requests in
  the current UTC day, sessions whose route starts at NVIDIA Build are refused.
  NVIDIA Build is priced at 0, so this limit applies instead of a dollar cap.

A running session is never killed at a cap: it finishes, and its cost still lands in
the ledger. Spend that cannot be measured counts as unknown, and unknown spend also
refuses new sessions. Prices come from the provider descriptors in
`config/providers/`. `bun run budget:check` prints the current decision for each pool.

## Contributing

Agent and contributor rules start at [AGENTS.md](AGENTS.md).

## License

[Business Source License 1.1](LICENSE). The Additional Use Grant allows production
use on up to 5 hosts for an individual, or up to 10 hosts for a legal entity with
annual revenue below EUR 1,000,000, as long as the work is not offered to third
parties for a fee or as a hosted or managed service. On the Change Date, 2030-11-04,
the license changes to the Apache License, Version 2.0. See the LICENSE file for the
full terms.

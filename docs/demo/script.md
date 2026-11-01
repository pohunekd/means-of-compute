# Demo script

A runnable checklist for the three-minute demo video. Each step has a one-line
narration, the command to run and the visible effect to expect. No step needs a
login, an API key or a secret. Steps 3 to 6 run in a fresh clone; the only
environment variable is `MOC_DASHBOARD_LISTEN` in step 5, which sets the dashboard
port. Steps 1, 2, 7 and 8 show the recorded production work through the
repository and public GitHub pages.

## What the video states

- Pohunek is the owner's session daemon, an external project the factory depends
  on. In production it runs each coding session; the factory reaches it only
  through `@pohunek/sdk` behind `DispatcherPort` ([dispatcher](../dispatcher.md)).
  The stub demo puts an in-memory port behind the same seam, so no Pohunek daemon
  is needed.
- At runtime every model call goes to a Meta model: Muse Glimmer 30B on NVIDIA
  Build writes the code, Muse Spark Contributor (`muse-spark-1.3-contributor`) on
  the Meta API plans, audits and is the fallback coder. In the stub demo the model
  replies are recorded and served over loopback, so no paid call is made.
- Spend caps from `config/budget.json`: `dayCapUsd` 12, `totalCapUsd` 140 and
  `nvidiaDailyRequestLimit` 1000. At a cap, new sessions and audit calls are
  refused ([budget guard](../budget-guard.md)).
- The production runs shown here ran on the hosts with display aliases `desktop` and `laptop-b`. The snapshot's Fleet panel also lists `laptop-mac`, whose starts the host rejected, so it ran no work.

## Before recording

Run once in a fresh clone, off camera (the gates take about 40 seconds):

```sh
bun install --frozen-lockfile
bun run gates
```

expected: eight lines `gate <name> rc=0` for `format`, `lint`, `typecheck`,
`contracts`, `providers`, `plugin-digest`, `docs-links` and `test`.

## Steps

### 1. Goal in

Narration: "A human writes one goal; the Meta coordinator turns it into work items."

command: `cat docs/demo/handover-goal.json`

expected: the goal "Handover: docs link check and a work store summary", issues
125, 126 and 127, `maxItems` 3, `preferredModel` `meta/muse-glimmer-30b`.

### 2. The coordinator run (recorded)

Narration: "Muse Code on Muse Spark Contributor planned it through our MCP server,
and the factory delivered all three items with no human action."

command: open
https://github.com/pohunekd/means-of-compute/issues/16#issuecomment-6529260009

expected: the Handover record. One `submit_work` call with three items, where
`handover-summary-cli` depends on `handover-work-summary`. The table lists PRs
#144, #145 and #146, each by Glimmer 30B on `desktop`, Spark audit 0/0/0,
`humanInterventions` 0. The run stopped `goal-terminal`.

### 3. The loop, live

Narration: "The same loop runs here on recorded model replies: real scheduler,
dispatcher, meter, budget guard, auditor and merge rule."

command: `bun run loop --stub --queue tests/fixtures/loop/queue.json`

expected: exit 0 after a few seconds with these two lines:

```text
loop: running (stub)
loop: stub run done merged=3 blocked=0 parked=0
```

The queue is a small DAG: `demo-b` depends on `demo-a`, `demo-c` is independent.

### 4. Placement, audit, merge by rule

Narration: "Each round is placed on a host, audited by a different model, and merged
only with green checks and a clean verdict for that exact head."

command:
`grep -E '"event":"(claim|verdict|merged)"' logs/loop-demo/loop.jsonl`

expected: every `claim` has `"hostAlias":"desktop"`. `demo-a` gets
`"code":"findings"` in round 0 and `"code":"clean"` in round 1. Three `merged`
lines, one per item. Order and commit ids vary between runs.

### 5. Dashboard counters

Narration: "One loopback page shows work, verdicts and spend against the caps."

command:
`MOC_DASHBOARD_LISTEN=127.0.0.1:8080 bun run factory:serve --ledger logs/loop-demo/ledger.jsonl --verdicts logs/loop-demo/verdicts --registry logs/loop-demo-registry.json --results logs/loop-demo/loop-results.jsonl --work logs/loop-demo/work-items.json`,
then open `http://localhost:8080/`

expected: the line `factory: dashboard listening (dashboard) port 8080`. Work
lists `demo-a`, `demo-b` and `demo-c` as `done`; `demo-a` shows two verdicts by
`muse-spark-1.3-contributor`, high 1 at the first head and clean at the second.
Usage shows spent today $0.0001 against the day cap $12.0000 and the total cap
$140.0000, and NVIDIA Build requests 4 of 1,000. Fleet shows "no data (host state
not wired)", which is expected in the stub. Stop the server with Ctrl-C.

### 6. Benchmark numbers

Narration: "Every number cites its ledger rows, and every price its config entry."

command:
`bun run demo:numbers --ledger logs/loop-demo/ledger.jsonl --sources`

expected: Tasks completed 3 succeeded, 0 blocked. Local token share
`0.0000 local (0 of 6,352 tokens)`, since NVIDIA Build is a cloud provider. Actual
token cost $0.0001 against a frontier-token baseline of $0.0310. Human
interventions 0, retries 0, `meta/muse-glimmer-30b` 4 sessions, 4 ended ok. Each row has a
sources cell that names the ledger rows and the config price entry, or
`config: none` for a plain count.

### 7. The factory builds itself (recorded)

Narration: "Since the handover commit the loop has opened, audited and merged its
own pull requests."

command:
`git log --first-parent --merges --format=%s 4f2112a~1..a8670d9 | awk '/from pohunekd\/moc\//{f++} END{print f " of " NR}'`

expected: `12 of 20`. Twelve of the twenty merges from the handover commit
`4f2112a` (PR #144) through `a8670d9` come from `moc/` branches, the loop's branch
prefix in `config/dispatcher.json`. The loop acts under the account configured as
`github.factoryLogin`.

### 8. One full audit cycle (recorded)

Narration: "The auditor found three high issues at the first head; the next round
fixed them, and only the clean head merged."

command: open https://github.com/pohunekd/means-of-compute/pull/173

expected: the body starts with the marker `moc:work-item:gh-moc-167`. Two
`audit:v1` comments by `muse-spark-1.3-contributor`: high 3, medium 1 at
`9403eda`, then high 0, medium 0, low 0 at the merged head `b3f48d3`.

## Multi-host run (W3.1)

This section is filled from the #18 run record.

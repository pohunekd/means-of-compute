# Coordinator

The coordinator turns one goal file into a DAG of work items through the
MCP server. The skill, the goal format and the prompt bytes live here.

## Skill layout

`.agents/skills/factory-coord/SKILL.md` names the `factory` MCP tools and the
rules for plan and react sessions. `examples/plan-dag.json` shows a three-item
DAG; `examples/followup-item.json` shows one follow-up item.

## Goal format

A goal is the JSON in `src/coord/goal.schema.json` with ten keys:
`schemaVersion`, `goalId`, `idPrefix`, `repo`, `title`, `outcome`,
`constraints`, `issues`, `maxItems` and `preferredModel`. `loadGoal`
validates the file, then bounds the outcome length, `maxItems`, the repo
and the model against the work config and the factory specs. The first
failure throws `GoalError`.

## Prompt bytes

`loadSkill` reads the skill body and both examples. `renderPlanPrompt` builds
the plan session prompt; `renderReactPrompt` adds the attention list. Fences
grow past any backticks inside the payload. The Goal and Attention blocks
are exactly `JSON.stringify` with two-space indent. `.prettierignore`
excludes `tests/fixtures/coord/prompt-*-expected.md`, so Prettier never
rewrites the committed prompts; any new byte-exact `.md` fixture needs
its own ignore line.

## Launcher config and Muse argv

`loadCoordConfig` reads `config/coordinator.json` with 20 required keys:
`museCommand`, `providerId`, `model`, `contributorMode`, `approvalMode`,
`envPassthrough`, `mcpConfigPath`, `budgetGateConfigPath`, `skillDir`,
`runsDir`, `maxRunsPerDay`, `maxOutcomeChars`, `maxToolOutputBytes`,
`killGraceMs`, `exportTimeoutMs`, `plan`, `react`, `watch`, `seed` and
`evidenceDenyPatterns`.
The provider and model stay pinned to `meta-api` and
`muse-spark-1.3-contributor`. The config names the key variable only:
`apiKeyEnv` comes from the provider descriptor and its value is never
read. `envPassthrough` excludes `HOME`, `XDG_*` and the key variable.
`museArgv` builds the `exec` command from the plan or react phase.
`factoryEntry` runs `src/mcp/serve.ts` under bun with `--cwd=<checkout>` and `mcpServeArgs`
(the server's Bun config and the runtime boundary preload) and the coordinator caller. `exportArgv` builds the redacted `export` command. `readCoordCalls`
returns null for an absent log, otherwise the coordinator call-ends.

## Sessions and the run report

Each Muse session runs with only the `envPassthrough` names plus an
isolated `HOME` (`<runDir>/home`) and its XDG dirs. The API key travels
on stdin only, never in argv, env, files or logs. A timeout or abort
kills the whole process group with `SIGTERM`, then `SIGKILL` after
`killGraceMs`. A `SIGTERM`/`SIGKILL` failure other than `ESRCH` is
rethrown after the leader exits, before the export. After `exited`,
`timeout` or `aborted`, the launcher runs
the redacted `export`, except for an abort seen at the entry check, which runs no session and no export; an abort during setup kills the spawned session and still exports; the outcome is `exited`, `timeout`, `aborted` or
`spawn-failed` with its stage and code. The log carries `session-start`
(with the argv hash), `session-end` and `export` events, each starting
with an ISO timestamp. `buildReport` folds call-ends, gates, sessions
and the final `list_work` snapshot into `report.json`, and
`renderReportMd` renders the same data as `report.md`; neither file
holds the key or any env value. Exports are set to mode 600 once written. If the mode cannot be set, the export counts as failed with reason `mode`. `report-expected.md` pins the exact
render, so `.prettierignore` excludes it from formatting.

## Plan runs

`bun run coord --goal <goal> --phase plan|watch|full [--config <path>] [--dry-run]`
starts a run. Unknown arguments, repeated flags and missing values
exit 2, as do a bad checkout, a bad session record, a failed
precondition and lock contention. Startup checks run
before the body: args, checkout, config, key, goal with spec lookup, gate,
runs dir, then the coordinator lock and the record check. The daily cap
counts non-dry run dirs for today and exits 3 past `maxRunsPerDay`; the G1
`list_work` snapshot refuses ids with the goal prefix. The run dir holds
`home`, `workspace`, `mcp.json`, `prompt-1.md`, `coord.jsonl`,
`mcp-calls.jsonl`, `report.json`, `report.md` and session files. A dry run prints one JSON
line with `runDir`, `cwd`, `argv`, `phase` and `covers`, creating only
`home`, `mcp.json`, `prompt-1.md` and `workspace`. E0 step 1 runs the dry run. Stops are `plan-done`,
`no-submission`, `goal-terminal`, `deadline`, `max-sessions`, `session-failed`,
`factory-unreadable`, `budget-refused`, `muse-unavailable`, `tool-surface` and `signal`, with
exit 0 for `plan-done`, `signal`, `goal-terminal` and `deadline` and exit 3 for the failing stops; a
failed final snapshot turns 0 into 3. Stdout ends with
`coord: run <runId> stop=<stop> submitted=<n> items=<n|unknown>`
`followups=<n> report=<path>`. The `coordinator-session.json` record names
the run and group while the session runs; the next run refuses while the
group answers instead of killing it, since no portable proof of the old
group identity exists. The export group is not recorded. A lock release failure after the run exits 1; the empty `coordinator.lock` file stays by design, because the lock is a kernel `flock` on it.

## Tool surface

Every session runs with `--preset empty`, so it has exactly the seven
factory tools and no built-in. Before each session the keyless echo probe
runs `probeArgv` without `--api-key-stdin`, `--no-parallel-tool-calls`,
`--model`, `--reasoning-effort` and with `--provider echo`; it makes zero
Meta calls and writes `probe-<k>.jsonl`, `probe-<k>.stderr` and
`probe-<k>-export.json`. After the session the runner checks the
session's own export the same way. Both checks require `mode named`, the
exact tool set, every context source to be one of the six (`capability_policy`,
`meta_context_note`, `security_mode`, `session_identity`, `skills`,
`workspace_identity`), an
inactive delegation posture and an empty reminder roster. Each check
appends a `surface` event with `k`, `stage`, `ok`, `reason`, `extra` and
`missing`. A probe spawn failure stops the run with `muse-unavailable`
(reason `probe-spawn`), an abort stops `signal`, and any other failed
probe or session check stops the run with
`tool-surface` and exit 3. `runsDir` stays in the checkout because the
untrusted workspace skips `AGENTS.md`, and a `rules_file` source fails
the check.

## Watch rules

Scope keeps rows whose id starts with `<idPrefix>-`, in store order; an empty scope is
not terminal. A blocked scope row whose id is at most 45 characters, does not end
in `-fu`, has no `<id>-fu` sibling, has a pull, has some verdict for its pull with
high + medium > 0, and whose key `followup:<id>` is not consumed yields it; the cap
keeps the first `maxFollowupsPerRun - followupsFiled` by id. A review row under
`human-approval` with a clean verdict for its pull yields
`approve:<id>:<pull>:<headSha>` when that key is not consumed. Enough blocked rows
yield `pause:<goalId>` unless the fleet is paused, `pause_fleet` is pending, or the
key is consumed. Order is followups, then approves by key, then pause. Audit targets
are blocked rows that are not `-fu` rows and have no `-fu` sibling plus
`human-approval` review rows. The goal is terminal when every scope row is done,
blocked, operator-parked, or stranded. Bad `list_work`, `audit_results` and
`fleet_status` payloads report `invalid-list-work`, `invalid-audit-results` and
`invalid-fleet-status`.

## Watch runs

The seed wipes and reseeds `stateDir`, each refusal exiting 2: `coord: seed <key>
<path> is outside <stateDir>`, `coord: runsDir is inside seed stateDir`,
`coord: <stateDir> is not a coordinator demo dir`, and
`coord: seed storeSeedPath <path> is not valid JSON`. The G2 watch precondition
refuses `coord: no items with prefix <idPrefix>-`. Each poll checks the signal, then the deadline measured
from the run start, reads `list_work` + `fleet_status` + `audit_results`, decides,
runs one session when attention is non-empty, then sleeps `watch.pollMs`. The log carries `poll`, `poll-error {tool, code}` and
`attention`; `consumed` keys never repeat within a run. Stops are `plan-done`,
`signal`, `goal-terminal` and `deadline` (exit 0), plus `max-sessions`,
`session-failed` and `factory-unreadable` (exit 3). `full` runs plan then watch.

## Evidence and judge path

`bun run coord:evidence --run <runDir> --out <dir>` copies `report.md`,
`report.json`, `mcp-calls.jsonl` plus `prompt-<n>.md` and
`session-<n>-export.json` files. Paths redact the run's `<run>/home` to `<run-home>`, then cwd to `<checkout>`, then home to `~`. Each line is scanned against the config deny patterns plus the key
value; a hit exits 3 and keeps the out dir. The key pattern is anchored (`\bsk-`), so words such as `task-` do not hit. Bad args exit 2, a clean bundle
exits 0 and prints each out file. Encrypted reasoning in an export blob may
hit a pattern, and the scan is never weakened. The judge path runs
`bun install`, `bun run gates`, then
`bun run mcp:call submit_work --file tests/fixtures/coord/replay/d1-submit.json --config tests/fixtures/mcp/demo/mcp.json`,
which gives `sub-6b9641d69cb833e3` and then `replayed:true` on a second run.
The daily cost stays within at most `4 x (40 + 8 x 20) = 800` model steps;
measured E1 0.0045 USD and E2 0.0065 USD at the `meta-api` prices.

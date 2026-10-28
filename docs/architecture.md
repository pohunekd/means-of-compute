# Architecture

Means of Compute is a client of a session daemon that already runs on every host. It
adds the fleet layer: what to run, where, under which budget, and whether the result
is accepted.

Models: Muse Glimmer 30B (open weights, NVIDIA Build) is the main coder; Muse
Spark is fallback, planner and auditor. Every Muse Spark call uses
`muse-spark-1.3-contributor`; Muse Code runs with
`--model muse-spark-1.3-contributor --contributor-mode on`. Built by itself: see
README.

## Flow

1. The **loop runner** picks the next ready issue and drives the loop: place,
   run, audit, merge by rule, stall/retry, follow-ups, daily digest (#17). A goal reaches the
   **coordinator** (Muse Code on Muse Spark), which calls the
   **MCP server**: `submit_work` with a DAG of `WorkItem`s.
2. **Placement** reads each host's `HostCapacity` from its **host probe** and returns a
   `PlacementDecision` with the reason. A host is idle when it is inside the policy
   window, on AC power, its battery is above the configured threshold (or it has
   none), and either nobody is logged in or the last input is at least
   `idleMinutes` ago. Anything unreadable makes the host not idle with the cause.
   The probe ships to hosts as a compiled plugin package; see
   [host-state.md](host-state.md). The host-state collector asks each host for
   that package's output and validates it before placement sees it.
3. The **dispatcher** starts a session on the chosen host through `DispatcherPort`,
   watches it, and reschedules the item when the host leaves or the session is lost.
4. The **auditor** checks the resulting branch against the item's DoD and posts a
   verdict bound to the commit SHA.
5. The **ledger** stores a `UsageRecord` per item; the **Budget guard** reads it before
   every new model session; the **dashboard** shows fleet, work, usage, and savings.

## Auditor

`runAudit` in `src/auditor/audit.ts` is a read-only check of one revision
against a `WorkItem`'s DoD. The CLI takes the item only from
`--item <file>`, the revision from `--ref`, and the PR number from
`--pull`. It resolves the revision to a 40-character commit with
`git rev-parse --verify`. It reads the merge-base diff, and file contents
only at the locations the model cites. Every git call goes through an
allowlist; `--output`, `--ext-diff` and `--textconv` are refused before
any process starts. The author models come from the configured ledger
(`config/ledger.json`) with `--authors ledger`, or from `--author-model`
with `--authors flags`. The auditor is the first configured auditor model
that is not an author. An empty author set, or no eligible auditor,
refuses with exit 3. The budget gate runs before the model call; a refusal
is exit 3. It makes exactly one model call through `callProviderOnce`,
with no retry and no fallback. It appends one `kind: "audit"` pending
entry to the configured ledger before the reply is parsed, for a 200
response (tokens from the provider's usage, or `null` when absent or
unreadable) and for a timeout (`null` tokens). A connection failure
before any response, and a non-200 status, append nothing. The reply is
validated (schema,
cited file and line); an empty, invalid or out-of-tree reply is exit 4.
Counts are recomputed from the findings. The verdict is stored once at
`<verdictDir>/<item id>/<sha>.json` by temp file plus `link(2)`. An
existing verdict refuses with exit 3, unless `--post` is given: then the
stored verdict is posted with no model call, no budget gate and no ledger
entry, if it belongs to the same PR or has none. `--post` posts the
marker comment with `gh pr comment`, then checks that some comment on
that PR has the marker as its first line. A post failure is exit 4. Exit codes:
0 done; 2 input, config, unknown revision or data error; 3 refusal
(verdict exists, empty diff, no eligible auditor, budget); 4 model call,
reply or post failure.

## Placement

`place(item, hosts, running, config)` in `src/placement/place.ts` is a pure
function: no clock, no I/O. It reads idleness and the policy window from the
probe facts, counts items with `status: "running"` on each host alias for
the agent limit, and returns a `PlacementDecision` validated against its
contract before use. The fourth argument is
`config = { weights, batteryFloorPercent, minInputIdleSeconds }`.

Exclusions apply in order, each with its own reason: not idle (`excluded:
not idle (<idleReason>)`), not on AC power, battery at or below the floor
(`excluded: battery at <n> percent, at or below the <floor> percent floor`),
recent user input (`excluded: user input <n> seconds ago`),
outside the policy window, or at the agent limit
(`excluded: at agent limit (<n>/<max>)`). Battery, AC, input-recency, and
window exclusions repeat the probe rule on purpose, so placement never trusts
`idle` alone. `HostCapacity` does not say whether anyone is logged in, so a
host whose user logged out less than `minInputIdleSeconds` ago stays excluded
until that long has passed; that errs toward not placing, and it is
intended.
Eligible hosts score
`round4(w.cpu * cpuFree + w.memory * memFree + w.gpu * gpuFree)` with weights
from `config/placement.json` (validated at load: finite, 0..1, summing to 1;
`batteryFloorPercent` an integer 0..100; `minInputIdleSeconds` an integer of
at least 0; no other keys).
The winner has the highest score; ties break on lower `load1m / cores`, then on
alias order. When every host is excluded the decision carries
`chosenHostAlias: null`. The candidate reason names the winning facts:
`idle, on AC power, no battery` or `idle, on AC power, battery <n>%`, then
`CPU <p>% free, memory <q>% free`, then `, GPU` when one is present.
A host report with `memory.freeMb` above `memory.totalMb` is invalid input.
The `place` script (`src/placement/cli.ts`) reads
`--item`, `--hosts`, and `--running` through `src/fs/input.ts`, validates
them against contracts-v1, and exits 0 on a chosen host, 3 on no eligible
host, 2 on any input or config error.

## Boundaries

- `DispatcherPort` is the only seam to the session daemon. Its adapter uses
  `@pohunek/sdk`; no other module imports it.
- Contracts live under `contracts/` and are versioned by tag (`contracts-v1`).
- Providers, prices, caps, and host aliases are configuration in `config/`.

## Metering proxy

All model traffic from worker sessions flows through the metering proxy
(`src/meter/`). The proxy holds the provider keys: the session receives
its caller token through session metadata, and the token is valid only
while its grant is open. Provider keys never appear in the usage
log, the factory log, or error responses. See [meter.md](meter.md) for the proxy, the
config keys, the env vars, the usage-log format, and the operator secret
command.

Call authorization runs in the order A1 to A5: the bearer's MAC, the
grant exists, the grant is not closed, an unbound grant is admitted only
within `unboundGrantTtlMs` of its last open, and the source address is in
the host's list.

Only `model` is rewritten, to the grant's descriptor model. The caller
must send `model: sessionModelId`, and anything else gets 400
`model-mismatch`.

Error mapping: a connection failure gives 502, not billed; a missing
first byte gives 504, billed with null counts; idle and total timeouts
and broken or aborted streams after the headers error the caller's
stream, billed; non-2xx statuses pass through, not billed.

Drain abort: `closed-abort` is billed — with the seen counts, else null.

Join: one `PortUsage`, with one token per (provider, model), over the
replayed-plus-appended index. A `call-start` without an end counts as one
request with null counts.

`settle(sessionId, state)` finds the grant by session and delegates to `settleRequest(requestId)`, which owns one memoized `Promise<PortUsage | null>` per request id. After the close and the drain, the join is stable through replays and repeated calls. An unbound grant (opened, never bound) closes in `settleRequest`, so the
stranded billing of a lost session survives.

The dispatcher carries a required `lostUsage(requestId)` hook: the
first step of `finishLost`, before the first registry write, settles
the meter grant through this hook, which the factory wires to
`meter.settleRequest`. An invalid row is stored as `null`, never as a
fabricated zero, and the budget guard refuses unknown spend.

`createMeteredPort(inner, meter, log)` adapts a dispatcher port so
fleet sessions run behind the proxy: it opens the grant before the
inner start, binds it after, replaces the terminal port usage with the
metered join, and revokes the caller token through `grant-close`.

The component list and the rules behind these boundaries are in
[.agents/instructions/project.md](../.agents/instructions/project.md).

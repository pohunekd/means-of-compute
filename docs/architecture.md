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
   [host-state.md](host-state.md).
3. The **dispatcher** starts a session on the chosen host through `DispatcherPort`,
   watches it, and reschedules the item when the host leaves or the session is lost.
4. The **auditor** checks the resulting branch against the item's DoD and posts a
   verdict bound to the commit SHA.
5. The **ledger** stores a `UsageRecord` per item; the **Budget guard** reads it before
   every new model session; the **dashboard** shows fleet, work, usage, and savings.

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
(`src/meter/`). The proxy holds the provider keys: the host environment
carries only a short-lived caller token (`moc1.` + base64url grant id +
HMAC) from `meter.tokenFor(requestId)` — deterministic, and `openGrant`
mints nothing. Provider keys never appear in the usage log, the factory
log, or error responses. See [meter.md](meter.md) for the proxy, the
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

`settle` closes the grant, waits up to `drainTimeoutMs`, aborts the
rest, awaits every end, then joins.

The component list and the rules behind these boundaries are in
[.agents/instructions/project.md](../.agents/instructions/project.md).

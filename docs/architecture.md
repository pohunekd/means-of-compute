# Architecture

Means of Compute is a client of a session daemon that already runs on every host. It
adds the fleet layer: what to run, where, under which budget, and whether the result
is accepted.

Models: Muse Glimmer 30B (open weights, NVIDIA Build) is the main coder; Muse Spark is fallback, planner and auditor. Every Muse Spark call uses `muse-spark-1.3-contributor`; Muse Code runs with `--model muse-spark-1.3-contributor --contributor-mode on`. Built by itself: see README.

## Flow

1. The **loop runner** picks the next ready issue and drives the loop: place, run, audit, merge by rule, stall/retry, follow-ups. A goal reaches the **coordinator** (Muse Code on Muse Spark), which calls the
   **MCP server**: `submit_work` with a DAG of `WorkItem`s.
2. **Placement** reads each host's `HostCapacity` from its **host probe** and returns a
   `PlacementDecision` with the reason.
3. The **dispatcher** starts a session on the chosen host through `DispatcherPort`,
   watches it, and reschedules the item when the host leaves or the session is lost.
4. The **auditor** checks the resulting branch against the item's DoD and posts a
   verdict bound to the commit SHA.
5. The **ledger** stores a `UsageRecord` per item; the **Budget guard** reads it before
   every new model session; the **dashboard** shows fleet, work, usage, and savings.

## Boundaries

- `DispatcherPort` is the only seam to the session daemon. Its adapter uses
  `@pohunek/sdk`; no other module imports it.
- Contracts live under `contracts/` and are versioned by tag (`contracts-v1`).
- Providers, prices, caps, and host aliases are configuration in `config/`.

The component list and the rules behind these boundaries are in
[.agents/instructions/project.md](../.agents/instructions/project.md).

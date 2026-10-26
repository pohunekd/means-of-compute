# Project guide

## Product

Means of Compute is an autonomous software factory that runs agent work on hardware a company already owns. Laptops and desktops supply execution capacity (agent sessions, worktrees, builds, tests); inference comes from Meta models through the Meta Model API. Muse Glimmer 30B (open weights, NVIDIA Build) is the main coder; Muse Spark is the fallback, planner and auditor. Every Muse Spark call is the Contributor variant `muse-spark-1.3-contributor`; Muse Code always runs with `--model muse-spark-1.3-contributor --contributor-mode on`. The ledger records what every task used, and the dashboard compares it with what the same work would cost on rented cloud capacity.

## Components

| Component                  | Responsibility                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Contracts (`contracts-v1`) | JSON Schema and TypeScript types: `WorkItem`, `HostCapacity`, `PlacementDecision`, `UsageRecord`, `FactorySpec`                  |
| MCP server                 | the coordinator's interface: `submit_work`, `fleet_status`, `list_work`, `approve`, `audit_results`, `pause_fleet`               |
| Coordinator                | Muse Code on Muse Spark; turns a goal into a DAG of work items through the MCP server                                            |
| Loop runner                | picks next ready issue, places work, runs sessions, audits results, merges by rule, applies stall/retry policy, files follow-ups |
| Host probe                 | reports a host's idle state, power, CPU, memory, GPU, local models, and policy window                                            |
| Placement                  | scores hosts against capacity and policy; returns a `PlacementDecision` with its reason                                          |
| Dispatcher                 | starts, watches, and reschedules sessions through `DispatcherPort`                                                               |
| Auditor                    | read-only check of a branch against its issue's DoD; verdict bound to a commit SHA                                               |
| Ledger                     | one `UsageRecord` per task: tokens per provider, session time per host                                                           |
| Budget guard               | refuses new model sessions at the daily or total spend cap                                                                       |
| Dashboard                  | fleet, running work, usage, and savings, served from the ledger                                                                  |

## Boundaries

- **Pohunek is a dependency, not part of this repository.** Only the
  `DispatcherPort` adapter imports `@pohunek/sdk`; everything else depends on the
  port. Replacing the adapter must not touch other components.
- **Contracts are frozen at `contracts-v1`.** Components build against the schemas
  and their fixtures in parallel. A contract change is its own issue, approved
  before any dependent work.
- **Model providers are configuration.** A provider is an OpenAI-compatible
  endpoint described in `config/`; no component hard-codes a provider or model.
- **MCP tools are classed** as read, write, or sensitive write. `approve` and any
  merge need a human, or the deterministic merge policy in the workflow guide; the
  model never decides a merge on its own.
- **Hosts are displayed through aliases** from `config/`. Overlay names and
  addresses never reach the dashboard, logs, or committed files.
- **Scope.** Each issue states its scope boundary. Pre-1.0: no backward
  compatibility shims.

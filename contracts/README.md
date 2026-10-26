# Contracts v1

Versioned JSON Schemas plus matching TypeScript types for every cross-component
document. Schemas are the source of truth; `types.ts` mirrors their field names
and required sets, and `validate.ts` exports one type guard per schema for
runtime checks at every boundary. Frozen at the `contracts-v1` tag; a change is a
separate issue.

## Schemas

| Schema                           | Document                                                |
| -------------------------------- | ------------------------------------------------------- |
| `work-item.schema.json`          | One unit of agent work with DoD, DAG ids, routing state |
| `host-capacity.schema.json`      | One host probe report with idle state and policy window |
| `placement-decision.schema.json` | Chosen host alias with reason and candidate scores      |
| `usage-record.schema.json`       | Ledger entry per finished task: tokens, session time    |
| `audit-verdict.schema.json`      | Auditor verdict bound to the work item and head SHA     |
| `factory-spec.schema.json`       | Operator-owned per-repo factory configuration           |

Every schema uses JSON Schema draft 2020-12, carries `$id`, forbids unknown
fields (`additionalProperties: false`), and pins `"schemaVersion": "v1"` so a
later version can coexist under a new path.

## WorkItem state machine

`status` moves `queued -> running -> review -> done`. Side exits: `running` can
return to `queued` (a failed attempt increments `retryCount`), or move to
`parked` (stalled with no newly met DoD item for 3 rounds, or the host left, or
the user returned; work is kept on `branch`) or `blocked` (out of retries: at
most 2 retries, then blocked). Dependents start only when every dependency is
`done`. A failed attempt never produces a `failed` status; there is no producer
for it. `statusReason` is required and is non-null for `parked` and `blocked`.
`pullNumber` is null until a pull request exists.

`modelRouting.attempts` counts attempts on `preferredModel` and drives the
two-failure move to Spark; `retryCount` counts stall-policy retries (max 2) and
differs from it. `UsageRecord.attempts` also counts host-loss resumes, so it can
exceed both. Placement counts running items (`status: "running"` with
`assignedHostAlias` equal to the host) against `HostCapacity.policy`
`maxConcurrentAgents`; `HostCapacity` stays a pure host fact the probe reports
without seeing factory sessions.

Item ids are unique across the factory, not only within one DAG, so ledger
idempotency and branch names keyed on the id stay unambiguous.

## submit_work rules

`submit_work` accepts `WorkItem`s that carry loop state, so the MCP server owns
the initial values: on submission `status` must be `queued`; `statusReason`,
`assignedHostAlias`, `branch`, and `pullNumber` must be null; `retryCount`,
`stallRounds`, and `modelRouting.attempts` must be 0; `fallbackUsed` must be
false. The server rejects anything else; otherwise a caller could submit
`status: done` or pin a host and bypass placement and the merge rule.

## Conventions

- Hosts appear only through the alias map in `config/` (`desktop`, `laptop-a`,
  `laptop-b`, `laptop-mac`); aliases match `^[a-z][a-z0-9-]{0,31}$`, which rejects
  FQDNs and IP addresses. Host identifiers or addresses never appear in free-text
  fields (`idleReason`, `reason`, `statusReason`, finding texts).
- Absence is explicit, never a missing key: `batteryPercent: null` on desktops
  (machines without a battery), `gpu: { present: false, ...: null }` without a
  GPU, empty `models` when no local endpoint answers, `chosenHostAlias: null`
  when placement finds no host, null token counts when the endpoint reports no
  usage (a missing input shows as no data, never an estimated 0).
- `WorkItem.dependencies` holds sibling item ids; consumers check the DAG for
  cycles and unknown ids before queueing.
- `AuditVerdict.headSha` is exactly 40 lowercase hex chars; finding `location` is
  `path:line`. Consumers recompute `counts` from `findings` and reject a verdict
  whose counts disagree (the schema cannot express the sum). The merge rule is:
  `auditorModel` is not one of `authorModels`.
- `FactorySpec` is operator-owned configuration under `config/`, read by the loop
  runner; the coordinator never submits or changes it, and it carries no caps
  reference (caps are one account-wide config re-read before each admission).
- `HostCapacity.policy.insideWindow` is evaluated by the probe at `timestamp` in
  the host's local time; placement treats `false` as a hard exclusion without its
  own clock. In `allowedWindow`, `start > end` crosses midnight and
  `start == end` means all day.
- `UsageRecord.finishedAt` and `HostCapacity.timestamp` are UTC `date-time` with
  `Z`. Every number in a usage record carries its `source` (for example
  `provider-usage`, `dispatcher-clock`) so the dashboard can cite it.

## Fixtures and validation

Readable synthetic fixtures live in `fixtures/`. Validate all of them with:

```sh
bun run contracts:check
```

Validate one document from stdin (used by probe, placement, and ledger checks):

```sh
bun run contracts:check host-capacity - < contracts/v1/fixtures/host-capacity.json
```

One `ok` line is printed per document; any failure exits nonzero.

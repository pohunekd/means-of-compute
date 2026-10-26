# Contracts v1

Versioned JSON Schemas plus matching TypeScript types for every cross-component
document. Schemas are the source of truth; `types.ts` mirrors their field names
and required sets. Frozen at the `contracts-v1` tag; a change is a separate issue.

## Schemas

| Schema                           | Document                                                      |
| -------------------------------- | ------------------------------------------------------------- |
| `work-item.schema.json`          | One unit of agent work with DoD items, DAG ids, routing state |
| `host-capacity.schema.json`      | One host probe report with idle state and policy window       |
| `placement-decision.schema.json` | Chosen host alias with reason and candidate scores            |
| `usage-record.schema.json`       | Ledger entry per finished task: tokens, session time          |
| `audit-verdict.schema.json`      | Auditor verdict bound to the exact head SHA                   |
| `factory-spec.schema.json`       | Coordinator-submitted factory configuration                   |

Every schema uses JSON Schema draft 2020-12, carries `$id`, forbids unknown
fields (`additionalProperties: false`), and pins `"schemaVersion": "v1"` so a
later version can coexist under a new path.

## Conventions

- Hosts appear only as display aliases (`desktop`, `laptop-a`, `laptop-b`,
  `laptop-mac`); never hostnames or addresses.
- Absence is explicit, never a missing key: `batteryPercent: null` on desktops,
  `gpu: { present: false, ...: null }` without a GPU, empty `models` when no
  local endpoint answers, `chosenHostAlias: null` when placement finds no host.
- `WorkItem.dependencies` holds sibling item ids; consumers check the DAG for
  cycles before queueing.
- `AuditVerdict.headSha` is exactly 40 lowercase hex chars; `location` is
  `path:line`.
- `FactorySpec.mergeMode` is `by-rule` or `human-approval`; `capsRef` points at
  the caps file the budget guard reads.

## Fixtures and validation

Readable synthetic fixtures live in `fixtures/`. Validate all of them with:

```sh
bun run contracts:check
```

One `ok` line is printed per fixture; any failure exits nonzero with the
validator errors.

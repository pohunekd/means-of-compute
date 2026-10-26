// Validates every contracts/v1 fixture against its JSON Schema.
// Usage: bun run contracts:check
//        bun run contracts:check <schema-name> -   (reads one JSON document from stdin)
import {
  isAuditVerdict,
  isFactorySpec,
  isHostCapacity,
  isPlacementDecision,
  isUsageRecord,
  isWorkItem,
} from "../contracts/v1/validate.js";

const checks: readonly (readonly [name: string, paths: readonly string[]])[] = [
  [
    "work-item",
    ["contracts/v1/fixtures/work-item.json", "contracts/v1/fixtures/work-item-parked.json"],
  ],
  [
    "host-capacity",
    [
      "contracts/v1/fixtures/host-capacity.json",
      "contracts/v1/fixtures/host-capacity-busy.json",
      "contracts/v1/fixtures/host-capacity-low-battery.json",
    ],
  ],
  ["placement-decision", ["contracts/v1/fixtures/placement-decision.json"]],
  ["usage-record", ["contracts/v1/fixtures/usage-record.json"]],
  ["audit-verdict", ["contracts/v1/fixtures/audit-verdict.json"]],
  ["factory-spec", ["contracts/v1/fixtures/factory-spec.json"]],
];

const guards: Readonly<Record<string, (value: unknown) => boolean>> = {
  "work-item": isWorkItem,
  "host-capacity": isHostCapacity,
  "placement-decision": isPlacementDecision,
  "usage-record": isUsageRecord,
  "audit-verdict": isAuditVerdict,
  "factory-spec": isFactorySpec,
};

function check(name: string, label: string, value: unknown): boolean {
  const guard = guards[name];
  if (guard === undefined) {
    console.error(`Unknown schema: ${name}`);
    return false;
  }
  if (guard(value)) {
    console.log(`ok ${name} <- ${label}`);
    return true;
  }
  console.error(`FAIL ${name} <- ${label}`);
  return false;
}

const [schemaName, stdinMarker] = Bun.argv.slice(2);
let failed = 0;
if (schemaName !== undefined && stdinMarker === "-") {
  const text = await new Response(Bun.stdin.stream()).text();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    console.error(`FAIL ${schemaName} <- stdin (not JSON)`);
    process.exit(1);
  }
  if (!check(schemaName, "stdin", value)) {
    failed += 1;
  }
} else if (schemaName === undefined) {
  for (const [name, paths] of checks) {
    for (const path of paths) {
      const value: unknown = await Bun.file(path).json();
      if (!check(name, path, value)) {
        failed += 1;
      }
    }
  }
} else {
  console.error("Usage: bun run contracts:check [schema-name -]");
  process.exit(1);
}
if (failed > 0) {
  console.error(`${String(failed)} document(s) failed validation`);
  process.exit(1);
}

// Validates every contracts/v1 fixture against its JSON Schema.
// Usage: bun run contracts:check
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";

const pairs: readonly (readonly [schema: string, fixtures: readonly string[]])[] = [
  ["contracts/v1/work-item.schema.json", ["contracts/v1/fixtures/work-item.json"]],
  [
    "contracts/v1/host-capacity.schema.json",
    ["contracts/v1/fixtures/host-capacity.json", "contracts/v1/fixtures/host-capacity-busy.json"],
  ],
  [
    "contracts/v1/placement-decision.schema.json",
    ["contracts/v1/fixtures/placement-decision.json"],
  ],
  ["contracts/v1/usage-record.schema.json", ["contracts/v1/fixtures/usage-record.json"]],
  ["contracts/v1/audit-verdict.schema.json", ["contracts/v1/fixtures/audit-verdict.json"]],
  ["contracts/v1/factory-spec.schema.json", ["contracts/v1/fixtures/factory-spec.json"]],
];

const ajv = new Ajv({ strict: true });
addFormats(ajv);

let failed = 0;
for (const [schemaPath, fixturePaths] of pairs) {
  const schema: unknown = await Bun.file(schemaPath).json();
  const validate = ajv.compile(schema as Record<string, unknown>);
  for (const fixturePath of fixturePaths) {
    const fixture: unknown = await Bun.file(fixturePath).json();
    if (validate(fixture)) {
      console.log(`ok ${schemaPath} <- ${fixturePath}`);
    } else {
      failed += 1;
      console.error(`FAIL ${schemaPath} <- ${fixturePath}`);
      console.error(JSON.stringify(validate.errors, null, 2));
    }
  }
}
if (failed > 0) {
  console.error(`${String(failed)} fixture(s) failed validation`);
  process.exit(1);
}

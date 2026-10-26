import { test } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  contractErrors,
  isWorkItem,
  isHostCapacity,
  isPlacementDecision,
  isUsageRecord,
  isAuditVerdict,
  isFactorySpec,
} from "./v1/validate.js";
import type { SchemaName } from "./v1/validate.js";

function load(path: string): Promise<unknown> {
  return Bun.file(path).json();
}

async function assertValid(guard: (v: unknown) => boolean, path: string): Promise<void> {
  const data = await load(path);
  if (!guard(data)) {
    throw new Error(`Expected valid document: ${path}`);
  }
}

const schemaGuards: Record<SchemaName, (v: unknown) => boolean> = {
  "work-item": isWorkItem,
  "host-capacity": isHostCapacity,
  "placement-decision": isPlacementDecision,
  "usage-record": isUsageRecord,
  "audit-verdict": isAuditVerdict,
  "factory-spec": isFactorySpec,
};

test("work-item fixtures are valid", async () => {
  await assertValid(isWorkItem, "contracts/v1/fixtures/work-item.json");
  await assertValid(isWorkItem, "contracts/v1/fixtures/work-item-parked.json");
});

test("work-item invalid copy is rejected with required error", async () => {
  const data = await load("contracts/v1/fixtures/work-item.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).schemaVersion;
  if (isWorkItem(broken)) {
    throw new Error("work-item invalid copy should be rejected");
  }
  const errors = contractErrors("work-item", broken);
  if (!Array.isArray(errors) || errors.length === 0) {
    throw new Error("work-item invalid copy should have Ajv errors");
  }
  const hasRequired = (errors as Array<Record<string, unknown>>).some(
    (e) =>
      e.keyword === "required" &&
      (e.params as Record<string, unknown>).missingProperty === "schemaVersion",
  );
  if (!hasRequired) {
    throw new Error("work-item invalid copy should report missing schemaVersion");
  }
});

test("host-capacity fixtures are valid", async () => {
  await assertValid(isHostCapacity, "contracts/v1/fixtures/host-capacity.json");
  await assertValid(isHostCapacity, "contracts/v1/fixtures/host-capacity-busy.json");
  await assertValid(isHostCapacity, "contracts/v1/fixtures/host-capacity-low-battery.json");
});

test("host-capacity invalid copy is rejected with required error", async () => {
  const data = await load("contracts/v1/fixtures/host-capacity.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).hostAlias;
  if (isHostCapacity(broken)) {
    throw new Error("host-capacity invalid copy should be rejected");
  }
  const errors = contractErrors("host-capacity", broken);
  if (!Array.isArray(errors) || errors.length === 0) {
    throw new Error("host-capacity invalid copy should have Ajv errors");
  }
  const hasRequired = (errors as Array<Record<string, unknown>>).some(
    (e) =>
      e.keyword === "required" &&
      (e.params as Record<string, unknown>).missingProperty === "hostAlias",
  );
  if (!hasRequired) {
    throw new Error("host-capacity invalid copy should report missing hostAlias");
  }
});

test("placement-decision fixture is valid", async () => {
  await assertValid(isPlacementDecision, "contracts/v1/fixtures/placement-decision.json");
});

test("placement-decision invalid copy is rejected with required error", async () => {
  const data = await load("contracts/v1/fixtures/placement-decision.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).schemaVersion;
  if (isPlacementDecision(broken)) {
    throw new Error("placement-decision invalid copy should be rejected");
  }
  const errors = contractErrors("placement-decision", broken);
  if (!Array.isArray(errors) || errors.length === 0) {
    throw new Error("placement-decision invalid copy should have Ajv errors");
  }
  const hasRequired = (errors as Array<Record<string, unknown>>).some(
    (e) =>
      e.keyword === "required" &&
      (e.params as Record<string, unknown>).missingProperty === "schemaVersion",
  );
  if (!hasRequired) {
    throw new Error("placement-decision invalid copy should report missing schemaVersion");
  }
});

test("usage-record fixture is valid", async () => {
  await assertValid(isUsageRecord, "contracts/v1/fixtures/usage-record.json");
});

test("usage-record invalid copy is rejected with required error", async () => {
  const data = await load("contracts/v1/fixtures/usage-record.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).workItemId;
  if (isUsageRecord(broken)) {
    throw new Error("usage-record invalid copy should be rejected");
  }
  const errors = contractErrors("usage-record", broken);
  if (!Array.isArray(errors) || errors.length === 0) {
    throw new Error("usage-record invalid copy should have Ajv errors");
  }
  const hasRequired = (errors as Array<Record<string, unknown>>).some(
    (e) =>
      e.keyword === "required" &&
      (e.params as Record<string, unknown>).missingProperty === "workItemId",
  );
  if (!hasRequired) {
    throw new Error("usage-record invalid copy should report missing workItemId");
  }
});

test("audit-verdict fixture is valid", async () => {
  await assertValid(isAuditVerdict, "contracts/v1/fixtures/audit-verdict.json");
});

test("audit-verdict invalid copy is rejected with required error", async () => {
  const data = await load("contracts/v1/fixtures/audit-verdict.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).headSha;
  if (isAuditVerdict(broken)) {
    throw new Error("audit-verdict invalid copy should be rejected");
  }
  const errors = contractErrors("audit-verdict", broken);
  if (!Array.isArray(errors) || errors.length === 0) {
    throw new Error("audit-verdict invalid copy should have Ajv errors");
  }
  const hasRequired = (errors as Array<Record<string, unknown>>).some(
    (e) =>
      e.keyword === "required" &&
      (e.params as Record<string, unknown>).missingProperty === "headSha",
  );
  if (!hasRequired) {
    throw new Error("audit-verdict invalid copy should report missing headSha");
  }
});

test("factory-spec fixture is valid", async () => {
  await assertValid(isFactorySpec, "contracts/v1/fixtures/factory-spec.json");
});

test("factory-spec invalid copy is rejected with required error", async () => {
  const data = await load("contracts/v1/fixtures/factory-spec.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).mergeMode;
  if (isFactorySpec(broken)) {
    throw new Error("factory-spec invalid copy should be rejected");
  }
  const errors = contractErrors("factory-spec", broken);
  if (!Array.isArray(errors) || errors.length === 0) {
    throw new Error("factory-spec invalid copy should have Ajv errors");
  }
  const hasRequired = (errors as Array<Record<string, unknown>>).some(
    (e) =>
      e.keyword === "required" &&
      (e.params as Record<string, unknown>).missingProperty === "mergeMode",
  );
  if (!hasRequired) {
    throw new Error("factory-spec invalid copy should report missing mergeMode");
  }
});

test("fixtures/invalid are rejected with Ajv error path", async () => {
  const dir = "contracts/v1/fixtures/invalid";
  const files = await readdir(dir);
  const expectations: Record<string, { schema: SchemaName; instancePath: string }> = {
    "work-item-parked-no-reason.json": { schema: "work-item", instancePath: "/statusReason" },
  };
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const exp = expectations[file];
    if (!exp) {
      throw new Error(`No expectation defined for invalid fixture ${file}`);
    }
    const path = `${dir}/${file}`;
    const data = await load(path);
    const guard = schemaGuards[exp.schema];
    if (guard(data)) {
      throw new Error(`Invalid fixture should be rejected: ${path}`);
    }
    const errors = contractErrors(exp.schema, data);
    if (!Array.isArray(errors) || errors.length === 0) {
      throw new Error(`Invalid fixture should have Ajv errors: ${path}`);
    }
    const hasPath = (errors as Array<Record<string, unknown>>).some(
      (e) => (e.instancePath as string) === exp.instancePath,
    );
    if (!hasPath) {
      throw new Error(`Invalid fixture ${file} should have error at ${exp.instancePath}`);
    }
  }
});

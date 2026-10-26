import { test } from "bun:test";
import {
  isWorkItem,
  isHostCapacity,
  isPlacementDecision,
  isUsageRecord,
  isAuditVerdict,
  isFactorySpec,
} from "./v1/validate.js";

function load(path: string): Promise<unknown> {
  return Bun.file(path).json();
}

async function assertValid(guard: (v: unknown) => boolean, path: string): Promise<void> {
  const data = await load(path);
  if (!guard(data)) {
    throw new Error(`Expected valid document: ${path}`);
  }
}

async function assertInvalid(guard: (v: unknown) => boolean, path: string): Promise<void> {
  const data = await load(path);
  if (guard(data)) {
    throw new Error(`Expected invalid document to be rejected: ${path}`);
  }
}

test("work-item fixtures are valid", async () => {
  await assertValid(isWorkItem, "contracts/v1/fixtures/work-item.json");
  await assertValid(isWorkItem, "contracts/v1/fixtures/work-item-parked.json");
});

test("work-item invalid copy is rejected", async () => {
  const data = await load("contracts/v1/fixtures/work-item.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).schemaVersion;
  if (isWorkItem(broken)) {
    throw new Error("work-item invalid copy should be rejected");
  }
});

test("host-capacity fixtures are valid", async () => {
  await assertValid(isHostCapacity, "contracts/v1/fixtures/host-capacity.json");
  await assertValid(isHostCapacity, "contracts/v1/fixtures/host-capacity-busy.json");
  await assertValid(isHostCapacity, "contracts/v1/fixtures/host-capacity-low-battery.json");
});

test("host-capacity invalid copy is rejected", async () => {
  const data = await load("contracts/v1/fixtures/host-capacity.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).hostAlias;
  if (isHostCapacity(broken)) {
    throw new Error("host-capacity invalid copy should be rejected");
  }
});

test("placement-decision fixture is valid", async () => {
  await assertValid(isPlacementDecision, "contracts/v1/fixtures/placement-decision.json");
});

test("placement-decision invalid copy is rejected", async () => {
  const data = await load("contracts/v1/fixtures/placement-decision.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).schemaVersion;
  if (isPlacementDecision(broken)) {
    throw new Error("placement-decision invalid copy should be rejected");
  }
});

test("usage-record fixture is valid", async () => {
  await assertValid(isUsageRecord, "contracts/v1/fixtures/usage-record.json");
});

test("usage-record invalid copy is rejected", async () => {
  const data = await load("contracts/v1/fixtures/usage-record.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).workItemId;
  if (isUsageRecord(broken)) {
    throw new Error("usage-record invalid copy should be rejected");
  }
});

test("audit-verdict fixture is valid", async () => {
  await assertValid(isAuditVerdict, "contracts/v1/fixtures/audit-verdict.json");
});

test("audit-verdict invalid copy is rejected", async () => {
  const data = await load("contracts/v1/fixtures/audit-verdict.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).headSha;
  if (isAuditVerdict(broken)) {
    throw new Error("audit-verdict invalid copy should be rejected");
  }
});

test("factory-spec fixture is valid", async () => {
  await assertValid(isFactorySpec, "contracts/v1/fixtures/factory-spec.json");
});

test("factory-spec invalid copy is rejected", async () => {
  const data = await load("contracts/v1/fixtures/factory-spec.json");
  const broken = JSON.parse(JSON.stringify(data)) as unknown;
  delete (broken as Record<string, unknown>).mergeMode;
  if (isFactorySpec(broken)) {
    throw new Error("factory-spec invalid copy should be rejected");
  }
});

test("fixtures/invalid are rejected", async () => {
  await assertInvalid(isWorkItem, "contracts/v1/fixtures/invalid/work-item-parked-no-reason.json");
});

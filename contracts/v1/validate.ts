// Shared runtime validators for contracts/v1. One type guard per schema,
// all compiled from a single Ajv 2020 instance with formats enabled.
// Boundary code (MCP server, probe collectors, ledger readers) validates
// untrusted input through these guards before use.
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type {
  AuditVerdict,
  FactorySpec,
  HostCapacity,
  PlacementDecision,
  UsageRecord,
  WorkItem,
} from "./types.js";
import auditVerdictSchema from "./audit-verdict.schema.json" with { type: "json" };
import factorySpecSchema from "./factory-spec.schema.json" with { type: "json" };
import hostCapacitySchema from "./host-capacity.schema.json" with { type: "json" };
import placementDecisionSchema from "./placement-decision.schema.json" with { type: "json" };
import usageRecordSchema from "./usage-record.schema.json" with { type: "json" };
import workItemSchema from "./work-item.schema.json" with { type: "json" };

const ajv = new Ajv({ strict: true });
addFormats(ajv);

const validateWorkItem = ajv.compile(workItemSchema);
const validateHostCapacity = ajv.compile(hostCapacitySchema);
const validatePlacementDecision = ajv.compile(placementDecisionSchema);
const validateUsageRecord = ajv.compile(usageRecordSchema);
const validateAuditVerdict = ajv.compile(auditVerdictSchema);
const validateFactorySpec = ajv.compile(factorySpecSchema);

export function isWorkItem(value: unknown): value is WorkItem {
  return validateWorkItem(value);
}

export function isHostCapacity(value: unknown): value is HostCapacity {
  return validateHostCapacity(value);
}

export function isPlacementDecision(value: unknown): value is PlacementDecision {
  return validatePlacementDecision(value);
}

export function isUsageRecord(value: unknown): value is UsageRecord {
  return validateUsageRecord(value);
}

export function isAuditVerdict(value: unknown): value is AuditVerdict {
  return validateAuditVerdict(value);
}

export function isFactorySpec(value: unknown): value is FactorySpec {
  return validateFactorySpec(value);
}

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

const validators = {
  "work-item": ajv.compile(workItemSchema),
  "host-capacity": ajv.compile(hostCapacitySchema),
  "placement-decision": ajv.compile(placementDecisionSchema),
  "usage-record": ajv.compile<UsageRecord>(usageRecordSchema),
  "audit-verdict": ajv.compile(auditVerdictSchema),
  "factory-spec": ajv.compile(factorySpecSchema),
} as const;

export type SchemaName = keyof typeof validators;

export function isSchemaName(value: string): value is SchemaName {
  return Object.hasOwn(validators, value);
}

const validateWorkItem = validators["work-item"];
const validateHostCapacity = validators["host-capacity"];
const validatePlacementDecision = validators["placement-decision"];
const validateUsageRecord = validators["usage-record"];
const validateAuditVerdict = validators["audit-verdict"];
const validateFactorySpec = validators["factory-spec"];

// JSON Schema cannot compare two fields of one object, so the bound
// cachedInputTokens <= inputTokens is checked here, in the Ajv error shape.
function cachedInputErrors(record: UsageRecord): readonly Record<string, unknown>[] | null {
  const errors = record.tokens.flatMap((token, index) =>
    token.cachedInputTokens !== undefined &&
    token.inputTokens !== null &&
    token.cachedInputTokens > token.inputTokens
      ? [
          {
            instancePath: `/tokens/${String(index)}/cachedInputTokens`,
            keyword: "maximum",
            params: { comparison: "<=", limit: token.inputTokens },
            message: "must be <= inputTokens",
          },
        ]
      : [],
  );
  return errors.length === 0 ? null : errors;
}

export function contractErrors(schemaName: SchemaName, value: unknown): unknown {
  if (!Object.hasOwn(validators, schemaName)) {
    throw new Error(`Unknown schema: ${schemaName}`);
  }
  if (schemaName === "usage-record") {
    return validateUsageRecord(value) ? cachedInputErrors(value) : validateUsageRecord.errors;
  }
  validators[schemaName](value);
  return validators[schemaName].errors;
}

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
  return validateUsageRecord(value) && cachedInputErrors(value) === null;
}

export function isAuditVerdict(value: unknown): value is AuditVerdict {
  return validateAuditVerdict(value);
}

export function isFactorySpec(value: unknown): value is FactorySpec {
  return validateFactorySpec(value);
}

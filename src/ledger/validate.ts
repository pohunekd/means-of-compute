// Pending usage validator, compiled once at module load. The schema check
// runs first; the two source predicates then reject a session entry that
// carries auditor tokens and an audit entry with non-auditor tokens.
import Ajv from "ajv/dist/2020";
import type { PendingUsage } from "./types.js";
import { AUDITOR_USAGE_SOURCE } from "./types.js";
import pendingUsageSchema from "./pending.schema.json" with { type: "json" };

const ajv = new Ajv({ strict: true });

const validatePendingUsage = ajv.compile(pendingUsageSchema);

export function pendingErrors(value: unknown): unknown {
  validatePendingUsage(value);
  return validatePendingUsage.errors;
}

export function pendingReason(value: unknown): string {
  validatePendingUsage(value);
  const schemaErrors = validatePendingUsage.errors;
  if (schemaErrors !== null && schemaErrors !== undefined) {
    return JSON.stringify(schemaErrors);
  }
  const predicate = sourcePredicateError(value as PendingUsage);
  if (predicate !== null) {
    return predicate;
  }
  const entry = value as { finishedAt?: unknown };
  if (typeof entry.finishedAt !== "string" || new Date(entry.finishedAt).toISOString() !== entry.finishedAt) {
    return `finishedAt is not canonical: ${JSON.stringify(entry.finishedAt)}`;
  }
  return "invalid pending entry";
}

function sourcePredicateError(value: PendingUsage): string | null {
  if (value.kind === "session") {
    if (value.tokens.some((entry) => entry.source === AUDITOR_USAGE_SOURCE)) {
      return "session entry must not carry auditor-usage tokens";
    }
    return null;
  }
  if (value.tokens.some((entry) => entry.source !== AUDITOR_USAGE_SOURCE)) {
    return "audit entry must only carry auditor-usage tokens";
  }
  return null;
}

export function isPendingUsage(value: unknown): value is PendingUsage {
  if (!validatePendingUsage(value)) {
    return false;
  }
  const entry = value as unknown as PendingUsage;
  if (sourcePredicateError(entry) !== null) {
    return false;
  }
  if (Number.isNaN(Date.parse(entry.finishedAt))) {
    return false;
  }
  return new Date(entry.finishedAt).toISOString() === entry.finishedAt;
}

// Ledger type mirrors for design section 1 item 3. PendingTokenUsage and
// PendingSession describe unfinalized usage; the JSON Schema stays the
// source of truth and these types match it field for field.
import type {
  AttemptResult,
  TokenUsage,
  UsageRecord,
  UsageResult,
} from "../../contracts/v1/types.js";

export type PendingKind = "session" | "audit";

// requests is null only when the usage source reported nothing at all.
export interface PendingTokenUsage extends Omit<TokenUsage, "requests"> {
  readonly requests: number | null;
  readonly unmeasuredRequests?: number;
}

export interface PendingSession {
  readonly hostAlias: string; // ^[a-z][a-z0-9-]{0,31}$
  readonly seconds: number; // integer >= 0
  readonly source: "dispatcher-clock";
  readonly result: AttemptResult;
}

export interface PendingUsage {
  readonly entryId: string; // unique in the file; minLength 1, maxLength 200
  readonly kind: PendingKind;
  readonly workItemId: string; // ^[a-z0-9][a-z0-9-]{0,62}$
  readonly finishedAt: string; // exactly Date.prototype.toISOString() form
  readonly startModel: string; // model the session was started with, or the auditor model
  readonly tokens: readonly PendingTokenUsage[]; // minItems 1
  readonly session: PendingSession | null; // non-null iff kind === "session"
}

export interface LedgerContents {
  readonly records: readonly UsageRecord[];
  readonly pending: readonly PendingUsage[];
}

export interface FinalizeInput {
  readonly workItemId: string;
  readonly result: UsageResult;
  readonly retries: number; // WorkItem.retryCount at the transition (cumulative)
  readonly humanInterventions: number; // cumulative counter owned by the loop runner (#17)
}

export type WriteOutcome = "appended" | "updated" | "unchanged";

export interface SpendTokens {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly requests: number | null;
  readonly source: string;
  readonly unmeasuredRequests?: number;
}

export interface SpendEntry {
  readonly workItemId: string;
  readonly finishedAt: string;
  readonly tokens: readonly SpendTokens[];
}

export const AUDITOR_USAGE_SOURCE = "auditor-usage";

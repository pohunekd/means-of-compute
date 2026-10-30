// TypeScript mirrors of contracts/v1 JSON Schemas. Field names and required
// sets match the schemas exactly; the schemas stay the source of truth.

export const CONTRACTS_VERSION = "v1" as const;

export type WorkItemStatus = "queued" | "running" | "review" | "parked" | "blocked" | "done";

export interface WorkItemDod {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
}

export interface ModelRouting {
  readonly preferredModel: string;
  readonly attempts: number;
  readonly fallbackUsed: boolean;
}

export interface WorkItem {
  readonly schemaVersion: "v1";
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly goal: string;
  readonly issue: number | null;
  readonly dod: readonly WorkItemDod[];
  readonly dependencies: readonly string[];
  readonly status: WorkItemStatus;
  // Non-null for parked and blocked (schema if/then); TS cannot express it cleanly.
  readonly statusReason: string | null;
  readonly assignedHostAlias: string | null;
  readonly branch: string | null;
  readonly pullNumber: number | null;
  readonly modelRouting: ModelRouting;
  readonly retryCount: number;
  readonly stallRounds: number;
}

export interface CpuInfo {
  readonly cores: number;
  readonly load1m: number;
}

export interface MemoryInfo {
  readonly totalMb: number;
  readonly freeMb: number;
}

export interface GpuInfo {
  readonly present: boolean;
  readonly name: string | null;
  readonly freeMb: number | null;
}

export interface LocalModels {
  readonly reachable: boolean;
  readonly models: readonly string[];
}

export interface PolicyWindow {
  readonly start: string;
  readonly end: string;
}

export interface HostPolicy {
  readonly allowedWindow: PolicyWindow;
  readonly insideWindow: boolean;
  readonly maxConcurrentAgents: number;
}

export interface HostCapacity {
  readonly schemaVersion: "v1";
  readonly hostAlias: string;
  readonly timestamp: string;
  readonly idle: boolean;
  readonly idleReason: string;
  readonly secondsSinceInput: number;
  readonly acPower: boolean;
  readonly batteryPercent: number | null;
  readonly cpu: CpuInfo;
  readonly memory: MemoryInfo;
  readonly gpu: GpuInfo;
  readonly localModels: LocalModels;
  readonly policy: HostPolicy;
}

export interface PlacementCandidate {
  readonly hostAlias: string;
  readonly score: number;
  readonly reason: string;
  readonly excluded: boolean;
}

export interface PlacementDecision {
  readonly schemaVersion: "v1";
  readonly workItemId: string;
  readonly chosenHostAlias: string | null;
  readonly reason: string;
  readonly candidates: readonly PlacementCandidate[];
}

export interface TokenUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly requests: number;
  readonly source: string;
  // Billed calls that reported no usage; when present, inputTokens and
  // outputTokens are the sums of the other calls and are never null.
  readonly unmeasuredRequests?: number;
}

export interface SessionTime {
  readonly hostAlias: string;
  readonly seconds: number;
  readonly source: string;
}

export type AttemptResult = "success" | "failure" | "stalled" | "lost";

export interface ModelAttempt {
  readonly model: string;
  readonly result: AttemptResult;
}

export type UsageResult = "success" | "blocked";

export interface UsageRecord {
  readonly schemaVersion: "v1";
  readonly workItemId: string;
  readonly finishedAt: string;
  readonly tokens: readonly TokenUsage[];
  readonly sessionSeconds: readonly SessionTime[];
  readonly attempts: readonly ModelAttempt[];
  readonly retries: number;
  readonly humanInterventions: number;
  readonly result: UsageResult;
}

export type FindingSeverity = "high" | "medium" | "low";

export interface AuditFinding {
  readonly severity: FindingSeverity;
  readonly location: string;
  readonly defect: string;
  readonly scenario: string;
  readonly fixDirection: string;
}

export interface AuditCounts {
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

export interface AuditVerdict {
  readonly schemaVersion: "v1";
  readonly repo: string;
  readonly workItemId: string;
  readonly pullNumber: number | null;
  readonly headSha: string;
  readonly authorModels: readonly string[];
  readonly auditorModel: string;
  readonly counts: AuditCounts;
  readonly findings: readonly AuditFinding[];
}

export type MergeMode = "by-rule" | "human-approval";

export interface FactorySpec {
  readonly schemaVersion: "v1";
  readonly repo: string;
  readonly mergeMode: MergeMode;
}

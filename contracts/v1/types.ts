// TypeScript mirrors of contracts/v1 JSON Schemas. Field names and required
// sets match the schemas exactly; the schemas stay the source of truth.

export const CONTRACTS_VERSION = "v1" as const;

export type WorkItemStatus = "queued" | "running" | "done" | "failed" | "parked" | "blocked";

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
  readonly title: string;
  readonly goal: string;
  readonly issue: number | null;
  readonly dod: readonly WorkItemDod[];
  readonly dependencies: readonly string[];
  readonly status: WorkItemStatus;
  readonly assignedHostAlias: string | null;
  readonly branch: string | null;
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
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SessionTime {
  readonly hostAlias: string;
  readonly seconds: number;
}

export type UsageResult = "success" | "failure" | "blocked";

export interface UsageRecord {
  readonly schemaVersion: "v1";
  readonly workItemId: string;
  readonly tokens: readonly TokenUsage[];
  readonly sessionSeconds: readonly SessionTime[];
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
  readonly pullNumber: number;
  readonly headSha: string;
  readonly authorModel: string;
  readonly auditorModel: string;
  readonly counts: AuditCounts;
  readonly findings: readonly AuditFinding[];
}

export type MergeMode = "by-rule" | "human-approval";

export interface FactorySpec {
  readonly schemaVersion: "v1";
  readonly repo: string;
  readonly capsRef: string;
  readonly mergeMode: MergeMode;
}

// Shared loop-runner record shapes. These mirror src/loop/state.schema.json
// without the validation logic: the schema stays the source of truth.
export type RoundOutcome =
  | "merged"
  | "findings"
  | "red-ci"
  | "no-push"
  | "no-new-commit"
  | "empty-diff"
  | "diff-too-large"
  | "session-failed"
  | "ci-timeout"
  | "trial-failed"
  | "lost"
  | "start-rejected";

export type RoundAttempt = "success" | "failure" | "stalled" | "lost";

export type RoutingResult = "success" | "failure" | "excluded";

export type LoopPhase =
  | "idle"
  | "starting"
  | "running"
  | "publishing"
  | "ci"
  | "auditing"
  | "merging"
  | "awaiting-approval"
  | "finalizing"
  | "final";

export interface RoundVerdict {
  readonly auditorModel: string;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

export interface RoundRecord {
  readonly round: number;
  readonly retry: number;
  readonly requestId: string | null;
  readonly model: string;
  readonly providerId: string;
  readonly hostAlias: string | null;
  readonly attempt: RoundAttempt;
  readonly outcome: RoundOutcome;
  readonly headSha: string | null;
  readonly failingChecks: readonly string[];
  readonly verdict: RoundVerdict | null;
  readonly newlyMet: readonly string[];
  readonly at: string;
  readonly baseRace: boolean;
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

export interface StartModel {
  readonly providerId: string;
  readonly model: string;
}

export interface StartIntent {
  readonly round: number;
  readonly decision: PlacementDecision;
  readonly model: StartModel;
  readonly brief: string;
  readonly itemBranch: string | null;
  readonly requestId: string;
}

export type EscalationTarget = { readonly issue: number } | { readonly newIssue: true };

export interface Escalation {
  readonly key: string;
  readonly retry: number;
  readonly target: EscalationTarget;
  readonly posted: number | null;
}

export type FollowupKind = "finding" | "blocked";

export interface Followup {
  readonly key: string;
  readonly kind: FollowupKind;
  readonly posted: number | null;
}

export type FinalizeResult = "success" | "blocked";

export interface Finalize {
  readonly result: FinalizeResult;
  readonly done: boolean;
}

export interface AttemptCount {
  readonly headSha: string;
  readonly count: number;
}

export interface LoopPull {
  readonly number: number;
  readonly headSha: string;
}

export interface LoopTrial {
  readonly baseSha: string;
  readonly headSha: string;
  readonly passed: boolean;
}

export interface LoopItem {
  readonly phase: LoopPhase;
  readonly round: number;
  readonly start: StartIntent | null;
  readonly requestId: string | null;
  readonly pull: LoopPull | null;
  readonly ciSince: string | null;
  readonly trial: LoopTrial | null;
  readonly rounds: readonly RoundRecord[];
  readonly failures: Readonly<Record<string, number>>;
  readonly excludedHosts: readonly string[];
  readonly startRejections: number;
  readonly escalations: readonly Escalation[];
  readonly followups: readonly Followup[];
  readonly humanInterventions: number;
  readonly finalize: Finalize | null;
  readonly auditAttempts: AttemptCount | null;
  readonly mergeAttempts: AttemptCount | null;
  readonly backoffUntil: string | null;
}

export interface MergeHold {
  readonly mergeSha: string;
  readonly workItemId: string;
  readonly expectedBase: string;
  readonly parents: readonly string[];
  readonly since: string;
}

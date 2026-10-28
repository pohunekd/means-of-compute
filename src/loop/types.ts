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
  readonly verdict: {
    readonly auditorModel: string;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
  } | null;
  readonly newlyMet: readonly string[];
  readonly at: string;
  readonly baseRace: boolean;
}

export interface StartIntent {
  readonly round: number;
  readonly decision: {
    readonly schemaVersion: "v1";
    readonly workItemId: string;
    readonly chosenHostAlias: string | null;
    readonly reason: string;
    readonly candidates: readonly {
      readonly hostAlias: string;
      readonly score: number;
      readonly reason: string;
      readonly excluded: boolean;
    }[];
  };
  readonly model: {
    readonly providerId: string;
    readonly model: string;
  };
  readonly brief: string;
  readonly itemBranch: string | null;
  readonly requestId: string;
}

export interface Escalation {
  readonly key: string;
  readonly retry: number;
  readonly target: { readonly issue: number } | { readonly newIssue: true };
  readonly posted: number | null;
}

export interface Followup {
  readonly key: string;
  readonly kind: "finding" | "blocked";
  readonly posted: number | null;
}

export interface Finalize {
  readonly result: "success" | "blocked";
  readonly done: boolean;
}

export interface AttemptCount {
  readonly headSha: string;
  readonly count: number;
}

export interface LoopItem {
  readonly phase:
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
  readonly round: number;
  readonly retry: number;
  readonly park: {
    readonly kind: "stall" | "lost" | "operator" | "blocked";
    readonly reason: string;
    readonly code: string | null;
  } | null;
  readonly session: {
    readonly hostAlias: string;
    readonly providerId: string;
    readonly model: string;
  } | null;
  readonly fallbackUsed: boolean;
  readonly start: StartIntent | null;
  readonly requestId: string | null;
  readonly pull: {
    readonly number: number;
    readonly headSha: string;
  } | null;
  readonly ciSince: string | null;
  readonly trial: {
    readonly baseSha: string;
    readonly headSha: string;
    readonly passed: boolean;
  } | null;
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

// Pure stall and model-routing policy for the loop runner. No I/O and no
// clock: every limit arrives through the arguments from LoopConfig.
import type { WorkItem } from "../../contracts/v1/types.js";
import type { LoopRoutingConfig, LoopStallConfig } from "./config.js";
import type { ResultLine } from "./results.js";
import type { LoopItem, RoundOutcome, RoundRecord, RoutingResult } from "./types.js";

export const OUTCOME_CLASSES: Readonly<
  Record<RoundOutcome, { readonly stagnant: boolean; readonly routing: RoutingResult }>
> = {
  merged: { stagnant: false, routing: "success" },
  findings: { stagnant: true, routing: "failure" },
  "red-ci": { stagnant: true, routing: "failure" },
  "no-push": { stagnant: true, routing: "failure" },
  "no-new-commit": { stagnant: true, routing: "failure" },
  "empty-diff": { stagnant: true, routing: "failure" },
  "diff-too-large": { stagnant: true, routing: "failure" },
  "session-failed": { stagnant: true, routing: "failure" },
  "ci-timeout": { stagnant: true, routing: "excluded" },
  "trial-failed": { stagnant: true, routing: "excluded" },
  lost: { stagnant: false, routing: "excluded" },
  "start-rejected": { stagnant: false, routing: "excluded" },
};

export type StallDecision =
  | { readonly kind: "continue"; readonly stallRounds: number }
  | {
      readonly kind: "park";
      readonly then: "retry";
      readonly stallRounds: number;
      readonly escalationKey: string;
      readonly statusReason: string;
    }
  | {
      readonly kind: "park";
      readonly then: "block";
      readonly stallRounds: number;
      readonly escalationKey: string;
      readonly statusReason: string;
      readonly blockedReason: string;
    };

export interface ModelSteering {
  readonly successes: number;
  readonly samples: number;
}

export interface ModelChoice {
  readonly model: string;
  readonly providerId: string;
  readonly fallbackUsed: boolean;
  readonly steered: ModelSteering | null;
}

export class LoopPolicyError extends Error {
  readonly code: "fallback-missing" | "model-not-routed";
  constructor(code: "fallback-missing" | "model-not-routed", options?: ErrorOptions) {
    super(code, options);
    this.name = "LoopPolicyError";
    this.code = code;
  }
}

// The DoD ids a merged round meets; any other outcome meets none.
export function metDod(item: WorkItem, outcome: RoundOutcome): readonly string[] {
  if (outcome !== "merged") {
    return [];
  }
  return item.dod.map((entry) => entry.id);
}

// The met ids minus every id an earlier round already met, in DoD order.
export function newlyMetOf(
  item: WorkItem,
  previous: readonly RoundRecord[],
  outcome: RoundOutcome,
): readonly string[] {
  const met = metDod(item, outcome);
  if (met.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  for (const record of previous) {
    for (const id of record.newlyMet) {
      seen.add(id);
    }
  }
  return met.filter((id) => !seen.has(id));
}

// Stagnant rounds on one retry; excluded rounds neither count nor reset.
export function stallRoundsOf(rounds: readonly RoundRecord[], retry: number): number {
  let count = 0;
  for (const record of rounds) {
    if (record.retry === retry && OUTCOME_CLASSES[record.outcome].stagnant) {
      count += 1;
    }
  }
  return count;
}

export function stallDecision(
  id: string,
  retry: number,
  rounds: readonly RoundRecord[],
  stall: LoopStallConfig,
): StallDecision {
  const stallRounds = stallRoundsOf(rounds, retry);
  if (stallRounds < stall.maxStagnantRounds) {
    return { kind: "continue", stallRounds };
  }
  if (retry < stall.maxRetries) {
    return {
      kind: "park",
      then: "retry",
      stallRounds,
      escalationKey: `stall:${id}:${String(retry)}`,
      statusReason: `stalled: ${String(stall.maxStagnantRounds)} rounds without a newly met DoD item`,
    };
  }
  return {
    kind: "park",
    then: "block",
    stallRounds,
    escalationKey: `stall:${id}:${String(retry)}`,
    statusReason: `stalled: ${String(stall.maxStagnantRounds)} rounds without a newly met DoD item`,
    blockedReason: `blocked: ${String(stall.maxRetries)} retries used`,
  };
}

// A copy of the failure counts with the record's model raised when its
// routing is a failure.
export function failuresAfter(
  failures: Readonly<Record<string, number>>,
  record: RoundRecord,
): Readonly<Record<string, number>> {
  const next: Record<string, number> = { ...failures };
  if (OUTCOME_CLASSES[record.outcome].routing === "failure") {
    next[record.model] = (next[record.model] ?? 0) + 1;
  }
  return next;
}

function providerOf(routing: LoopRoutingConfig, model: string): string {
  const providerId = routing.models[model];
  if (providerId === undefined) {
    throw new LoopPolicyError("model-not-routed");
  }
  return providerId;
}

// Rule F: stay on the preferred model unless a fallback already applies,
// failures force it, or the result record steers away from it.
export function chooseModel(
  item: WorkItem,
  loopItem: Pick<LoopItem, "failures" | "rounds">,
  results: readonly ResultLine[],
  routing: LoopRoutingConfig,
): ModelChoice {
  const preferred = item.modelRouting.preferredModel;
  const fallback = routing.fallback[preferred];
  if (item.modelRouting.fallbackUsed) {
    if (fallback === undefined) {
      throw new LoopPolicyError("fallback-missing");
    }
    return {
      model: fallback,
      providerId: providerOf(routing, fallback),
      fallbackUsed: true,
      steered: null,
    };
  }
  if (
    fallback !== undefined &&
    (loopItem.failures[preferred] ?? 0) >= routing.fallbackAfterFailures
  ) {
    return {
      model: fallback,
      providerId: providerOf(routing, fallback),
      fallbackUsed: true,
      steered: null,
    };
  }
  if (fallback !== undefined && loopItem.rounds.every((record) => record.model !== preferred)) {
    const lines = results
      .filter((line) => line.model === preferred && line.routingResult !== "excluded")
      .slice(-routing.window);
    const samples = lines.length;
    const successes = lines.filter((line) => line.routingResult === "success").length;
    if (samples >= routing.minSamples && successes / samples < routing.minSuccessRate) {
      return {
        model: fallback,
        providerId: providerOf(routing, fallback),
        fallbackUsed: true,
        steered: { successes, samples },
      };
    }
  }
  return {
    model: preferred,
    providerId: providerOf(routing, preferred),
    fallbackUsed: false,
    steered: null,
  };
}

// Rounds on the preferred model plus the started one when it matches.
export function attemptsOnPreferred(
  item: WorkItem,
  rounds: readonly RoundRecord[],
  startedModel: string | null,
): number {
  const preferred = item.modelRouting.preferredModel;
  let count = 0;
  for (const record of rounds) {
    if (record.model === preferred) {
      count += 1;
    }
  }
  if (startedModel === preferred) {
    count += 1;
  }
  return count;
}

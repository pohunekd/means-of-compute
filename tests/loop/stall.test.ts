// Stall policy tests (matrix rows L6-L8d): stall decisions over synthetic
// round records. Outcomes come from the design table O2, never from policy.ts.
import { expect, test } from "bun:test";
import type { LoopStallConfig } from "../../src/loop/config.js";
import { stallDecision } from "../../src/loop/policy.js";
import type { RoundOutcome, RoundRecord } from "../../src/loop/types.js";

const STALL: LoopStallConfig = { maxStagnantRounds: 3, maxRetries: 2 };

function record(outcome: RoundOutcome, retry: number, extra?: string): RoundRecord {
  return {
    round: 0,
    retry,
    requestId: `req-${outcome}-${String(retry)}${extra ?? ""}`,
    model: "meta/muse-glimmer-30b",
    providerId: "nvidia-build",
    hostAlias: "host-a",
    attempt: "failure",
    outcome,
    headSha: null,
    failingChecks: [],
    verdict: null,
    newlyMet: [],
    at: "2026-10-28T00:00:00.000Z",
    baseRace: false,
  };
}

test("three stagnant rounds park with retry and the stall escalation (L6, O4)", () => {
  const rounds = [record("red-ci", 0), record("findings", 0), record("no-push", 0)];
  const decision = stallDecision("demo-a", 0, rounds, STALL);
  expect(decision).toEqual({
    kind: "park",
    then: "retry",
    stallRounds: 3,
    escalationKey: "stall:demo-a:0",
    statusReason: "stalled: 3 rounds without a newly met DoD item",
  });
});

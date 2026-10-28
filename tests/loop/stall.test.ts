// Stall policy tests (matrix rows L6-L8d): stall decisions over synthetic
// round records. Outcomes come from the design table O2, never from policy.ts.
import { expect, test } from "bun:test";
import type { WorkItem } from "../../contracts/v1/types.js";
import type { LoopStallConfig } from "../../src/loop/config.js";
import {
  OUTCOME_CLASSES,
  metDod,
  newlyMetOf,
  stallDecision,
  stallRoundsOf,
} from "../../src/loop/policy.js";
import type { RoundOutcome, RoundRecord } from "../../src/loop/types.js";

const STALL: LoopStallConfig = { maxStagnantRounds: 3, maxRetries: 2 };

function record(outcome: RoundOutcome, retry: number, extra?: string): RoundRecord {
  return {
    round: 0,
    retry,
    requestId: `req-${outcome}-${retry}${extra ?? ""}`,
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

function demoItem(): WorkItem {
  return {
    schemaVersion: "v1",
    id: "demo-a",
    repo: "example/demo-repo",
    title: "Demo item",
    goal: "Reach the goal.",
    issue: null,
    dod: [
      { id: "D1", text: "First.", done: false },
      { id: "D2", text: "Second.", done: false },
    ],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
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

test("excluded rounds neither count nor reset the stall count (L7, O2, O4)", () => {
  const rounds = [record("red-ci", 0)];
  const continued = stallDecision("demo-a", 0, rounds, STALL);
  expect(continued).toEqual({ kind: "continue", stallRounds: 1 });
  const mixed = [
    record("red-ci", 0),
    record("lost", 0),
    record("red-ci", 0),
    record("start-rejected", 0),
  ];
  expect(stallRoundsOf(mixed, 0)).toBe(2);
  expect(stallDecision("demo-a", 0, mixed, STALL)).toEqual({
    kind: "continue",
    stallRounds: 2,
  });
  const parked = [...mixed, record("red-ci", 0)];
  expect(stallDecision("demo-a", 0, parked, STALL)).toEqual({
    kind: "park",
    then: "retry",
    stallRounds: 3,
    escalationKey: "stall:demo-a:0",
    statusReason: "stalled: 3 rounds without a newly met DoD item",
  });
});

test("a third retry blocks with the retries reason (L8, O4)", () => {
  const rounds = [record("red-ci", 2), record("findings", 2), record("no-push", 2)];
  expect(stallDecision("demo-a", 2, rounds, STALL)).toEqual({
    kind: "park",
    then: "block",
    stallRounds: 3,
    escalationKey: "stall:demo-a:2",
    blockedReason: "blocked: 2 retries used",
  });
});

test("stall rounds count only the requested retry (L8b, O4)", () => {
  const rounds = [
    record("red-ci", 0),
    record("findings", 0),
    record("no-push", 0),
    record("red-ci", 1),
  ];
  expect(stallRoundsOf(rounds, 1)).toBe(1);
  expect(stallDecision("demo-a", 1, rounds, STALL)).toEqual({
    kind: "continue",
    stallRounds: 1,
  });
});

test("only a merged round meets DoD items, minus earlier rounds (L8c, O3)", () => {
  const item = demoItem();
  expect(newlyMetOf(item, [], "merged")).toEqual(["D1", "D2"]);
  expect(newlyMetOf(item, [], "red-ci")).toEqual([]);
  expect(metDod(item, "red-ci")).toEqual([]);
  const previous = [{ ...record("merged", 0), newlyMet: ["D1", "D2"] }];
  expect(newlyMetOf(item, previous, "merged")).toEqual([]);
});

test("the outcome classes match table O2 for all 12 outcomes (L8d, O2)", () => {
  expect(OUTCOME_CLASSES).toEqual({
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
  });
});

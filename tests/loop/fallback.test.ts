// Model routing tests (matrix rows L9-L11b): rule F over the committed
// routing values, with synthetic records. Deterministic: no clock, no I/O.
import { expect, test } from "bun:test";
import type { WorkItem } from "../../contracts/v1/types.js";
import type { LoopRoutingConfig } from "../../src/loop/config.js";
import {
  LoopPolicyError,
  attemptsOnPreferred,
  chooseModel,
  failuresAfter,
} from "../../src/loop/policy.js";
import type { ResultLine } from "../../src/loop/results.js";
import type { RoundOutcome, RoundRecord } from "../../src/loop/types.js";

const PREFERRED = "meta/muse-glimmer-30b";
const FALLBACK = "muse-spark-1.3-contributor";

const ROUTING: LoopRoutingConfig = {
  models: { [PREFERRED]: "nvidia-build", [FALLBACK]: "meta-api" },
  fallback: { [PREFERRED]: FALLBACK },
  fallbackAfterFailures: 2,
  window: 20,
  minSamples: 5,
  minSuccessRate: 0.3,
};

function itemWith(overrides?: Partial<WorkItem["modelRouting"]>): WorkItem {
  return {
    schemaVersion: "v1",
    id: "demo-b",
    repo: "example/demo-repo",
    title: "Demo item",
    goal: "Reach the goal.",
    issue: null,
    dod: [{ id: "D1", text: "First.", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: {
      preferredModel: PREFERRED,
      attempts: 0,
      fallbackUsed: false,
      ...overrides,
    },
    retryCount: 0,
    stallRounds: 0,
  };
}

function record(model: string, outcome: RoundOutcome): RoundRecord {
  return {
    round: 0,
    retry: 0,
    requestId: `req-${model}-${outcome}`,
    model,
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

function line(
  model: string,
  routingResult: "success" | "failure" | "excluded",
  round: number,
): ResultLine {
  return {
    schemaVersion: "v1",
    key: `demo-b:${String(round)}`,
    at: "2026-10-28T00:00:00.000Z",
    workItemId: "demo-b",
    repo: "example/demo-repo",
    round,
    retry: 0,
    model,
    providerId: "nvidia-build",
    hostAlias: "host-a",
    outcome: routingResult === "success" ? "merged" : "red-ci",
    routingResult,
  };
}

test("two failures on the preferred model switch to the fallback (L9, O5)", () => {
  const item = itemWith();
  const loopItem = { failures: { [PREFERRED]: 2 }, rounds: [] as RoundRecord[] };
  expect(chooseModel(item, loopItem, [], ROUTING)).toEqual({
    model: FALLBACK,
    providerId: "meta-api",
    fallbackUsed: true,
    steered: null,
  });
});

test("excluded outcomes leave the failure count alone (L10, O2, O5)", () => {
  let failures: Readonly<Record<string, number>> = {};
  for (const outcome of ["lost", "lost", "ci-timeout"] as const) {
    failures = failuresAfter(failures, record(PREFERRED, outcome));
  }
  expect(failures).toEqual({});
  const item = itemWith();
  expect(chooseModel(item, { failures, rounds: [] }, [], ROUTING)).toEqual({
    model: PREFERRED,
    providerId: "nvidia-build",
    fallbackUsed: false,
    steered: null,
  });
});

test("a used fallback stays on the fallback and needs its route (L10b, O5)", () => {
  const used = itemWith({ fallbackUsed: true });
  expect(chooseModel(used, { failures: {}, rounds: [] }, [], ROUTING)).toEqual({
    model: FALLBACK,
    providerId: "meta-api",
    fallbackUsed: true,
    steered: null,
  });
  const withoutRoute: LoopRoutingConfig = { ...ROUTING, fallback: {} };
  let error: unknown;
  try {
    chooseModel(used, { failures: {}, rounds: [] }, [], withoutRoute);
  } catch (thrown: unknown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(LoopPolicyError);
  expect((error as LoopPolicyError).code).toBe("fallback-missing");
});

test("a bad success rate steers away from the preferred model (L11, O5)", () => {
  const item = itemWith();
  const results = [
    line(PREFERRED, "success", 0),
    line(PREFERRED, "failure", 1),
    line(PREFERRED, "failure", 2),
    line(PREFERRED, "failure", 3),
    line(PREFERRED, "failure", 4),
    line(PREFERRED, "excluded", 5),
    line(PREFERRED, "excluded", 6),
    line(PREFERRED, "excluded", 7),
  ];
  const steered = chooseModel(item, { failures: {}, rounds: [] }, results, ROUTING);
  expect(steered).toEqual({
    model: FALLBACK,
    providerId: "meta-api",
    fallbackUsed: true,
    steered: { successes: 1, samples: 5 },
  });
  const short = results.slice(0, 4);
  expect(chooseModel(item, { failures: {}, rounds: [] }, short, ROUTING)).toEqual({
    model: PREFERRED,
    providerId: "nvidia-build",
    fallbackUsed: false,
    steered: null,
  });
  const onPreferred = chooseModel(
    item,
    { failures: {}, rounds: [record(PREFERRED, "red-ci")] },
    results,
    ROUTING,
  );
  expect(onPreferred).toEqual({
    model: PREFERRED,
    providerId: "nvidia-build",
    fallbackUsed: false,
    steered: null,
  });
});

test("attempts count only rounds and starts on the preferred model (L11b, O5)", () => {
  const item = itemWith();
  const rounds = [
    record(PREFERRED, "red-ci"),
    record(PREFERRED, "red-ci"),
    record(FALLBACK, "red-ci"),
  ];
  expect(attemptsOnPreferred(item, rounds, "muse-spark-1.3-contributor")).toBe(2);
  expect(attemptsOnPreferred(item, rounds, PREFERRED)).toBe(3);
});

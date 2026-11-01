// Model routing tests (row L9 and the rule A row 160a): rule F and rule A
// over the committed routing values, with synthetic records. Deterministic:
// no clock, no I/O.
import { expect, test } from "bun:test";
import type { WorkItem } from "../../contracts/v1/types.js";
import type { LoopRoutingConfig } from "../../src/loop/config.js";
import { auditableChoice, chooseModel } from "../../src/loop/policy.js";
import type { ResultLine } from "../../src/loop/results.js";
import type { RoundRecord } from "../../src/loop/types.js";

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

// A closed round on the preferred model whose routing counts as a failure.
function failedLine(round: number): ResultLine {
  return {
    schemaVersion: "v1",
    key: `demo-a:${String(round)}`,
    at: "2026-10-28T10:00:00.000Z",
    workItemId: "demo-a",
    repo: "example/demo-repo",
    round,
    retry: 0,
    model: PREFERRED,
    providerId: "nvidia-build",
    hostAlias: null,
    outcome: "no-push",
    routingResult: "failure",
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

test("rule A holds the fallback when the preferred model already authored (160a)", () => {
  const auditors = [
    { providerId: "nvidia-build", model: PREFERRED },
    { providerId: "meta-api", model: FALLBACK },
  ];
  const failures = { [PREFERRED]: 2 };
  const loopItem = { failures, rounds: [] as RoundRecord[] };
  const routed = chooseModel(itemWith(), loopItem, [], ROUTING);
  expect(routed.model).toBe(FALLBACK);
  expect(auditableChoice(itemWith(), routed, [PREFERRED], auditors, ROUTING)).toEqual({
    model: PREFERRED,
    providerId: "nvidia-build",
    fallbackUsed: false,
    steered: null,
  });
  const failedLines = [0, 1, 2, 3, 4].map(failedLine);
  const steered = chooseModel(
    itemWith(),
    { failures: {}, rounds: [] as RoundRecord[] },
    failedLines,
    ROUTING,
  );
  expect(steered.steered).toEqual({ successes: 0, samples: 5 });
  expect(auditableChoice(itemWith(), steered, [], auditors, ROUTING)).toBe(steered);
  expect(
    auditableChoice(
      itemWith({ fallbackUsed: true }),
      chooseModel(
        itemWith({ fallbackUsed: true }),
        { failures: {}, rounds: [] as RoundRecord[] },
        [],
        ROUTING,
      ),
      [PREFERRED, FALLBACK],
      auditors,
      ROUTING,
    ),
  ).toBeNull();
});

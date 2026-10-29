// Model routing tests (matrix rows L9-L11b): rule F over the committed
// routing values, with synthetic records. Deterministic: no clock, no I/O.
import { expect, test } from "bun:test";
import type { WorkItem } from "../../contracts/v1/types.js";
import type { LoopRoutingConfig } from "../../src/loop/config.js";
import { chooseModel } from "../../src/loop/policy.js";
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

// findCycle tests (S4): self loop, three-cycle in both root orders, and
// a diamond with no cycle.
import { expect, test } from "bun:test";
import type { WorkItem } from "../../contracts/v1/types.js";
import { findCycle } from "../../src/work/dag.js";

function item(id: string, dependencies: readonly string[]): WorkItem {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo-repo",
    title: `Item ${id}`,
    goal: `Goal of ${id}`,
    issue: null,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [...dependencies],
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

test("self dependency reports edge x -> x (G1)", () => {
  expect(findCycle([item("x", ["x"])])).toEqual({ from: "x", to: "x", cycle: ["x", "x"] });
});

test("three-cycle in order a, b, c reports c -> a (G2)", () => {
  const items = [item("a", ["b"]), item("b", ["c"]), item("c", ["a"])];
  expect(findCycle(items)).toEqual({ from: "c", to: "a", cycle: ["a", "b", "c", "a"] });
});

test("same edges in order c, a, b report b -> c (G3)", () => {
  const items = [item("c", ["a"]), item("a", ["b"]), item("b", ["c"])];
  expect(findCycle(items)).toEqual({ from: "b", to: "c", cycle: ["c", "a", "b", "c"] });
});

test("diamond has no cycle (G4)", () => {
  const items = [item("a", ["b", "c"]), item("b", ["d"]), item("c", ["d"]), item("d", [])];
  expect(findCycle(items)).toBeNull();
});

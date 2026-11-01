// Work DAG cycle tests: an acyclic set with an edge into the wider store has
// no cycle, a three-item loop is reported from the first item, and a
// self-dependency is a cycle of one. Deterministic: no clock, no I/O.
import { expect, test } from "bun:test";
import type { WorkItem } from "../../contracts/v1/types.js";
import { findCycle } from "../../src/work/dag.js";

function item(id: string, dependencies: readonly string[]): WorkItem {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo-repo",
    title: `Item ${id}`,
    goal: "Reach the goal.",
    issue: null,
    dod: [{ id: "D1", text: "First.", done: false }],
    dependencies: [...dependencies],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: {
      preferredModel: "meta/muse-glimmer-30b",
      attempts: 0,
      fallbackUsed: false,
    },
    retryCount: 0,
    stallRounds: 0,
  };
}

test("an acyclic set whose edge leaves the input has no cycle", () => {
  const items = [item("demo-a", ["demo-b"]), item("demo-b", ["demo-stored"]), item("demo-c", [])];
  expect(findCycle(items)).toBeNull();
});

test("a three-item loop is reported with its path from the first item", () => {
  const items = [
    item("demo-a", ["demo-b"]),
    item("demo-b", ["demo-c"]),
    item("demo-c", ["demo-a"]),
  ];
  expect(findCycle(items)).toEqual({
    from: "demo-c",
    to: "demo-a",
    cycle: ["demo-a", "demo-b", "demo-c", "demo-a"],
  });
});

test("an item that depends on itself is a cycle of one", () => {
  expect(findCycle([item("demo-a", []), item("demo-b", ["demo-b"])])).toEqual({
    from: "demo-b",
    to: "demo-b",
    cycle: ["demo-b", "demo-b"],
  });
});

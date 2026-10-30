import { expect, test } from "bun:test";
import { checkWorkStore } from "../../src/work/store.js";
import { summarizeStore } from "../../src/work/summary.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const storePath = join(process.cwd(), "tests/fixtures/coord/d3/store.json");

function loadStore() {
  const text = readFileSync(storePath, "utf8");
  const raw = JSON.parse(text) as unknown;
  return checkWorkStore(raw, storePath);
}

test("summarizeStore returns revision, total and byStatus for d3 store", () => {
  const store = loadStore();
  const summary = summarizeStore(store);
  expect(summary).toEqual({
    revision: 4,
    total: 3,
    byStatus: {
      queued: 1,
      running: 0,
      review: 0,
      parked: 0,
      blocked: 1,
      done: 1,
    },
  });
});

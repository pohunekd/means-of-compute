// The committed configs route Muse Spark Open to the Baseten provider and
// pool, fall back to Spark Contributor, and audit Spark Open work with a
// different model.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { WorkItem } from "../../contracts/v1/types.js";
import { loadAuditorConfig } from "../../src/auditor/config.js";
import { selectAuditor } from "../../src/auditor/select.js";
import { loadBudgetConfig, poolOfProvider } from "../../src/budget/config.js";
import { loadLoopConfig } from "../../src/loop/config.js";
import { chooseModel } from "../../src/loop/policy.js";

const SPARK_OPEN = "meta-models/muse-spark-open-1026";
const CONTRIBUTOR = "muse-spark-1.3-contributor";

test("Spark Open runs on the Baseten pool and is audited by another model", async () => {
  const loop = await loadLoopConfig("config/loop.json", "production");
  const budget = await loadBudgetConfig("config/budget.json");
  const auditor = await loadAuditorConfig("config/auditor.json");
  expect(loop.github.intake.defaultModel).toBe(SPARK_OPEN);
  const fixture = JSON.parse(
    readFileSync("contracts/v1/fixtures/work-item.json", "utf8"),
  ) as WorkItem;
  const item: WorkItem = {
    ...fixture,
    modelRouting: { preferredModel: SPARK_OPEN, attempts: 0, fallbackUsed: false },
  };
  const first = chooseModel(item, { failures: {}, rounds: [] }, [], loop.routing);
  expect(first).toMatchObject({ model: SPARK_OPEN, providerId: "baseten", fallbackUsed: false });
  expect(poolOfProvider(budget, first.providerId).id).toBe("baseten");
  const fallback = chooseModel(
    item,
    { failures: { [SPARK_OPEN]: 2 }, rounds: [] },
    [],
    loop.routing,
  );
  expect(fallback).toMatchObject({ model: CONTRIBUTOR, providerId: "meta-api" });
  expect(poolOfProvider(budget, fallback.providerId).id).toBe(budget.poolId);
  expect(selectAuditor(auditor.auditors, [SPARK_OPEN], item.id)).toEqual({
    providerId: "meta-api",
    model: CONTRIBUTOR,
  });
  expect(selectAuditor(auditor.auditors, [SPARK_OPEN, CONTRIBUTOR], item.id).model).toBe(
    "meta/muse-glimmer-30b",
  );
});

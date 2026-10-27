// Auditor selection tests: Spark-authored work goes to Glimmer,
// Glimmer-authored work goes to Spark, and work authored by both
// refuses. Mutation: pick the first auditor without the membership check.
import { expect, test } from "bun:test";
import { NoEligibleAuditorError, selectAuditor } from "../../src/auditor/select.js";

const AUDITORS = [
  { providerId: "meta-api", model: "muse-spark-1.3-contributor" },
  { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" },
  { providerId: "wonder", model: "muse-wonder-1.0" },
];
const GLIMMER = "meta/muse-glimmer-30b";
const SPARK = "muse-spark-1.3-contributor";

test("Glimmer-authored work is audited by Spark", () => {
  expect(selectAuditor(AUDITORS, [GLIMMER], "w1").model).toBe(SPARK);
});

test("Spark-authored work is audited by Glimmer", () => {
  expect(selectAuditor(AUDITORS, [SPARK], "w1").model).toBe(GLIMMER);
});

test("work authored by every auditor refuses", () => {
  let message = "";
  try {
    selectAuditor(AUDITORS, [GLIMMER, SPARK, "muse-wonder-1.0"], "w1");
  } catch (error: unknown) {
    if (!(error instanceof NoEligibleAuditorError)) {
      throw error;
    }
    message = error.message;
  }
  expect(message).toContain("no eligible auditor");
});

test("empty authors select the first auditor (runAudit refuses earlier)", () => {
  expect(selectAuditor(AUDITORS, [], "w1").model).toBe(SPARK);
});

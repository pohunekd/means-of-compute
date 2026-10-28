// Auditor selection tests: Spark-authored work goes to Glimmer,
// Glimmer-authored work goes to Spark, and work authored by both
// refuses before any budget or model call. The merge auditor audits any
// work Wonder did not author and never audits its own. Mutation: pick
// the first auditor without the check.
import { expect, test } from "bun:test";
import {
  NoEligibleAuditorError,
  selectAuditor,
  selectMergeAuditor,
} from "../../src/auditor/select.js";

const AUDITORS = [
  { providerId: "meta-api", model: "muse-spark-1.3-contributor" },
  { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" },
];
const GLIMMER = "meta/muse-glimmer-30b";
const SPARK = "muse-spark-1.3-contributor";

test("Glimmer-authored work is audited by Spark", () => {
  expect(selectAuditor(AUDITORS, [GLIMMER], "w1").model).toBe(SPARK);
});

test("Spark-authored work is audited by Glimmer", () => {
  expect(selectAuditor(AUDITORS, [SPARK], "w1").model).toBe(GLIMMER);
});

test("work authored by both refuses", () => {
  let message = "";
  try {
    selectAuditor(AUDITORS, [GLIMMER, SPARK], "w1");
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

const WONDER = "muse-wonder-1.0";
const MERGE_AUDITOR = { providerId: "meta-wonder", model: WONDER };

test("S1: merge auditor audits single- and two-author work (mutation: prefer a general auditor)", () => {
  expect(selectMergeAuditor(MERGE_AUDITOR, [GLIMMER], "w1")).toEqual(MERGE_AUDITOR);
  expect(selectMergeAuditor(MERGE_AUDITOR, [GLIMMER, SPARK], "w1")).toEqual(MERGE_AUDITOR);
});

test("S2: merge auditor never audits its own work (mutation: drop the membership check)", () => {
  let message = "";
  try {
    selectMergeAuditor(MERGE_AUDITOR, [WONDER], "w1");
  } catch (error: unknown) {
    if (!(error instanceof NoEligibleAuditorError)) {
      throw error;
    }
    message = error.message;
  }
  expect(message).toBe(`no eligible auditor: merge auditor ${WONDER} authored w1`);
});

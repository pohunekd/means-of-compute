// Merge-rule tests (PR 3 matrix rows L14-L19e): ciStatus latest-wins,
// marker login filter, verdict recount and author checks, M1 table order,
// mergeStep M2-before-M3 order, pullDecision filters and baseCheck races.
import { describe, expect, test } from "bun:test";
import {
  baseCheck,
  ciStatus,
  factoryMarkers,
  m1,
  markerMatches,
  mergeStep,
  pullDecision,
  verdictCheck,
} from "../../src/loop/merge-rule.js";
import type { CheckRun } from "../../src/loop/github.js";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const shaH = "c".repeat(40);
const shaOther = "d".repeat(40);

function run(id: number, name: string, status: string, conclusion: string | null): CheckRun {
  return { id, name, status, conclusion };
}

function markerLine(
  repo: string,
  pull: number,
  head: string,
  auditor: string,
  high: number,
  medium: number,
  low: number,
): string {
  return `<!-- audit:v1:${repo}#${String(pull)}@${head}:auditor=${auditor}:high=${String(high)}:medium=${String(medium)}:low=${String(low)} -->`;
}

function finding(severity: "high" | "medium" | "low") {
  return { severity, location: "loc", defect: "def", scenario: "sc", fixDirection: "fix" };
}

function verdict(
  headSha: string,
  pullNumber: number | null,
  auditor: string,
  severities: readonly ("high" | "medium" | "low")[],
) {
  return {
    schemaVersion: "v1" as const,
    repo: "o/r",
    workItemId: "w-1",
    pullNumber,
    headSha,
    authorModels: [],
    auditorModel: auditor,
    counts: {
      high: severities.filter((entry) => entry === "high").length,
      medium: severities.filter((entry) => entry === "medium").length,
      low: severities.filter((entry) => entry === "low").length,
    },
    findings: severities.map((severity) => finding(severity)),
  };
}

function badCounts(headSha: string) {
  const good = verdict(headSha, 7, "spark", ["low"]);
  return { ...good, counts: { high: 1, medium: 0, low: 0 } };
}

describe("ciStatus", () => {
  test("L14: zero runs, missing required, cancelled and required-skipped are pending or red", () => {
    expect(ciStatus([], ["unit"])).toBe("pending");
    expect(ciStatus([run(1, "lint", "completed", "success")], ["unit", "lint"])).toBe("pending");
    expect(ciStatus([run(1, "unit", "completed", "cancelled")], ["unit"])).toBe("red");
    expect(ciStatus([run(1, "unit", "completed", "skipped")], ["unit"])).toBe("red");
    expect(
      ciStatus(
        [run(1, "unit", "completed", "success"), run(2, "docs", "completed", "neutral")],
        ["unit"],
      ),
    ).toBe("green");
  });

  test("L15: the newest run for a name decides", () => {
    const runs = [run(1, "unit", "completed", "failure"), run(2, "unit", "completed", "success")];
    expect(ciStatus(runs, ["unit"])).toBe("green");
  });
});

describe("factoryMarkers", () => {
  test("L16: a marker from another login is ignored", () => {
    const comments = [{ login: "someone", first: markerLine("o/r", 7, shaH, "spark", 0, 0, 1) }];
    const markers = factoryMarkers(comments, "factory");
    expect(markers).toHaveLength(0);
    const clean = verdict(shaH, 7, "spark", []);
    expect(markerMatches(markers, "o/r", 7, shaH, clean)).toBe(false);
  });
});

describe("verdictCheck", () => {
  test("L17: counts that disagree with recount are invalid", () => {
    expect(verdictCheck([badCounts(shaH)], 7, shaH, [])).toEqual({ kind: "invalid" });
  });

  test("L18: auditor among authors or another pull number is invalid", () => {
    const own = verdict(shaH, 7, "spark", []);
    expect(verdictCheck([own], 7, shaH, ["spark"])).toEqual({ kind: "invalid" });
    const other = verdict(shaH, 8, "spark", []);
    expect(verdictCheck([other], 7, shaH, [])).toEqual({ kind: "invalid" });
    const missing = verdict(shaOther, 7, "spark", []);
    expect(verdictCheck([missing], 7, shaH, [])).toEqual({ kind: "missing" });
  });
});

describe("markerMatches", () => {
  test("L19: a marker whose low differs does not match", () => {
    const clean = verdict(shaH, 7, "spark", ["low"]);
    const comments = [{ login: "factory", first: markerLine("o/r", 7, shaH, "spark", 0, 0, 2) }];
    const markers = factoryMarkers(comments, "factory");
    expect(markerMatches(markers, "o/r", 7, shaH, clean)).toBe(false);
    const exact = [{ login: "factory", first: markerLine("o/r", 7, shaH, "spark", 0, 0, 1) }];
    expect(markerMatches(factoryMarkers(exact, "factory"), "o/r", 7, shaH, clean)).toBe(true);
  });
});

describe("m1", () => {
  test("L19b: the A2 table rows in order", () => {
    const open = (view: object) => m1({ state: "OPEN", ...view } as never, shaH, "main");
    expect(open({ headRefOid: shaH, baseRefName: "other", isDraft: false })).toEqual({
      kind: "operator",
      code: "base-mismatch",
    });
    expect(open({ headRefOid: shaH, baseRefName: "main", isDraft: true })).toEqual({
      kind: "draft",
    });
    expect(open({ headRefOid: shaOther, baseRefName: "main", isDraft: false })).toEqual({
      kind: "head-moved",
      headSha: shaOther,
    });
    expect(open({ headRefOid: shaH, baseRefName: "main", isDraft: false })).toEqual({
      kind: "pass",
    });
    const merged = (view: object) => m1({ state: "MERGED", ...view } as never, shaH, "main");
    expect(merged({ headRefOid: shaH, baseRefName: "main" })).toEqual({ kind: "merged" });
    expect(merged({ headRefOid: shaOther, baseRefName: "main" })).toEqual({
      kind: "operator",
      code: "merged-elsewhere",
    });
    expect(merged({ headRefOid: shaH, baseRefName: "other" })).toEqual({
      kind: "operator",
      code: "merged-elsewhere",
    });
    expect(
      m1({ state: "CLOSED", headRefOid: shaH, baseRefName: "main" } as never, shaH, "main"),
    ).toEqual({
      kind: "operator",
      code: "pull-closed",
    });
  });
});

describe("mergeStep", () => {
  test("L19c: ci decides before the verdict, approval gates ready", () => {
    const base = {
      view: {
        state: "OPEN" as const,
        headRefOid: shaH,
        baseRefName: "main",
        isDraft: false,
        mergeCommit: null,
      },
      headSha: shaH,
      baseBranch: "main",
      ci: "pending" as const,
      verdict: { kind: "invalid" } as const,
      markerOk: false,
      mergeMode: "by-rule" as const,
      approved: false,
    };
    expect(mergeStep(base)).toEqual({ kind: "ci", status: "pending" });
    const clean = verdict(shaH, 7, "spark", []);
    const gated = {
      ...base,
      ci: "green" as const,
      verdict: { kind: "clean", verdict: clean } as const,
      markerOk: true,
      mergeMode: "human-approval" as const,
      approved: false,
    };
    expect(mergeStep(gated)).toEqual({ kind: "awaiting-approval" });
    expect(
      mergeStep({
        ...base,
        ci: "green" as const,
        verdict: { kind: "clean", verdict: clean } as const,
        markerOk: true,
      }),
    ).toEqual({
      kind: "ready",
    });
  });
});

describe("pullDecision", () => {
  test("L19d: duplicates adopted or ignored by login and fork", () => {
    const row = (number: number, login: string, cross: boolean, state: "OPEN" | "CLOSED") => ({
      number,
      state,
      headRefOid: shaA,
      baseRefName: "main",
      isDraft: false,
      isCrossRepository: cross,
      authorLogin: login,
    });
    expect(
      pullDecision([row(1, "factory", false, "OPEN"), row(2, "factory", false, "OPEN")], "factory"),
    ).toEqual({
      kind: "duplicate",
    });
    expect(
      pullDecision([row(1, "someone", false, "OPEN"), row(2, "factory", true, "OPEN")], "factory"),
    ).toEqual({
      kind: "none",
    });
    const single = pullDecision([row(3, "factory", false, "OPEN")], "factory");
    expect(single.kind).toBe("adopt");
  });
});

describe("baseCheck", () => {
  test("L19e: only [base, head] passes", () => {
    expect(baseCheck([shaB, shaH], shaB, shaH)).toBe("ok");
    expect(baseCheck([shaA, shaH], shaB, shaH)).toBe("race");
    expect(baseCheck([shaB], shaB, shaH)).toBe("race");
  });
});

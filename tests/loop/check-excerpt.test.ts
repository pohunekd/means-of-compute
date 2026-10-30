// Failing-check excerpt tests (slice 160b rows): the pure excerpt
// builder and the brief over a red head.
import { expect, test } from "bun:test";
import { buildBrief, type BriefPrevious } from "../../src/loop/brief.js";
import { checkExcerptOf, previousRoundOf, type FailingAnnotations } from "../../src/loop/review.js";
import type { LoopCheckExcerptConfig } from "../../src/loop/config.js";
import type { LoopItem, RoundRecord } from "../../src/loop/types.js";
import { initialLoopItem } from "../../src/loop/start.js";

const CONFIG: LoopCheckExcerptConfig = { maxBytes: 4000, stripPrefixes: [] };
const RUNNER_CONFIG: LoopCheckExcerptConfig = {
  maxBytes: 4000,
  stripPrefixes: ["/home/runner/work/r/r/"],
};

function failing(
  check: string,
  annotations: FailingAnnotations["annotations"],
): FailingAnnotations {
  return { check, annotations };
}

test("excerpt keeps failures, drops noise, and cuts to maxBytes", () => {
  const text = checkExcerptOf(
    [
      failing("gates", [
        {
          path: "tests/x.test.ts",
          startLine: 3,
          level: "failure",
          title: "assertion",
          message:
            "expected 1 to equal 2 at \u001b[31m/home/runner/work/r/r/tests/x.test.ts:3:1\u001b[0m",
        },
        {
          path: "tests/x.test.ts",
          startLine: 1,
          level: "failure",
          title: null,
          message: "Process completed with exit code 1.",
        },
      ]),
      failing("macos-probe", [
        {
          path: "tests/y.test.ts",
          startLine: 5,
          level: "warning",
          title: null,
          message: "a slow test",
        },
      ]),
    ],
    RUNNER_CONFIG,
  );
  expect(text).not.toBeNull();
  expect(text ?? "").toContain("[gates] tests/x.test.ts:3 assertion");
  expect(text ?? "").toContain("tests/x.test.ts:3:1");
  expect(text ?? "").not.toContain("");
  expect(text ?? "").not.toContain("/home/runner/");
  expect(text ?? "").not.toContain("Process completed");
  expect(text ?? "").not.toContain("a slow test");

  const cut = checkExcerptOf(
    [
      failing("gates", [
        {
          path: "tests/x.test.ts",
          startLine: 1,
          level: "failure",
          title: null,
          message: `begin ${"a".repeat(1000)}`,
        },
      ]),
    ],
    { maxBytes: 256, stripPrefixes: [] },
  );
  expect(cut).not.toBeNull();
  const body = (cut ?? "").replace(/\n\(excerpt truncated\)$/, "");
  expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(256);
  expect(cut ?? "").toMatch(/\n\(excerpt truncated\)$/);

  expect(checkExcerptOf([], CONFIG)).toBeNull();
  expect(
    checkExcerptOf(
      [
        failing("gates", [
          {
            path: "tests/x.test.ts",
            startLine: 1,
            level: "notice",
            title: null,
            message: "all good",
          },
        ]),
      ],
      CONFIG,
    ),
  ).toBeNull();
});

const H = "a".repeat(40);
const H2 = "b".repeat(40);

function roundRecord(
  outcome: RoundRecord["outcome"],
  headSha: string | null,
  extra: Partial<RoundRecord> = {},
): RoundRecord {
  return {
    round: 0,
    retry: 0,
    requestId: "gh-demo-1:0",
    model: "meta/muse-glimmer-30b",
    providerId: "nvidia-build",
    hostAlias: "host-a",
    attempt: "failure",
    outcome,
    headSha,
    failingChecks: [],
    verdict: null,
    newlyMet: [],
    at: "2026-10-28T00:00:00.000Z",
    baseRace: false,
    ...extra,
  };
}

function loopItemWith(pullHead: string): LoopItem {
  return {
    ...initialLoopItem(),
    phase: "ci",
    round: 2,
    pull: { number: 1, headSha: pullHead },
    rounds: [
      roundRecord("red-ci", H, { failingChecks: ["gates"], checkExcerpt: "X" }),
      roundRecord("no-new-commit", H, { attempt: "success" }),
    ],
  };
}

function briefItem(): Parameters<typeof buildBrief>[0] {
  return {
    item: {
      schemaVersion: "v1",
      id: "gh-demo-1",
      repo: "example/demo",
      title: "Demo item gh-demo-1",
      goal: "Drive a review",
      issue: null,
      dod: [{ id: "D1", text: "Done", done: false }],
      dependencies: [],
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
    },
    branch: "moc/gh-demo-1",
    baseBranch: "main",
    previous: null,
  };
}

test("brief after a red head keeps names and excerpt until the head moves", () => {
  const kept = previousRoundOf(loopItemWith(H), []);
  expect(kept).toEqual({
    outcome: "no-new-commit",
    failingChecks: ["gates"],
    checkExcerpt: { headSha: H, text: "X" },
    findings: null,
  });
  const moved = previousRoundOf(loopItemWith(H2), []);
  expect(moved).toEqual({
    outcome: "no-new-commit",
    failingChecks: [],
    checkExcerpt: null,
    findings: null,
  });

  const previous: BriefPrevious = {
    outcome: "no-new-commit",
    failingChecks: ["gates"],
    checkExcerpt: { headSha: H, text: "X" },
    findings: null,
  };
  const result = buildBrief({ ...briefItem(), previous }, 65536);
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") {
    return;
  }
  expect(result.brief).toContain("Failing checks: gates.");
  expect(result.brief).toContain(
    `CI failure annotations at ${H.slice(0, 12)} (CI can fail where local gates pass):`,
  );
  expect(result.brief).toContain("X");
  const absent = buildBrief(
    {
      ...briefItem(),
      previous: {
        outcome: "no-new-commit",
        failingChecks: [],
        checkExcerpt: null,
        findings: null,
      },
    },
    65536,
  );
  expect(absent.kind).toBe("ok");
  if (absent.kind !== "ok") {
    return;
  }
  expect(absent.brief).not.toContain("Failing checks:");
  expect(absent.brief).not.toContain("CI failure annotations at");
});

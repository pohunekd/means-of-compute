// Result record tests (matrix rows L12-L12d): read dedupe, torn tail and
// shape errors plus R-a/R-b, append repair, and derivation. Expected values
// come from the design table O2 and B4, never from results.ts.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../../contracts/v1/types.js";
import {
  LoopResultsDataError,
  appendResultLine,
  readResults,
  resultLineOf,
  type ResultLine,
} from "../../src/loop/results.js";
import type { RoundRecord } from "../../src/loop/types.js";

function item(): WorkItem {
  return {
    schemaVersion: "v1",
    id: "demo-c",
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
      preferredModel: "meta/muse-glimmer-30b",
      attempts: 0,
      fallbackUsed: false,
    },
    retryCount: 0,
    stallRounds: 0,
  };
}

function line(
  round: number,
  outcome: ResultLine["outcome"],
  routing: ResultLine["routingResult"],
): ResultLine {
  return {
    schemaVersion: "v1",
    key: `demo-c:${String(round)}`,
    at: "2026-10-28T00:00:00.000Z",
    workItemId: "demo-c",
    repo: "example/demo-repo",
    round,
    retry: 0,
    model: "meta/muse-glimmer-30b",
    providerId: "nvidia-build",
    hostAlias: "host-a",
    outcome,
    routingResult: routing,
  };
}

function recordOf(round: number): RoundRecord {
  return {
    round,
    retry: 1,
    requestId: null,
    model: "meta/muse-glimmer-30b",
    providerId: "nvidia-build",
    hostAlias: "host-a",
    attempt: "failure",
    outcome: "ci-timeout",
    headSha: null,
    failingChecks: [],
    verdict: null,
    newlyMet: [],
    at: "2026-10-28T00:01:00.000Z",
    baseRace: false,
  };
}

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-results-"));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("a duplicate key keeps the first line and a torn tail is ignored (L12, O6)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-results.jsonl");
    const first = line(0, "merged", "success");
    writeFileSync(
      path,
      `${JSON.stringify(first)}\n${JSON.stringify(line(0, "red-ci", "failure"))}\n${JSON.stringify(
        line(1, "red-ci", "failure"),
      ).slice(0, 40)}`,
    );
    const before = readFileSync(path, "utf8");
    const lines = await readResults(path);
    expect(lines).toEqual([first]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

test("an invalid second line names line 2 without its content (L12, B4)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-results.jsonl");
    writeFileSync(path, `${JSON.stringify(line(0, "merged", "success"))}\n{broken\n`);
    let error: unknown;
    try {
      await readResults(path);
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopResultsDataError);
    const message = (error as Error).message;
    expect(message).toContain("line 2");
    expect(message).not.toContain("{broken");
  });
});

test("key and routing mismatches fail R-a and R-b (L12b, B4)", () =>
  withTempDir(async (dir) => {
    const ra = join(dir, "ra.jsonl");
    writeFileSync(ra, `${JSON.stringify({ ...line(2, "merged", "success"), key: "demo-c:1" })}\n`);
    let raError: unknown;
    try {
      await readResults(ra);
    } catch (thrown: unknown) {
      raError = thrown;
    }
    expect(raError).toBeInstanceOf(LoopResultsDataError);
    const rb = join(dir, "rb.jsonl");
    writeFileSync(rb, `${JSON.stringify(line(0, "ci-timeout", "failure"))}\n`);
    let rbError: unknown;
    try {
      await readResults(rb);
    } catch (thrown: unknown) {
      rbError = thrown;
    }
    expect(rbError).toBeInstanceOf(LoopResultsDataError);
  }));

test("an append truncates a 7-byte torn tail and keeps earlier lines (L12c, B4)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-results.jsonl");
    const first = line(0, "merged", "success");
    const second = line(1, "red-ci", "failure");
    writeFileSync(path, `${JSON.stringify(first)}\n${"x".repeat(7)}`);
    const result = await appendResultLine(path, second);
    expect(result).toEqual({ truncatedBytes: 7 });
    expect(await readResults(path)).toEqual([first, second]);
  });
});

test("a derived line carries the record at time and excluded routing (L12d, B4)", () => {
  expect(resultLineOf(item(), recordOf(2))).toEqual({
    schemaVersion: "v1",
    key: "demo-c:2",
    at: "2026-10-28T00:01:00.000Z",
    workItemId: "demo-c",
    repo: "example/demo-repo",
    round: 2,
    retry: 1,
    model: "meta/muse-glimmer-30b",
    providerId: "nvidia-build",
    hostAlias: "host-a",
    outcome: "ci-timeout",
    routingResult: "excluded",
  });
});

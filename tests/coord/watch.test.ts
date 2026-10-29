// Watch core test (W1): one scenario with the real captured payload shapes.
import { expect, test } from "bun:test";
import {
  attentionOf,
  auditTargets,
  isGoalTerminal,
  parseFleet,
  parseVerdicts,
  parseWatchRows,
  type WatchContext,
  type WatchRow,
} from "../../src/coord/watch.js";

function listPayload(extra: readonly unknown[] = []): unknown {
  return {
    ok: true,
    revision: 4,
    items: [
      {
        id: "d3-parser",
        repo: "example/demo-repo",
        title: "Parse inputs",
        issue: null,
        status: "done",
        statusReason: null,
        assignedHostAlias: null,
        branch: "work/d3-parser",
        pullNumber: 5,
        dependencies: [],
        dod: { done: 2, total: 2 },
        retryCount: 0,
        stallRounds: 0,
        modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 1, fallbackUsed: false },
      },
      {
        id: "d3-writer",
        repo: "example/demo-repo",
        title: "Write outputs",
        issue: null,
        status: "blocked",
        statusReason: "blocked: 2 retries used",
        assignedHostAlias: null,
        branch: "work/d3-writer",
        pullNumber: 7,
        dependencies: ["d3-parser"],
        dod: { done: 1, total: 2 },
        retryCount: 2,
        stallRounds: 0,
        modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 3, fallbackUsed: true },
      },
      {
        id: "d3-report",
        repo: "example/demo-repo",
        title: "Render report",
        issue: null,
        status: "queued",
        statusReason: null,
        assignedHostAlias: null,
        branch: null,
        pullNumber: null,
        dependencies: ["d3-writer"],
        dod: { done: 0, total: 1 },
        retryCount: 0,
        stallRounds: 0,
        modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
      },
      ...extra,
    ],
  };
}

function writerFollowup(): unknown {
  return {
    id: "d3-writer-fu",
    repo: "example/demo-repo",
    title: "Follow up writer",
    issue: null,
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    dependencies: [],
    dod: { done: 0, total: 1 },
    retryCount: 0,
    stallRounds: 0,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
  };
}

const AUDIT_PAYLOAD: unknown = {
  ok: true,
  workItemId: "d3-writer",
  verdicts: [
    {
      headSha: "7c1e5a9b3d2f4e6a8b0c1d3e5f7a9b2c4d6e8f01",
      pullNumber: 7,
      repo: "example/demo-repo",
      auditorModel: "muse-wonder-1.0",
      authorModels: ["meta/muse-glimmer-30b", "muse-spark-1.3-contributor"],
      counts: { high: 0, medium: 1, low: 0 },
      findings: [
        {
          severity: "medium",
          location: "src/writer.ts:14",
          defect: "retry counter not reset",
          scenario: "second attempt keeps stale count",
          fixDirection: "reset the counter on retry",
        },
      ],
    },
  ],
};

const FLEET_PAYLOAD: unknown = {
  ok: true,
  work: { queued: 1, running: 0 },
  hosts: [],
  hostState: { available: false, reason: "no idle host" },
  fleet: { paused: false, pausedBy: null, pendingRequests: [] },
};

function watchCtx(): WatchContext {
  return {
    goalId: "d3",
    idPrefix: "d3",
    mergeModes: new Map([["example/demo-repo", "by-rule"]]),
    maxFollowupsPerRun: 2,
    pauseRequestBlockedItems: 3,
    followupsFiled: 0,
    consumed: new Set(),
  };
}

test("W1 watch followup", () => {
  const rowsParsed = parseWatchRows(listPayload());
  expect(rowsParsed.ok).toBe(true);
  if (!rowsParsed.ok) {
    return;
  }
  const verdictsParsed = parseVerdicts(AUDIT_PAYLOAD);
  expect(verdictsParsed.ok).toBe(true);
  if (!verdictsParsed.ok) {
    return;
  }
  const fleetParsed = parseFleet(FLEET_PAYLOAD);
  expect(fleetParsed.ok).toBe(true);
  if (!fleetParsed.ok) {
    return;
  }
  const rows: readonly WatchRow[] = rowsParsed.value.rows;
  const verdicts = new Map([["d3-writer", verdictsParsed.value]]);
  const ctx = watchCtx();
  expect(auditTargets(rows, ctx)).toEqual(["d3-writer"]);
  expect(attentionOf({ rows, verdicts, fleet: fleetParsed.value }, ctx)).toEqual([
    {
      kind: "followup",
      key: "followup:d3-writer",
      workItemId: "d3-writer",
      pullNumber: 7,
      issue: null,
      fallbackUsed: true,
    },
  ]);
  expect(isGoalTerminal(rows, "d3")).toBe(true);

  const again = parseWatchRows(listPayload([writerFollowup()]));
  expect(again.ok).toBe(true);
  if (!again.ok) {
    return;
  }
  expect(attentionOf({ rows: again.value.rows, verdicts, fleet: fleetParsed.value }, ctx)).toEqual(
    [],
  );
  expect(isGoalTerminal(again.value.rows, "d3")).toBe(false);
});

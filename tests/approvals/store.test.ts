// Approvals store tests (matrix A1-A7): recording, the duplicate rule,
// the pending cap, the no-change rule, pause ordering by decision seq,
// rejected pause and the merge match on all three fields.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvedMerge,
  checkApprovals,
  fleetPause,
  pendingRequests,
  readApprovals,
  recordRequest,
} from "../../src/approvals/store.js";
import type { ApprovalsDocument } from "../../src/approvals/store.js";

const APPROVE_ARGS = {
  workItemId: "demo-item",
  pullNumber: 12,
  headSha: "0".repeat(40),
  reason: "Ship the demo item.",
} as const;

function requestsPath(): string {
  return join(mkdtempSync(join(tmpdir(), "approvals-store-")), "approval-requests.json");
}

function fixedNow(): () => Date {
  return () => new Date("2026-10-26T10:00:00.000Z");
}

async function recordApprove(path: string, overrides: Record<string, unknown> = {}) {
  return recordRequest(path, {
    tool: "approve",
    args: { ...APPROVE_ARGS, ...overrides },
    caller: "coordinator",
    now: fixedNow(),
    maxPending: 20,
  });
}

test("record approve gives req-000001 with seq 1 and nextSeq 2 (A1)", async () => {
  const path = requestsPath();
  const outcome = await recordApprove(path);
  if (outcome.kind !== "recorded") {
    throw new Error(`expected recorded, got ${outcome.kind}`);
  }
  expect(outcome.request.requestId).toBe("req-000001");
  expect(outcome.request.seq).toBe(1);
  const doc = await readApprovals(path);
  expect(doc.nextSeq).toBe(2);
  expect(doc.requests).toHaveLength(1);
});

test("an identical record returns the same id (A2)", async () => {
  const path = requestsPath();
  const first = await recordApprove(path);
  const second = await recordApprove(path);
  if (first.kind !== "recorded" || second.kind !== "existing") {
    throw new Error(`expected recorded then existing, got ${first.kind} and ${second.kind}`);
  }
  expect(second.request.requestId).toBe(first.request.requestId);
  const doc = await readApprovals(path);
  expect(doc.nextSeq).toBe(2);
});

test("maxPending 1 with one pending refuses with too-many-pending (A3)", async () => {
  const path = requestsPath();
  await recordApprove(path);
  const outcome = await recordRequest(path, {
    tool: "approve",
    args: { ...APPROVE_ARGS, pullNumber: 13 },
    caller: "coordinator",
    now: fixedNow(),
    maxPending: 1,
  });
  if (outcome.kind !== "refused") {
    throw new Error(`expected refused, got ${outcome.kind}`);
  }
  expect(outcome.code).toBe("too-many-pending");
  expect(outcome.message).toBe("1 requests already pending");
});

test("resume while running refuses with no-change (A4)", async () => {
  const path = requestsPath();
  const outcome = await recordRequest(path, {
    tool: "pause_fleet",
    args: { action: "resume", reason: "Keep running." },
    caller: "coordinator",
    now: fixedNow(),
    maxPending: 20,
  });
  if (outcome.kind !== "refused") {
    throw new Error(`expected refused, got ${outcome.kind}`);
  }
  expect(outcome.code).toBe("no-change");
  expect(outcome.message).toBe("fleet is already running");
});

function approvedDoc(): ApprovalsDocument {
  return {
    schemaVersion: "v1",
    nextSeq: 5,
    requests: [
      {
        requestId: "req-000001",
        seq: 1,
        tool: "pause_fleet",
        args: { action: "resume", reason: "Keep running." },
        argsSha256: "a".repeat(64),
        caller: "coordinator",
        requestedAt: "2026-10-26T10:00:00.000Z",
        state: "approved",
        decision: { seq: 4, author: "owner", decidedAt: "2026-10-26T12:00:00.000Z" },
      },
      {
        requestId: "req-000002",
        seq: 2,
        tool: "pause_fleet",
        args: { action: "pause", reason: "Pause the fleet." },
        argsSha256: "b".repeat(64),
        caller: "coordinator",
        requestedAt: "2026-10-26T10:05:00.000Z",
        state: "approved",
        decision: { seq: 3, author: "owner", decidedAt: "2026-10-26T11:00:00.000Z" },
      },
    ],
  };
}

test("an older approved resume with a higher decision seq wins (A5)", async () => {
  const path = requestsPath();
  writeFileSync(path, JSON.stringify(approvedDoc()));
  const doc = await readApprovals(path);
  expect(fleetPause(doc)).toEqual({ paused: false, pausedBy: null });
});

test("a rejected pause leaves the fleet running (A6)", async () => {
  const path = requestsPath();
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "v1",
      nextSeq: 3,
      requests: [
        {
          requestId: "req-000001",
          seq: 1,
          tool: "pause_fleet",
          args: { action: "pause", reason: "Pause the fleet." },
          argsSha256: "c".repeat(64),
          caller: "coordinator",
          requestedAt: "2026-10-26T10:00:00.000Z",
          state: "rejected",
          decision: { seq: 2, author: "owner", decidedAt: "2026-10-26T11:00:00.000Z" },
        },
      ],
    }),
  );
  const doc = await readApprovals(path);
  expect(fleetPause(doc)).toEqual({ paused: false, pausedBy: null });
});

test("approvedMerge with another headSha is null (A7)", async () => {
  const path = requestsPath();
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "v1",
      nextSeq: 3,
      requests: [
        {
          requestId: "req-000001",
          seq: 1,
          tool: "approve",
          args: {
            workItemId: "demo-item",
            pullNumber: 12,
            headSha: "0".repeat(40),
            reason: "Ship the demo item.",
          },
          argsSha256: "d".repeat(64),
          caller: "coordinator",
          requestedAt: "2026-10-26T10:00:00.000Z",
          state: "approved",
          decision: { seq: 2, author: "owner", decidedAt: "2026-10-26T11:00:00.000Z" },
        },
      ],
    }),
  );
  const doc = await readApprovals(path);
  expect(approvedMerge(doc, "demo-item", 12, "f".repeat(40))).toBeNull();
  const found = approvedMerge(doc, "demo-item", 12, "0".repeat(40));
  expect(found?.requestId).toBe("req-000001");
});

test("pendingRequests returns pending entries in seq order", async () => {
  const path = requestsPath();
  await recordApprove(path);
  const doc = await readApprovals(path);
  expect(pendingRequests(doc).map((entry) => entry.requestId)).toEqual(["req-000001"]);
});

test("checkApprovals rejects a file with a duplicated seq", () => {
  const doc = approvedDoc() as unknown as { requests: unknown[] };
  const second = { ...(doc.requests[0] as Record<string, unknown>) };
  expect(() =>
    checkApprovals(
      { schemaVersion: "v1", nextSeq: 5, requests: [doc.requests[0], second] },
      "requests",
    ),
  ).toThrow();
});

test("raw bytes on disk hold one JSON line per write", async () => {
  const path = requestsPath();
  await recordApprove(path);
  const text = readFileSync(path, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(JSON.parse(text) as unknown).toMatchObject({ schemaVersion: "v1", nextSeq: 2 });
});

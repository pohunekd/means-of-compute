// Approvals view tests (matrix row C10): the pause state, the merge
// triple match, and the absent file.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideRequest } from "../../src/approvals/decide.js";
import { recordRequest } from "../../src/approvals/store.js";
import { createApprovalsView } from "../../src/loop/approvals-view.js";

const HEAD = "a".repeat(40);

function fixedNow(): () => Date {
  return () => new Date("2026-10-28T00:00:00.000Z");
}

async function writeApprovedPause(path: string): Promise<void> {
  const recorded = await recordRequest(path, {
    tool: "pause_fleet",
    args: { action: "pause", reason: "Hold the fleet." },
    caller: "owner",
    now: fixedNow(),
    maxPending: 20,
  });
  if (recorded.kind !== "recorded") {
    throw new Error(`expected recorded, got ${recorded.kind}`);
  }
  const decided = await decideRequest(path, {
    requestId: recorded.request.requestId,
    decision: "approved",
    author: "owner",
    now: fixedNow(),
  });
  if (decided.kind !== "decided") {
    throw new Error(`expected decided, got ${decided.kind}`);
  }
}

async function writeApprovedMerge(path: string): Promise<void> {
  const recorded = await recordRequest(path, {
    tool: "approve",
    args: { workItemId: "gh-moc-5", pullNumber: 12, headSha: HEAD, reason: "Ship it." },
    caller: "owner",
    now: fixedNow(),
    maxPending: 20,
  });
  if (recorded.kind !== "recorded") {
    throw new Error(`expected recorded, got ${recorded.kind}`);
  }
  const decided = await decideRequest(path, {
    requestId: recorded.request.requestId,
    decision: "approved",
    author: "owner",
    now: fixedNow(),
  });
  if (decided.kind !== "decided") {
    throw new Error(`expected decided, got ${decided.kind}`);
  }
}

test("an approved pause reads paused and a matching triple reads approved (C10)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-approvals-view-"));
  try {
    const path = join(dir, "approval-requests.json");
    await writeApprovedPause(path);
    await writeApprovedMerge(path);
    const view = createApprovalsView(path);
    expect(await view.fleetPaused()).toBe(true);
    expect(await view.approvedMerge("gh-moc-5", 12, HEAD)).toBe(true);
    expect(await view.approvedMerge("gh-moc-5", 12, "b".repeat(40))).toBe(false);
    expect(await view.approvedMerge("gh-moc-5", 13, HEAD)).toBe(false);
    expect(await view.approvedMerge("gh-moc-6", 12, HEAD)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an absent file reads as not paused and not approved (C10)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-approvals-view-"));
  try {
    const view = createApprovalsView(join(dir, "approval-requests.json"));
    expect(await view.fleetPaused()).toBe(false);
    expect(await view.approvedMerge("gh-moc-5", 12, HEAD)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

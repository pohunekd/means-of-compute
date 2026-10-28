// decideRequest tests (matrix A8): deciding records the next seq,
// deciding again with the same state and author is unchanged, and a
// different decision afterwards is already-decided. X4 asserts the
// src/mcp/ boundary: no file there names approvals/decide or
// writeFileAtomic.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideRequest } from "../../src/approvals/decide.js";
import { readApprovals, recordRequest } from "../../src/approvals/store.js";

const APPROVE_ARGS = {
  workItemId: "demo-item",
  pullNumber: 12,
  headSha: "0".repeat(40),
  reason: "Ship the demo item.",
} as const;

function requestsPath(): string {
  return join(mkdtempSync(join(tmpdir(), "approvals-decide-")), "approval-requests.json");
}

function fixedNow(): () => Date {
  return () => new Date("2026-10-26T10:00:00.000Z");
}

async function recordedId(path: string): Promise<string> {
  const outcome = await recordRequest(path, {
    tool: "approve",
    args: { ...APPROVE_ARGS },
    caller: "coordinator",
    now: fixedNow(),
    maxPending: 20,
  });
  if (outcome.kind !== "recorded") {
    throw new Error(`expected recorded, got ${outcome.kind}`);
  }
  return outcome.request.requestId;
}

test("decide approve records decision seq nextSeq; same again is unchanged; reject after is refused (A8)", async () => {
  const path = requestsPath();
  const requestId = await recordedId(path);
  const before = await readApprovals(path);
  const decided = await decideRequest(path, {
    requestId,
    decision: "approved",
    author: "owner",
    now: fixedNow(),
  });
  if (decided.kind !== "decided") {
    throw new Error(`expected decided, got ${decided.kind}`);
  }
  expect(decided.request.decision?.seq).toBe(before.nextSeq);
  const after = await readApprovals(path);
  expect(after.nextSeq).toBe(before.nextSeq + 1);
  const same = await decideRequest(path, {
    requestId,
    decision: "approved",
    author: "owner",
    now: fixedNow(),
  });
  expect(same.kind).toBe("unchanged");
  const other = await decideRequest(path, {
    requestId,
    decision: "rejected",
    author: "owner",
    now: fixedNow(),
  });
  if (other.kind !== "refused") {
    throw new Error(`expected refused, got ${other.kind}`);
  }
  expect(other.code).toBe("already-decided");
});

test("a different author on an approved request is already-decided", async () => {
  const path = requestsPath();
  const requestId = await recordedId(path);
  await decideRequest(path, {
    requestId,
    decision: "approved",
    author: "owner",
    now: fixedNow(),
  });
  const outcome = await decideRequest(path, {
    requestId,
    decision: "approved",
    author: "second-owner",
    now: fixedNow(),
  });
  if (outcome.kind !== "refused") {
    throw new Error(`expected refused, got ${outcome.kind}`);
  }
  expect(outcome.code).toBe("already-decided");
});

test("an unknown request id is refused", async () => {
  const path = requestsPath();
  await recordedId(path);
  const outcome = await decideRequest(path, {
    requestId: "req-009999",
    decision: "approved",
    author: "owner",
    now: fixedNow(),
  });
  if (outcome.kind !== "refused") {
    throw new Error(`expected refused, got ${outcome.kind}`);
  }
  expect(outcome.code).toBe("unknown-request");
});

test("no file under src/mcp/ names the decide module or the atomic writer (X4)", () => {
  const dir = join(process.cwd(), "src", "mcp");
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    expect(text).not.toContain("approvals/decide");
    expect(text).not.toContain("writeFileAtomic");
  }
});

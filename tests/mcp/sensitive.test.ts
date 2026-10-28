// Sensitive tool tests (matrix X1-X3, X5): approve predicates, the
// pause_fleet round trip through decideRequest, and the L2 shape of the
// call-end line. Expected values come from A3, A4, A5 and L2.
import { expect, test } from "bun:test";
import { decideRequest } from "../../src/approvals/decide.js";
import { createMcpTestEnv, writeTestFile, type McpTestEnv } from "./env.js";
import { createTools } from "../../src/mcp/tools.ts";
import { createProtocol } from "../../src/mcp/protocol.ts";
import type { CallLog } from "../../src/mcp/call-log.ts";

function fixedNow(): () => Date {
  return () => new Date("2026-10-28T10:00:00.000Z");
}

function memoryLog(lines: unknown[]): CallLog {
  return {
    append(entry: Record<string, unknown>): Promise<void> {
      lines.push(entry);
      return Promise.resolve();
    },
  };
}

function reviewItem(id: string, pullNumber: number): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo-repo",
    title: `Work ${id}`,
    goal: `Do ${id}`,
    issue: 11,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "review",
    statusReason: null,
    assignedHostAlias: null,
    branch: "11-demo",
    pullNumber,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
  };
}

const HEAD_SHA = "a".repeat(40);

async function setupEnv(
  prefix: string,
): Promise<{ env: McpTestEnv; lines: unknown[]; storeText: string }> {
  const env = await createMcpTestEnv(prefix);
  const lines: unknown[] = [];
  const store = {
    schemaVersion: "v1",
    revision: 1,
    items: [reviewItem("demo-review", 7)],
    submissions: [],
  };
  await writeTestFile(env.storePath, store);
  await writeTestFile(env.registryPath, { sessions: [] });
  return { env, lines, storeText: await Bun.file(env.storePath).text() };
}

async function callTool(
  env: McpTestEnv,
  lines: unknown[],
  name: string,
  args: unknown,
): Promise<{ structured: Record<string, unknown>; ends: Record<string, unknown>[] }> {
  const protocol = createProtocol({
    tools: createTools({
      workConfigPath: env.workConfigPath,
      dispatcherConfigPath: env.dispatcherConfigPath,
      auditorConfigPath: env.auditorConfigPath,
      approvalsConfigPath: env.approvalsConfigPath,
    }),
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: memoryLog(lines),
    now: fixedNow(),
    runId: "run-x",
  });
  await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "sh", version: "1" },
      },
    }),
  );
  const raw = await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
  const parsed = JSON.parse(raw as string) as {
    result: { structuredContent: Record<string, unknown> };
  };
  const ends = lines.filter(
    (entry) => (entry as { event?: string }).event === "call-end",
  ) as Record<string, unknown>[];
  return { structured: parsed.result.structuredContent, ends };
}

async function fleetPayload(env: McpTestEnv, lines: unknown[]): Promise<Record<string, unknown>> {
  const { structured } = await callTool(env, lines, "fleet_status", {});
  return structured;
}

test("X1 approve on a review item records pending and lists the request (X1, A3, A4)", async () => {
  const { env, lines, storeText: beforeStore } = await setupEnv("mcp-x1-");
  const before = await Bun.file(env.requestsPath)
    .text()
    .catch(() => "");
  const { structured, ends } = await callTool(env, lines, "approve", {
    workItemId: "demo-review",
    pullNumber: 7,
    headSha: HEAD_SHA,
    reason: "Ship the demo change.",
  });
  expect(structured).toEqual({
    ok: true,
    requestId: "req-000001",
    state: "pending",
    outcome: "recorded",
  });
  const requestId = "req-000001";
  expect(ends[ends.length - 1]?.["summary"]).toEqual({ requestId, outcome: "recorded" });
  expect(ends[ends.length - 1]?.["code"]).toBeNull();
  const afterStore = await Bun.file(env.storePath).text();
  expect(afterStore).toBe(beforeStore);
  expect(before).toBe("");
  const fleet = await fleetPayload(env, lines);
  const pending = (fleet["fleet"] as { pendingRequests: readonly unknown[] }).pendingRequests;
  expect(pending).toEqual([
    { requestId, tool: "approve", requestedAt: "2026-10-28T10:00:00.000Z" },
  ]);
});

test("X2 pause_fleet records pending and only pauses after a decision (X2, A5)", async () => {
  const { env, lines } = await setupEnv("mcp-x2-");
  const { structured } = await callTool(env, lines, "pause_fleet", {
    action: "pause",
    reason: "Freeze new starts for the demo.",
  });
  expect(structured).toEqual({
    ok: true,
    requestId: "req-000001",
    state: "pending",
    outcome: "recorded",
  });
  const requestId = "req-000001";
  const paused = (await fleetPayload(env, lines))["fleet"] as {
    paused: boolean;
    pausedBy: unknown;
  };
  expect(paused.paused).toBe(false);
  expect(paused.pausedBy).toBeNull();
  const decided = await decideRequest(env.requestsPath, {
    requestId,
    decision: "approved",
    author: "owner",
    now: fixedNow(),
  });
  expect(decided.kind).toBe("decided");
  const settled = (await fleetPayload(env, lines))["fleet"] as {
    paused: boolean;
    pausedBy: { requestId: string; author: string; decidedAt: string };
  };
  expect(settled.paused).toBe(true);
  expect(settled.pausedBy).toEqual({
    requestId,
    author: "owner",
    decidedAt: "2026-10-28T10:00:00.000Z",
  });
});

test("X3 approve predicates refuse queued items and pull mismatches (X3, A4)", async () => {
  const { env, lines } = await setupEnv("mcp-x3-");
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 1,
    items: [
      { ...reviewItem("demo-review", 7), status: "queued", pullNumber: null, branch: null },
      reviewItem("demo-second", 9),
    ],
    submissions: [],
  });
  const queued = await callTool(env, lines, "approve", {
    workItemId: "demo-review",
    pullNumber: 7,
    headSha: HEAD_SHA,
    reason: "Ship the demo change.",
  });
  expect(queued.structured).toEqual({
    ok: false,
    error: {
      code: "not-in-review",
      message: "item demo-review is queued, not review",
      retryable: false,
    },
  });
  const mismatch = await callTool(env, lines, "approve", {
    workItemId: "demo-second",
    pullNumber: 10,
    headSha: HEAD_SHA,
    reason: "Ship the demo change.",
  });
  expect(mismatch.structured).toEqual({
    ok: false,
    error: {
      code: "pull-mismatch",
      message: "item demo-second has pull 9",
      retryable: false,
    },
  });
});

test("X5 the call-end summary carries the request id and no reason text (X5, L2)", async () => {
  const { env, lines } = await setupEnv("mcp-x5-");
  const reason = "Hold the fleet for the demo window.";
  const { structured, ends } = await callTool(env, lines, "pause_fleet", {
    action: "pause",
    reason,
  });
  expect(structured["ok"]).toBe(true);
  const requestId = structured["requestId"];
  expect(ends[ends.length - 1]?.["summary"]).toEqual({ requestId, outcome: "recorded" });
  expect(JSON.stringify(lines)).not.toContain(reason);
});

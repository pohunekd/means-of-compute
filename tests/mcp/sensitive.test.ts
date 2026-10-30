// Sensitive tool and approvals view tests (matrix X1, X7): resolve_session
// records one pending request with the sensitive class; the approvals view
// returns an approved resolve and ignores a pending one. Expected values
// come from #114 and the existing A3/A4/A6 consumption rules.
import { expect, test } from "bun:test";
import { createMcpTestEnv, writeTestFile, type McpTestEnv } from "./env.js";
import { createTools } from "../../src/mcp/tools.ts";
import { createProtocol } from "../../src/mcp/protocol.ts";
import { decideRequest } from "../../src/approvals/decide.ts";
import { createApprovalsView } from "../../src/loop/approvals-view.js";
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

test("X7 resolve_session records one sensitive request and nothing else (X7, A3, #114)", async () => {
  const { env, lines } = await setupEnv("mcp-x7-");
  const { structured, ends } = await callTool(env, lines, "resolve_session", {
    requestId: "demo-review:0",
    reason: "Session stalled on a hung start.",
  });
  expect(structured).toEqual({
    ok: true,
    requestId: "req-000001",
    state: "pending",
    outcome: "recorded",
  });
  const last = ends[ends.length - 1] as Record<string, unknown>;
  expect(last["tool"]).toBe("resolve_session");
  expect(last["class"]).toBe("sensitive");
  expect(last["summary"]).toEqual({ requestId: "req-000001", outcome: "recorded" });
  const stored = (await Bun.file(env.requestsPath).json()) as {
    readonly requests: readonly {
      readonly tool: string;
      readonly args: unknown;
      readonly state: string;
    }[];
  };
  expect(stored.requests).toHaveLength(1);
  expect(stored.requests[0]?.tool).toBe("resolve_session");
  expect(stored.requests[0]?.state).toBe("pending");
  expect(stored.requests[0]?.args).toEqual({
    requestId: "demo-review:0",
    reason: "Session stalled on a hung start.",
  });
});

test("X7 approvals view exposes an approved resolve and ignores a pending one (#114, A6)", async () => {
  const { env, lines } = await setupEnv("mcp-x7-view-");
  await callTool(env, lines, "resolve_session", {
    requestId: "demo-review:0",
    reason: "Resolve the stuck session.",
  });
  await callTool(env, lines, "resolve_session", {
    requestId: "demo-review:1",
    reason: "A second stuck session.",
  });
  const view = createApprovalsView(env.requestsPath);
  expect(await view.approvedResolves()).toEqual([]);
  const decided = await decideRequest(env.requestsPath, {
    requestId: "req-000001",
    decision: "approved",
    author: "owner",
    now: fixedNow(),
  });
  expect(decided.kind).toBe("decided");
  expect(await view.approvedResolves()).toEqual([
    { requestId: "demo-review:0", reason: "Resolve the stuck session." },
  ]);
});

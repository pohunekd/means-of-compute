// MCP protocol tests (matrix P1-P10): version echo, init gate,
// framing, errors, and the fleet_status R1 shape over temp configs.
import { expect, test } from "bun:test";
import { createMcpTestEnv, writeTestFile } from "./env.js";
import { createTools } from "../../src/mcp/tools.ts";
import { createProtocol } from "../../src/mcp/protocol.ts";
import type { CallLog } from "../../src/mcp/call-log.ts";
import type { Protocol, ToolDefinition, ToolOutcome } from "../../src/mcp/protocol.ts";

interface LogEntry {
  readonly event: string;
  readonly callId?: number;
  readonly tool?: string;
  readonly client?: unknown;
  readonly argsSha256?: string;
  readonly [key: string]: unknown;
}

function fixedNow(): () => Date {
  return () => new Date("2026-10-28T10:00:00.000Z");
}

function memoryLog(entries: LogEntry[]): CallLog {
  return {
    append(entry: Record<string, unknown>): Promise<void> {
      entries.push(entry as LogEntry);
      return Promise.resolve();
    },
  };
}

async function protocolWithTools(
  entries: LogEntry[],
  tools: readonly ToolDefinition[],
  runId = "run-1",
): Promise<Protocol> {
  await Promise.resolve();
  return createProtocol({
    tools,
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: memoryLog(entries),
    now: fixedNow(),
    runId,
  });
}

function initLine(id = 1, protocolVersion = "2025-11-25"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "sh", version: "1" },
    },
  });
}

async function init(protocol: Protocol, protocolVersion = "2025-11-25"): Promise<unknown> {
  const raw = await protocol.handleLine(initLine(1, protocolVersion));
  return JSON.parse(raw as string) as unknown;
}

function workItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo-repo",
    title: `Item ${id}`,
    goal: `Goal of ${id}`,
    issue: null,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
    ...overrides,
  };
}

function registryEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1",
    workItemId: "w1",
    repo: "example/demo-repo",
    hostAlias: "desktop",
    branch: "moc/w1",
    baseRef: "main",
    resume: false,
    model: { providerId: "meta-api", model: "muse-spark-1.3-contributor" },
    briefSha256: "0".repeat(64),
    sessionId: "session-1",
    worktree: "/tmp/wt",
    baseCommit: null,
    startedAt: "2026-10-28T10:00:00.000Z",
    cursor: null,
    unreachableCount: 0,
    lastSeenState: "running",
    lastSeenAt: "2026-10-28T10:00:00.000Z",
    cancelReason: null,
    terminal: null,
    resolvedAt: null,
    revision: 0,
    ...overrides,
  };
}

test("P1 initialize echoes a supported version (P1)", async () => {
  const entries: LogEntry[] = [];
  const protocol = await protocolWithTools(entries, []);
  const result = (await init(protocol, "2025-06-18")) as {
    result: { protocolVersion: string };
  };
  expect(result.result.protocolVersion).toBe("2025-06-18");
});

test("F10 an empty client name initializes with client null (F10, P2)", async () => {
  const entries: LogEntry[] = [];
  const protocol = await protocolWithTools(entries, []);
  const raw = await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "", version: "1" },
      },
    }),
  );
  const parsed = JSON.parse(raw as string) as {
    result: { protocolVersion: string };
  };
  expect(parsed.result.protocolVersion).toBe("2025-11-25");
  const session = entries.find((entry) => entry.event === "session-init");
  expect(session?.["client"]).toBeNull();
});

test("P2 initialize falls back to latest on unknown version (P2)", async () => {
  const entries: LogEntry[] = [];
  const protocol = await protocolWithTools(entries, []);
  const result = (await init(protocol, "2099-01-01")) as {
    result: { protocolVersion: string };
  };
  expect(result.result.protocolVersion).toBe("2025-11-25");
});

test("P3 tools/call before initialize is rejected (P3)", async () => {
  const entries: LogEntry[] = [];
  const protocol = await protocolWithTools(entries, []);
  const raw = await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fleet_status", arguments: {} },
    }),
  );
  const parsed = JSON.parse(raw as string) as {
    error: { code: number; message: string };
  };
  expect(parsed.error.code).toBe(-32600);
  expect(parsed.error.message).toBe("server not initialized");
});

test("P4 invalid JSON gives a parse error (P4)", async () => {
  const entries: LogEntry[] = [];
  const protocol = await protocolWithTools(entries, []);
  const raw = await protocol.handleLine("not json");
  const parsed = JSON.parse(raw as string) as {
    id: null;
    error: { code: number; message: string };
  };
  expect(parsed.id).toBeNull();
  expect(parsed.error.code).toBe(-32700);
  expect(parsed.error.message).toBe("parse error");
});

test("P5 batch arrays are rejected (P5)", async () => {
  const entries: LogEntry[] = [];
  const protocol = await protocolWithTools(entries, []);
  const raw = await protocol.handleLine("[]");
  const parsed = JSON.parse(raw as string) as {
    id: null;
    error: { code: number; message: string };
  };
  expect(parsed.id).toBeNull();
  expect(parsed.error.code).toBe(-32600);
  expect(parsed.error.message).toBe("batch not supported");
});

test("P6 unknown method and notification handling (P6)", async () => {
  const entries: LogEntry[] = [];
  const protocol = await protocolWithTools(entries, []);
  await init(protocol);
  const raw = await protocol.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "nope/method", params: {} }),
  );
  const parsed = JSON.parse(raw as string) as {
    error: { code: number; message: string };
  };
  expect(parsed.error.code).toBe(-32601);
  expect(parsed.error.message).toBe("method not found");
  const note = await protocol.handleLine(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }),
  );
  expect(note).toBeNull();
});

test("F4 an oversized line is discarded while it streams (F4, P1)", async () => {
  const { createLineSplitter } = await import("../../src/mcp/protocol.ts");
  const delivered: string[] = [];
  let tooLargeCount = 0;
  const splitter = createLineSplitter(
    1024,
    (line: string) => {
      delivered.push(line);
    },
    () => {
      tooLargeCount += 1;
    },
  );
  for (let n = 0; n < 64; n += 1) {
    splitter.push("x".repeat(4096));
  }
  expect(tooLargeCount).toBe(1);
  splitter.push("\n");
  const valid = initLine();
  splitter.push(`${valid}\n`);
  expect(tooLargeCount).toBe(1);
  expect(delivered).toEqual([valid]);
});

test("P7 unknown tool is a JSON-RPC error plus a protocol-error line (P7)", async () => {
  const entries: LogEntry[] = [];
  const env = await createMcpTestEnv("mcp-p7-");
  const protocol = await protocolWithTools(entries, createTools(env));
  await init(protocol);
  const raw = await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    }),
  );
  const parsed = JSON.parse(raw as string) as {
    error: { code: number; message: string };
  };
  expect(parsed.error.code).toBe(-32602);
  expect(parsed.error.message).toContain("Unknown tool: nope");
  const errors = entries.filter((entry) => entry.event === "protocol-error");
  expect(errors.length).toBe(1);
});

test("F3 a too-large line is answered in order and logged (F3, T4, L1)", async () => {
  const entries: LogEntry[] = [];
  const env = await createMcpTestEnv("mcp-f3-");
  const slowGate = (() => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release: () => release?.() };
  })();
  const slowTool: ToolDefinition = {
    name: "slow_tool",
    title: "Slow tool",
    toolClass: "read" as const,
    description: "[read] test tool",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    validate: () => null,
    run: async (): Promise<ToolOutcome> => {
      await slowGate.gate;
      return { payload: { ok: true }, summary: null, detail: null };
    },
  };
  const tools: ToolDefinition[] = [
    ...createTools({
      workConfigPath: env.workConfigPath,
      dispatcherConfigPath: env.dispatcherConfigPath,
    }),
    slowTool,
  ];
  const protocol = await protocolWithTools(entries, tools);
  const maxBytes = Buffer.byteLength(initLine(), "utf8");
  const { createLineSplitter } = await import("../../src/mcp/protocol.ts");
  const pending: Promise<string | null>[] = [];
  const splitter = createLineSplitter(
    maxBytes,
    (line: string) => {
      pending.push(protocol.handleLine(line));
    },
    () => {
      pending.push(protocol.handleTooLarge());
    },
  );
  await init(protocol);
  splitter.push(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow_tool", arguments: {} } })}\n${"x".repeat(maxBytes + 1)}\n`,
  );
  await Bun.sleep(10);
  const completed: string[] = [];
  for (const task of pending) {
    void task.then((raw) => {
      if (raw !== null) {
        completed.push(raw);
      }
    });
  }
  slowGate.release();
  await Promise.all(pending);
  expect(completed.length).toBe(2);
  expect((JSON.parse(completed[0] as string) as { id: number }).id).toBe(2);
  const second = JSON.parse(completed[1] as string) as {
    id: null;
    error: { code: number; message: string };
  };
  expect(second.id).toBeNull();
  expect(second.error.code).toBe(-32600);
  expect(second.error.message).toContain("message too large");
  const errors = entries.filter((entry) => entry.event === "protocol-error");
  expect(errors.length).toBe(1);
  expect(errors[0]?.["jsonrpcCode"]).toBe(-32600);
});

test("an aborted protocol answers no too-large line (H8, R2-7)", async () => {
  const entries: LogEntry[] = [];
  const env = await createMcpTestEnv("mcp-h8-");
  const protocol = await protocolWithTools(
    entries,
    createTools({
      workConfigPath: env.workConfigPath,
      dispatcherConfigPath: env.dispatcherConfigPath,
    }),
  );
  protocol.abort();
  expect(await protocol.handleLine(initLine())).toBeNull();
  expect(await protocol.handleTooLarge()).toBeNull();
  await protocol.drain();
  expect(entries.filter((entry) => entry.event === "protocol-error").length).toBe(0);
});

test("P8 oversized line is rejected and the next line is answered (P8)", async () => {
  const entries: LogEntry[] = [];
  const env = await createMcpTestEnv("mcp-p8-");
  const { createLineSplitter } = await import("../../src/mcp/protocol.ts");
  const protocol = await protocolWithTools(
    entries,
    createTools({
      workConfigPath: env.workConfigPath,
      dispatcherConfigPath: env.dispatcherConfigPath,
    }),
  );
  const pending: Promise<string | null>[] = [];
  const sync: string[] = [];
  const maxBytes = Buffer.byteLength(initLine(), "utf8");
  const splitter = createLineSplitter(
    maxBytes,
    (line: string) => {
      pending.push(protocol.handleLine(line));
    },
    () => {
      sync.push(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "message too large" },
        }),
      );
    },
  );
  splitter.push(`${"x".repeat(maxBytes + 1)}\n`);
  splitter.push(`${initLine()}\n`);
  const settled = (await Promise.all(pending)).filter((raw): raw is string => raw !== null);
  const responses = [...sync, ...settled];
  expect(responses.length).toBe(2);
  const first = JSON.parse(responses[0] as string) as {
    error: { code: number; message: string };
  };
  expect(first.error.code).toBe(-32600);
  expect(first.error.message).toContain("message too large");
  const second = JSON.parse(responses[1] as string) as {
    result: { protocolVersion: string };
  };
  expect(second.result.protocolVersion).toBe("2025-11-25");
});

test("P9 fleet_status counts running items and open sessions (P9, R1)", async () => {
  const env = await createMcpTestEnv("mcp-p9-");
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 3,
    items: [
      workItem("w-running", { status: "running", assignedHostAlias: "desktop" }),
      workItem("w-queued", { status: "queued" }),
      workItem("w-done", { status: "done" }),
    ],
    submissions: [],
  });
  await writeTestFile(env.registryPath, {
    sessions: [
      registryEntry({ requestId: "req-1", hostAlias: "desktop", terminal: null }),
      registryEntry({
        requestId: "req-2",
        workItemId: "w-done",
        hostAlias: "laptop-a",
        sessionId: "session-2",
        terminal: {
          state: "finished",
          observedAt: "2026-10-28T10:00:00.000Z",
          seconds: 1,
          usage: null,
          usageValid: true,
          detail: "",
          ledgerAppended: true,
        },
      }),
    ],
  });
  const entries: LogEntry[] = [];
  const protocol = await protocolWithTools(
    entries,
    createTools({
      workConfigPath: env.workConfigPath,
      dispatcherConfigPath: env.dispatcherConfigPath,
    }),
  );
  await init(protocol);
  const raw = await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "fleet_status", arguments: {} },
    }),
  );
  const parsed = JSON.parse(raw as string) as {
    result: {
      structuredContent: {
        ok: boolean;
        hosts: readonly { hostAlias: string; runningItems: number; openSessions: number }[];
        work: { counts: Record<string, number> };
        hostState: { available: boolean };
      };
    };
  };
  const payload = parsed.result.structuredContent;
  expect(payload.hosts).toEqual([{ hostAlias: "desktop", runningItems: 1, openSessions: 1 }]);
  expect(payload.work.counts["running"]).toBe(1);
  expect(payload.work.counts["queued"]).toBe(1);
  expect(payload.work.counts["done"]).toBe(1);
  expect(payload.hostState.available).toBe(false);
});

test("P10 two calls serialize in order (P10, T4)", async () => {
  const order: string[] = [];
  const tools: ToolDefinition[] = [1, 2].map((index) => ({
    name: `tool_${index === 1 ? "one" : "two"}`,
    title: `Tool ${String(index)}`,
    toolClass: "read" as const,
    description: "[read] test tool",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    validate: () => null,
    run: (args: unknown): Promise<ToolOutcome> => {
      order.push(`run-${String(index)}:${JSON.stringify(args)}`);
      const outcome: ToolOutcome = { payload: { ok: true }, summary: null, detail: null };
      return new Promise((resolve) => {
        resolve(outcome);
      });
    },
  }));
  const entries: LogEntry[] = [];
  const protocol = await protocolWithTools(entries, tools);
  await init(protocol);
  const first = protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tool_one", arguments: {} },
    }),
  );
  const second = protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tool_two", arguments: {} },
    }),
  );
  const [rawFirst, rawSecond] = await Promise.all([first, second]);
  const parsedFirst = JSON.parse(rawFirst as string) as { id: number };
  const parsedSecond = JSON.parse(rawSecond as string) as { id: number };
  expect(parsedFirst.id).toBe(1);
  expect(parsedSecond.id).toBe(2);
  expect(order).toEqual(["run-1:{}", "run-2:{}"]);
  const starts = entries.filter((entry) => entry.event === "call-start");
  const ends = entries.filter((entry) => entry.event === "call-end");
  expect(starts.length).toBe(2);
  expect(ends.length).toBe(2);
  expect(entries.map((entry) => entry.event)).toEqual([
    "session-init",
    "call-start",
    "call-end",
    "call-start",
    "call-end",
  ]);
});

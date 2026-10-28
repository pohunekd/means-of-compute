// MCP call log tests (matrix CL1-CL3): one call gives one start and one
// end line with the same callId and the L1 fields; a failed append latches
// the log; a hostile clientInfo name is never logged raw.
import { expect, test } from "bun:test";
import { createMcpTestEnv } from "../../tests/mcp/env.js";
import { openCallLog } from "../../src/mcp/call-log.ts";
import { createTools } from "../../src/mcp/tools.ts";
import { createProtocol } from "../../src/mcp/protocol.ts";
import type { CallLog } from "../../src/mcp/call-log.ts";

interface LogEntry {
  readonly event: string;
  readonly callId?: number;
  readonly tool?: string;
  readonly class?: string;
  readonly client?: unknown;
  readonly protocolVersion?: string;
  readonly argsSha256?: string;
  readonly argsBytes?: number;
  readonly outcome?: string;
  readonly code?: string | null;
  readonly summary?: unknown;
  readonly detail?: unknown;
  readonly ts?: string;
  readonly run?: string;
  readonly caller?: string;
  readonly durationMs?: number;
  readonly [key: string]: unknown;
}

function backing(entries: LogEntry[]): CallLog {
  return {
    append(entry: Record<string, unknown>): Promise<void> {
      entries.push(entry as LogEntry);
      return Promise.resolve();
    },
  };
}

function initLine(clientName = "sh"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    },
  });
}

test("CL1 one call gives one start and one end line with the same callId (CL1, L1)", async () => {
  const env = await createMcpTestEnv("mcp-cl1-");
  const entries: LogEntry[] = [];
  const protocol = createProtocol({
    tools: createTools({
      workConfigPath: env.workConfigPath,
      dispatcherConfigPath: env.dispatcherConfigPath,
      auditorConfigPath: env.auditorConfigPath,
    }),
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: backing(entries),
    now: () => new Date("2026-10-28T10:00:00.000Z"),
    runId: "run-cl1",
  });
  await protocol.handleLine(initLine());
  await Bun.write(
    env.storePath,
    JSON.stringify({ schemaVersion: "v1", revision: 0, items: [], submissions: [] }),
  );
  await Bun.write(env.registryPath, JSON.stringify({ sessions: [] }));
  await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "fleet_status", arguments: {} },
    }),
  );
  const starts = entries.filter((entry) => entry.event === "call-start");
  const ends = entries.filter((entry) => entry.event === "call-end");
  expect(starts.length).toBe(1);
  expect(ends.length).toBe(1);
  expect(starts[0]?.callId).toBe(1);
  expect(ends[0]?.callId).toBe(1);
  const start = starts[0] as LogEntry;
  expect(start.tool).toBe("fleet_status");
  expect(start.class).toBe("read");
  expect(typeof start.argsSha256).toBe("string");
  expect(typeof start.argsBytes).toBe("number");
  expect(typeof start.ts).toBe("string");
  expect(start.run).toBe("run-cl1");
  expect(start.caller).toBe("coordinator");
  const end = ends[0] as LogEntry;
  expect(end.tool).toBe("fleet_status");
  expect(end.outcome).toBe("ok");
  expect(end.code).toBeNull();
  expect(typeof end.durationMs).toBe("number");
  expect(end.detail).toBeNull();
});

test("CL2 a failed append latches the log and the handler never runs (CL2, L3)", async () => {
  let calls = 0;
  const failing: CallLog = {
    append(): Promise<void> {
      return Promise.reject(new Error("disk full"));
    },
  };
  const protocol = createProtocol({
    tools: [
      {
        name: "fleet_status",
        title: "Fleet status",
        toolClass: "read",
        description: "[read] test",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        validate: () => null,
        run: () => {
          calls += 1;
          return Promise.resolve({ payload: { ok: true }, summary: null, detail: null });
        },
      },
    ],
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: failing,
    now: () => new Date("2026-10-28T10:00:00.000Z"),
    runId: "run-cl2",
  });
  await protocol.handleLine(initLine());
  const raw = await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "fleet_status", arguments: {} },
    }),
  );
  const parsed = JSON.parse(raw as string) as {
    result: { structuredContent: { ok: boolean; error: { code: string } } };
  };
  expect(parsed.result.structuredContent.ok).toBe(false);
  expect(parsed.result.structuredContent.error.code).toBe("call-log-unavailable");
  expect(calls).toBe(0);
});

test("CL3 a hostile client name is logged as null client (CL3, P2, L2)", async () => {
  const entries: LogEntry[] = [];
  const env = await createMcpTestEnv("mcp-cl3-");
  const protocol = createProtocol({
    tools: createTools({
      workConfigPath: env.workConfigPath,
      dispatcherConfigPath: env.dispatcherConfigPath,
      auditorConfigPath: env.auditorConfigPath,
    }),
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: backing(entries),
    now: () => new Date("2026-10-28T10:00:00.000Z"),
    runId: "run-cl3",
  });
  await protocol.handleLine(initLine("a\nb"));
  const session = entries.find((entry) => entry.event === "session-init");
  expect(session?.client).toBeNull();
  expect(JSON.stringify(entries)).not.toContain("a\nb");
});

test("file call log writes whole JSON lines (L1)", async () => {
  const env = await createMcpTestEnv("mcp-clfile-");
  const log = await openCallLog(env.callLogPath);
  await log.append({ ts: "t", event: "server-start", run: "r", caller: "c", pid: 1 });
  await log.close();
  const text = await Bun.file(env.callLogPath).text();
  const lines = text.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(1);
  const parsed = JSON.parse(lines[0] as string) as { event: string };
  expect(parsed.event).toBe("server-start");
});

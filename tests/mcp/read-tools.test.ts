// MCP read tools tests (matrix R1-R5): list_work filtering and audit_results
// verdict handling. Expected values come from R2 and R3 rules.
import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createMcpTestEnv, writeTestFile } from "./env.js";
import { createTools } from "../../src/mcp/tools.ts";
import { createProtocol } from "../../src/mcp/protocol.ts";
import type { CallLog } from "../../src/mcp/call-log.ts";

function fixedNow(): () => Date {
  return () => new Date("2026-10-28T10:00:00.000Z");
}

function memoryLog(): CallLog {
  return {
    append(): Promise<void> {
      return Promise.resolve();
    },
  };
}

async function loadFixture(path: string): Promise<unknown> {
  const text = await Bun.file(path).text();
  return JSON.parse(text) as unknown;
}

async function setupProtocol(
  env: ReturnType<typeof createMcpTestEnv> extends Promise<infer T> ? T : never,
): Promise<ReturnType<typeof createProtocol>> {
  const tools = createTools({
    workConfigPath: env.workConfigPath,
    dispatcherConfigPath: env.dispatcherConfigPath,
    auditorConfigPath: env.auditorConfigPath,
      approvalsConfigPath: env.approvalsConfigPath,
  });
  const protocol = createProtocol({
    tools,
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: memoryLog(),
    now: fixedNow(),
    runId: "run-1",
  });
  const init = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "sh", version: "1" },
    },
  });
  await protocol.handleLine(init);
  return protocol;
}

function callLine(id: number, name: string, args: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

test("R1 list_work filters by status to one parked row (R1, R2)", async () => {
  const env = await createMcpTestEnv("mcp-r1-");
  const w1 = await loadFixture("contracts/v1/fixtures/work-item.json");
  const w2 = await loadFixture("contracts/v1/fixtures/work-item-parked.json");
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 3,
    items: [w1, w2],
    submissions: [],
  });
  await writeTestFile(env.registryPath, { sessions: [] });
  const protocol = await setupProtocol(env);
  const raw = await protocol.handleLine(callLine(2, "list_work", { status: ["parked"] }));
  const parsed = JSON.parse(raw as string) as {
    result: {
      structuredContent: {
        ok: boolean;
        revision: number;
        items: readonly Record<string, unknown>[];
      };
    };
  };
  expect(parsed.result.structuredContent.ok).toBe(true);
  expect(parsed.result.structuredContent.revision).toBe(3);
  expect(parsed.result.structuredContent.items.length).toBe(1);
  expect(parsed.result.structuredContent.items[0]).toEqual({
    id: "w2-parked-example",
    repo: "pohunekd/means-of-compute",
    title: "Park a stalled task with its reason",
    issue: 17,
    status: "parked",
    statusReason: "no newly met DoD item for 3 rounds",
    assignedHostAlias: null,
    branch: "17-loop-stall",
    pullNumber: null,
    dependencies: ["w1-contracts"],
    dod: { done: 0, total: 1 },
    retryCount: 1,
    stallRounds: 3,
    modelRouting: {
      preferredModel: "meta/muse-glimmer-30b",
      attempts: 2,
      fallbackUsed: false,
    },
  });
});

test("R2 list_work with empty args is invalid-arguments required (R2)", async () => {
  const env = await createMcpTestEnv("mcp-r2-");
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 0,
    items: [],
    submissions: [],
  });
  await writeTestFile(env.registryPath, { sessions: [] });
  const protocol = await setupProtocol(env);
  const raw = await protocol.handleLine(callLine(2, "list_work", {}));
  const parsed = JSON.parse(raw as string) as {
    result: {
      structuredContent: unknown;
    };
  };
  expect(parsed.result.structuredContent).toEqual({
    ok: false,
    error: {
      code: "invalid-arguments",
      message: "invalid arguments at / (required)",
      retryable: false,
      path: "/",
      keyword: "required",
    },
  });
});

test("R3 audit_results lists fixture verdict with counts 0,0,1 (R3)", async () => {
  const env = await createMcpTestEnv("mcp-r3-");
  const w1 = await loadFixture("contracts/v1/fixtures/work-item.json");
  // Use demo-a as work item id to match fixture verdict
  const demoA = {
    schemaVersion: "v1",
    id: "demo-a",
    repo: "example/demo-repo",
    title: "Demo A",
    goal: "Demo",
    issue: 1,
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
  };
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 1,
    items: [w1, demoA],
    submissions: [],
  });
  await writeTestFile(env.registryPath, { sessions: [] });
  // Copy committed verdict to temp verdict dir
  const fixtureText = await Bun.file(
    "tests/fixtures/mcp/verdicts/demo-a/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
  ).text();
  const fixture = JSON.parse(fixtureText) as { headSha: string };
  await mkdir(join(env.verdictDir, "demo-a"), { recursive: true });
  await Bun.write(join(env.verdictDir, "demo-a", `${fixture.headSha}.json`), fixtureText);
  const protocol = await setupProtocol(env);
  const raw = await protocol.handleLine(callLine(2, "audit_results", { workItemId: "demo-a" }));
  const parsed = JSON.parse(raw as string) as {
    result: {
      structuredContent: {
        ok: boolean;
        workItemId: string;
        verdicts: readonly {
          headSha: string;
          counts: { high: number; medium: number; low: number };
        }[];
      };
    };
  };
  expect(parsed.result.structuredContent.ok).toBe(true);
  expect(parsed.result.structuredContent.workItemId).toBe("demo-a");
  expect(parsed.result.structuredContent.verdicts.length).toBe(1);
  expect(parsed.result.structuredContent.verdicts[0]?.headSha).toBe(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  expect(parsed.result.structuredContent.verdicts[0]?.counts).toEqual({
    high: 0,
    medium: 0,
    low: 1,
  });
});

test("R4 audit_results with bad counts is verdict-invalid (R4)", async () => {
  const env = await createMcpTestEnv("mcp-r4-");
  const demoA = {
    schemaVersion: "v1",
    id: "demo-a",
    repo: "example/demo-repo",
    title: "Demo A",
    goal: "Demo",
    issue: 1,
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
  };
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 1,
    items: [demoA],
    submissions: [],
  });
  await writeTestFile(env.registryPath, { sessions: [] });
  const badSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const badVerdict = {
    schemaVersion: "v1",
    repo: "example/demo-repo",
    workItemId: "demo-a",
    pullNumber: 1,
    headSha: badSha,
    authorModels: ["meta/muse-glimmer-30b"],
    auditorModel: "muse-spark-1.3-contributor",
    counts: { high: 1, medium: 0, low: 0 },
    findings: [
      {
        severity: "low",
        location: "src/demo.ts:1",
        defect: "defect",
        scenario: "scenario",
        fixDirection: "fix",
      },
    ],
  };
  await mkdir(join(env.verdictDir, "demo-a"), { recursive: true });
  await Bun.write(join(env.verdictDir, "demo-a", `${badSha}.json`), JSON.stringify(badVerdict));
  const protocol = await setupProtocol(env);
  const raw = await protocol.handleLine(callLine(2, "audit_results", { workItemId: "demo-a" }));
  const parsed = JSON.parse(raw as string) as {
    result: {
      structuredContent: { ok: boolean; error: { code: string; headSha: string; message: string } };
    };
  };
  expect(parsed.result.structuredContent.ok).toBe(false);
  expect(parsed.result.structuredContent.error.code).toBe("verdict-invalid");
  expect(parsed.result.structuredContent.error.headSha).toBe(badSha);
  expect(parsed.result.structuredContent.error.message).toBe(
    `verdict ${badSha} counts disagree with its findings`,
  );
});

test("R5 audit_results unknown id is unknown-work-item (R5)", async () => {
  const env = await createMcpTestEnv("mcp-r5-");
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 0,
    items: [],
    submissions: [],
  });
  await writeTestFile(env.registryPath, { sessions: [] });
  const protocol = await setupProtocol(env);
  const raw = await protocol.handleLine(
    callLine(2, "audit_results", { workItemId: "no-such-item" }),
  );
  const parsed = JSON.parse(raw as string) as {
    result: { structuredContent: { ok: boolean; error: { code: string; message: string } } };
  };
  expect(parsed.result.structuredContent.ok).toBe(false);
  expect(parsed.result.structuredContent.error.code).toBe("unknown-work-item");
  expect(parsed.result.structuredContent.error.message).toBe("unknown work item no-such-item");
});

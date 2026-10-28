// submit_work tests (matrix U1-U11): predicates, replay, cycle, store
// full, busy lock, and the call log check. Expected values come from S2.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMcpTestEnv, writeTestFile } from "./env.js";
import { createTools } from "../../src/mcp/tools.js";
import { createProtocol } from "../../src/mcp/protocol.js";
import type { CallLog } from "../../src/mcp/call-log.ts";

function fixedNow(): () => Date {
  return () => new Date("2026-10-28T10:00:00.000Z");
}

function memoryLog(): { log: CallLog; lines: unknown[] } {
  const lines: unknown[] = [];
  return {
    lines,
    log: {
      append(entry: Record<string, unknown>): Promise<void> {
        lines.push(entry);
        return Promise.resolve();
      },
    },
  };
}

async function loadFixture(path: string): Promise<{ items: Record<string, unknown>[] }> {
  const text = await Bun.file(path).text();
  return JSON.parse(text) as { items: Record<string, unknown>[] };
}

async function setup(submitArgs: unknown): Promise<{
  readonly structured: Record<string, unknown>;
  readonly store: Record<string, unknown> | null;
  readonly lines: unknown[];
}> {
  const env = await createMcpTestEnv("mcp-submit-");
  const { log, lines } = memoryLog();
  const tools = createTools({
    workConfigPath: env.workConfigPath,
    dispatcherConfigPath: env.dispatcherConfigPath,
    auditorConfigPath: env.auditorConfigPath,
  });
  const protocol = createProtocol({
    tools,
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: log,
    now: fixedNow(),
    runId: "run-submit",
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
      params: { name: "submit_work", arguments: submitArgs },
    }),
  );
  const parsed = JSON.parse(raw as string) as {
    result: { structuredContent: Record<string, unknown> };
  };
  let store: Record<string, unknown> | null = null;
  if (existsSync(env.storePath)) {
    store = JSON.parse(await Bun.file(env.storePath).text()) as Record<string, unknown>;
  }
  return { structured: parsed.result.structuredContent, store, lines };
}

function errorOf(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload["error"] ?? {}) as Record<string, unknown>;
}

test("U1 good-dag writes three items and one submission at revision 1 (U1)", async () => {
  const fixture = await loadFixture("tests/fixtures/mcp/good-dag.json");
  const { structured, store } = await setup({ items: fixture.items });
  expect(structured["ok"]).toBe(true);
  expect(structured["itemIds"]).toEqual(["demo-a", "demo-b", "demo-c"]);
  expect(structured["replayed"]).toBe(false);
  expect(typeof structured["submissionId"]).toBe("string");
  expect((structured["submissionId"] as string).startsWith("sub-")).toBe(true);
  expect(store).not.toBeNull();
  const items = (store as Record<string, unknown>)["items"] as unknown[];
  const submissions = (store as Record<string, unknown>)["submissions"] as Record<
    string,
    unknown
  >[];
  expect(items.map((entry) => (entry as { id: string }).id)).toEqual([
    "demo-a",
    "demo-b",
    "demo-c",
  ]);
  expect(submissions.length).toBe(1);
  expect(submissions[0]?.["itemIds"]).toEqual(["demo-a", "demo-b", "demo-c"]);
  expect((store as Record<string, unknown>)["revision"]).toBe(1);
});

test("U2 same args replay with the same id at revision 1 (U2)", async () => {
  const env = await createMcpTestEnv("mcp-u2-");
  const { log } = memoryLog();
  const tools = createTools({
    workConfigPath: env.workConfigPath,
    dispatcherConfigPath: env.dispatcherConfigPath,
    auditorConfigPath: env.auditorConfigPath,
  });
  const protocol = createProtocol({
    tools,
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: log,
    now: fixedNow(),
    runId: "run-u2",
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
  const fixture = await loadFixture("tests/fixtures/mcp/good-dag.json");
  const call = (id: number): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "submit_work", arguments: { items: fixture.items } },
    });
  const first = JSON.parse((await protocol.handleLine(call(2))) as string) as {
    result: { structuredContent: Record<string, unknown> };
  };
  const second = JSON.parse((await protocol.handleLine(call(3))) as string) as {
    result: { structuredContent: Record<string, unknown> };
  };
  expect(first.result.structuredContent["ok"]).toBe(true);
  expect(second.result.structuredContent["ok"]).toBe(true);
  expect(second.result.structuredContent["replayed"]).toBe(true);
  expect(second.result.structuredContent["submissionId"]).toBe(
    first.result.structuredContent["submissionId"],
  );
  expect(second.result.structuredContent["itemIds"]).toEqual(["demo-a", "demo-b", "demo-c"]);
  const store = JSON.parse(await Bun.file(env.storePath).text()) as { revision: number };
  expect(store.revision).toBe(1);
});

test("U3 same ids with a changed title are refused as id-exists (U3)", async () => {
  const env = await createMcpTestEnv("mcp-u3-");
  const { log } = memoryLog();
  const tools = createTools({
    workConfigPath: env.workConfigPath,
    dispatcherConfigPath: env.dispatcherConfigPath,
    auditorConfigPath: env.auditorConfigPath,
  });
  const protocol = createProtocol({
    tools,
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: log,
    now: fixedNow(),
    runId: "run-u3",
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
  const fixture = await loadFixture("tests/fixtures/mcp/good-dag.json");
  await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "submit_work", arguments: { items: fixture.items } },
    }),
  );
  const changed = fixture.items.map((entry) =>
    entry["id"] === "demo-a" ? { ...entry, title: "Changed title" } : entry,
  );
  const raw = await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "submit_work", arguments: { items: changed } },
    }),
  );
  const parsed = JSON.parse(raw as string) as {
    result: { structuredContent: Record<string, unknown> };
  };
  expect(parsed.result.structuredContent["ok"]).toBe(false);
  expect(errorOf(parsed.result.structuredContent)).toEqual({
    code: "id-exists",
    message: "ids already in the store: demo-a, demo-b, demo-c",
    retryable: false,
    ids: ["demo-a", "demo-b", "demo-c"],
  });
});

test("U4 cyclic dag is refused and the store file stays absent (U4)", async () => {
  const env = await createMcpTestEnv("mcp-u4-");
  const { log } = memoryLog();
  const tools = createTools({
    workConfigPath: env.workConfigPath,
    dispatcherConfigPath: env.dispatcherConfigPath,
    auditorConfigPath: env.auditorConfigPath,
  });
  const protocol = createProtocol({
    tools,
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: log,
    now: fixedNow(),
    runId: "run-u4",
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
  const fixture = await loadFixture("tests/fixtures/mcp/cyclic-dag.json");
  const raw = await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "submit_work", arguments: { items: fixture.items } },
    }),
  );
  const parsed = JSON.parse(raw as string) as {
    result: { structuredContent: Record<string, unknown> };
  };
  expect(parsed.result.structuredContent["ok"]).toBe(false);
  expect(errorOf(parsed.result.structuredContent)).toEqual({
    code: "dag-cycle",
    message:
      "cycle edge demo-cyc-c -> demo-cyc-a (demo-cyc-a -> demo-cyc-b -> demo-cyc-c -> demo-cyc-a)",
    retryable: false,
    edge: { from: "demo-cyc-c", to: "demo-cyc-a" },
    cycle: ["demo-cyc-a", "demo-cyc-b", "demo-cyc-c", "demo-cyc-a"],
  });
  expect(existsSync(env.storePath)).toBe(false);
});

test("U5 unknown dependency is refused (U5)", async () => {
  const fixture = await loadFixture("tests/fixtures/mcp/good-dag.json");
  const items = fixture.items.map((entry) =>
    entry["id"] === "demo-b" ? { ...entry, dependencies: ["no-such-item"] } : entry,
  );
  const { structured, store } = await setup({ items });
  expect(structured["ok"]).toBe(false);
  expect(errorOf(structured)).toEqual({
    code: "unknown-dependency",
    message: "unknown dependency demo-b -> no-such-item",
    retryable: false,
    edge: { from: "demo-b", to: "no-such-item" },
  });
  expect(store).toBeNull();
});

test("U6 a new item depending on a stored item is accepted (U6)", async () => {
  const env = await createMcpTestEnv("mcp-u6-");
  const { log } = memoryLog();
  const tools = createTools({
    workConfigPath: env.workConfigPath,
    dispatcherConfigPath: env.dispatcherConfigPath,
    auditorConfigPath: env.auditorConfigPath,
  });
  const protocol = createProtocol({
    tools,
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: log,
    now: fixedNow(),
    runId: "run-u6",
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
  const call = (id: number, args: unknown): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "submit_work", arguments: args },
    });
  const fixture = await loadFixture("tests/fixtures/mcp/good-dag.json");
  await protocol.handleLine(call(2, { items: [fixture.items[0]] }));
  const follow = {
    ...(fixture.items[1] as Record<string, unknown>),
    dependencies: ["demo-a"],
  };
  const raw = await protocol.handleLine(call(3, { items: [follow] }));
  const parsed = JSON.parse(raw as string) as {
    result: { structuredContent: Record<string, unknown> };
  };
  expect(parsed.result.structuredContent["ok"]).toBe(true);
  expect(parsed.result.structuredContent["itemIds"]).toEqual(["demo-b"]);
  expect(parsed.result.structuredContent["replayed"]).toBe(false);
  const store = JSON.parse(await Bun.file(env.storePath).text()) as { revision: number };
  expect(store.revision).toBe(2);
});

test("U7 repeated ids at indices 0 and 2 are duplicate-id (U7)", async () => {
  const fixture = await loadFixture("tests/fixtures/mcp/good-dag.json");
  const items = [
    fixture.items[0],
    fixture.items[1],
    { ...(fixture.items[0] as Record<string, unknown>), dependencies: ["demo-a"] },
    { ...(fixture.items[1] as Record<string, unknown>), id: "demo-d" },
  ];
  const { structured, store, lines } = await setup({ items });
  expect(structured["ok"]).toBe(false);
  expect(errorOf(structured)).toEqual({
    code: "duplicate-id",
    message: "duplicate id demo-a at items 0 and 2",
    retryable: false,
    id: "demo-a",
    indices: [0, 2],
  });
  expect(store).toBeNull();
  const ends = lines.filter(
    (entry) => (entry as { event?: string }).event === "call-end",
  ) as Record<string, unknown>[];
  expect(ends.length).toBe(1);
  expect(ends[0]?.["summary"]).toEqual({ id: "demo-a", indices: [0, 2] });
});

function fieldCase(field: string, value: unknown): Record<string, unknown>[] {
  const base = JSON.parse(readFileSync("tests/fixtures/mcp/good-dag.json", "utf8")) as {
    items: Record<string, unknown>[];
  };
  const first = { ...(base.items[0] as Record<string, unknown>) };
  if (field === "modelRouting.attempts" || field === "modelRouting.fallbackUsed") {
    const routing = { ...((first["modelRouting"] ?? {}) as Record<string, unknown>) };
    if (field === "modelRouting.attempts") {
      routing["attempts"] = value;
    } else {
      routing["fallbackUsed"] = value;
    }
    first["modelRouting"] = routing;
  } else if (field.startsWith("dod[")) {
    const dod = [
      { ...(((first["dod"] ?? []) as unknown[])[0] as Record<string, unknown>) },
    ] as Record<string, unknown>[];
    const head = dod[0] as Record<string, unknown>;
    head["done"] = value;
    first["dod"] = dod;
  } else {
    first[field] = value;
  }
  return [{ ...first }, base.items[1] as Record<string, unknown>];
}

test("U8 every non-initial loop field is refused with its field (U8)", async () => {
  const cases: Array<[string, unknown]> = [
    ["status", "running"],
    ["statusReason", "waiting"],
    ["assignedHostAlias", "alpha"],
    ["branch", "1-demo"],
    ["pullNumber", 7],
    ["retryCount", 1],
    ["stallRounds", 1],
    ["modelRouting.attempts", 1],
    ["modelRouting.fallbackUsed", true],
    ["dod[0].done", true],
  ];
  for (const [field, value] of cases) {
    const { structured, store } = await setup({ items: fieldCase(field, value) });
    expect(structured["ok"]).toBe(false);
    const error = errorOf(structured);
    expect(error["code"]).toBe("loop-state-not-initial");
    expect(error["field"]).toBe(field);
    expect(store).toBeNull();
  }
});

test("U9 each removed predicate is refused (U9)", async () => {
  const base = await loadFixture("tests/fixtures/mcp/good-dag.json");
  const first = base.items[0] as Record<string, unknown>;

  const badRepo = [{ ...first, repo: "pohunekd/means-of-compute" }, base.items[1]];
  const repoCase = await setup({ items: badRepo });
  expect(errorOf(repoCase.structured)).toMatchObject({
    code: "repo-not-configured",
    message: "item demo-a: repo pohunekd/means-of-compute is not configured",
  });
  expect(repoCase.store).toBeNull();

  const badModel = [
    {
      ...first,
      modelRouting: { preferredModel: "unknown/model", attempts: 0, fallbackUsed: false },
    },
    base.items[1],
  ];
  const modelCase = await setup({ items: badModel });
  expect(errorOf(modelCase.structured)).toMatchObject({
    code: "model-not-allowed",
    message: "item demo-a: model unknown/model is not allowed",
  });
  expect(modelCase.store).toBeNull();

  const big = [{ ...first, goal: `x`.repeat(20000) }, base.items[1]];
  const bigCase = await setup({ items: big });
  expect(errorOf(bigCase.structured)["code"]).toBe("item-too-large");
  expect(bigCase.store).toBeNull();

  const missing = [{ ...first }];
  delete missing[0]?.["title"];
  const contractCase = await setup({ items: missing });
  expect(errorOf(contractCase.structured)).toMatchObject({
    code: "contract-invalid",
    path: "/",
    keyword: "required",
  });
  expect(contractCase.store).toBeNull();

  const many: Record<string, unknown>[] = [];
  for (let n = 0; n < 51; n += 1) {
    many.push({ ...first, id: `bulk-${String(n).padStart(2, "0")}` });
  }
  const maxCase = await setup({ items: many });
  expect(errorOf(maxCase.structured)).toEqual({
    code: "invalid-arguments",
    message: "invalid arguments at /items (maxItems)",
    retryable: false,
    path: "/items",
    keyword: "maxItems",
  });
  expect(maxCase.store).toBeNull();
});

test("U9 store at maxStoreItems refuses with store-full (U9)", async () => {
  const env = await createMcpTestEnv("mcp-u9full-");
  const committed = JSON.parse(await Bun.file(env.workConfigPath).text()) as Record<
    string,
    unknown
  >;
  committed["maxStoreItems"] = 2;
  await writeTestFile(env.workConfigPath, committed);
  const { log, lines } = memoryLog();
  const tools = createTools({
    workConfigPath: env.workConfigPath,
    dispatcherConfigPath: env.dispatcherConfigPath,
    auditorConfigPath: env.auditorConfigPath,
  });
  const protocol = createProtocol({
    tools,
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: log,
    now: fixedNow(),
    runId: "run-u9full",
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
  const fixture = await loadFixture("tests/fixtures/mcp/good-dag.json");
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 1,
    items: [fixture.items[0]],
    submissions: [
      {
        submissionId: "sub-0123456789abcdef",
        digest: `sha256:${"0".repeat(64)}`,
        itemIds: ["demo-a"],
        caller: "seed",
        submittedAt: "2026-10-28T10:00:00.000Z",
      },
    ],
  });
  const call = (id: number, args: unknown): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "submit_work", arguments: args },
    });
  const first = JSON.parse(
    (await protocol.handleLine(call(2, { items: [fixture.items[1]] }))) as string,
  ) as {
    result: { structuredContent: Record<string, unknown> };
  };
  expect(first.result.structuredContent["ok"]).toBe(true);
  expect(first.result.structuredContent["replayed"]).toBe(false);
  const raw = await protocol.handleLine(call(3, { items: [fixture.items[2]] }));
  const parsed = JSON.parse(raw as string) as {
    result: { structuredContent: Record<string, unknown> };
  };
  expect(parsed.result.structuredContent["ok"]).toBe(false);
  expect(errorOf(parsed.result.structuredContent)).toEqual({
    code: "store-full",
    message: "store holds at most 2 items",
    retryable: false,
    limit: 2,
  });
  const ends = lines.filter(
    (entry) => (entry as { event?: string }).event === "call-end",
  ) as Record<string, unknown>[];
  expect(ends.length).toBe(2);
  expect(ends[1]?.["summary"]).toEqual({ limit: 2 });
  const store = JSON.parse(await Bun.file(env.storePath).text()) as {
    revision: number;
    items: unknown[];
  };
  expect(store.revision).toBe(2);
  expect(store.items.length).toBe(2);
});

test("U10 held lock is store-busy with retryable true (U10)", async () => {
  const env = await createMcpTestEnv("mcp-u10-");
  const { log } = memoryLog();
  const tools = createTools({
    workConfigPath: env.workConfigPath,
    dispatcherConfigPath: env.dispatcherConfigPath,
    auditorConfigPath: env.auditorConfigPath,
  });
  const protocol = createProtocol({
    tools,
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: log,
    now: fixedNow(),
    runId: "run-u10",
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
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 0,
    items: [],
    submissions: [],
  });
  const before = await Bun.file(env.storePath).text();
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "work", "lock-holder.case.ts")], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, WORK_STORE_TEST_PATH: env.storePath },
  });
  try {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("holder exited before printing the ready line");
      }
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes("holder ready")) {
        reader.releaseLock();
        break;
      }
    }
    const fixture = await loadFixture("tests/fixtures/mcp/good-dag.json");
    const raw = await protocol.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "submit_work", arguments: { items: fixture.items } },
      }),
    );
    const parsed = JSON.parse(raw as string) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(parsed.result.structuredContent["ok"]).toBe(false);
    expect(errorOf(parsed.result.structuredContent)).toEqual({
      code: "store-busy",
      message: "work store busy, retry",
      retryable: true,
      store: "work",
    });
    expect(await Bun.file(env.storePath).text()).toBe(before);
  } finally {
    child.kill(9);
    await child.exited;
  }
}, 20000);

test("U11 the U4 call-end carries dag-cycle with an edge summary and no goal text (U11)", async () => {
  const env = await createMcpTestEnv("mcp-u11-");
  const { log, lines } = memoryLog();
  const tools = createTools({
    workConfigPath: env.workConfigPath,
    dispatcherConfigPath: env.dispatcherConfigPath,
    auditorConfigPath: env.auditorConfigPath,
  });
  const protocol = createProtocol({
    tools,
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: log,
    now: fixedNow(),
    runId: "run-u11",
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
  const fixture = JSON.parse(readFileSync("tests/fixtures/mcp/cyclic-dag.json", "utf8")) as {
    items: Record<string, unknown>[];
  };
  const goalText = String((fixture.items[0] as Record<string, unknown>)["goal"]);
  expect(goalText.length).toBeGreaterThan(0);
  await protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "submit_work", arguments: { items: fixture.items } },
    }),
  );
  const ends = lines.filter(
    (entry) => (entry as { event?: string }).event === "call-end",
  ) as Record<string, unknown>[];
  expect(ends.length).toBe(1);
  expect(ends[0]?.["code"]).toBe("dag-cycle");
  expect(ends[0]?.["outcome"]).toBe("refused");
  expect(ends[0]?.["summary"]).toEqual({ edge: { from: "demo-cyc-c", to: "demo-cyc-a" } });
  expect(JSON.stringify(lines).includes(goalText)).toBe(false);
});

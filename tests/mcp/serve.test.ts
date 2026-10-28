// MCP server transport tests (matrix SV1-SV3): the spawned server
// answers over stdio (initialize, tools/list, fleet_status), keeps stdout
// free of diagnostics, answers a call before EOF and exits 0, and exits 2
// with empty stdout on startup failures.
import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpTestEnv, writeTestFile, type McpTestEnv } from "../../tests/mcp/env.js";

function initLine(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "sh", version: "1" },
    },
  });
}

function listLine(id: number): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });
}

function callLine(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "fleet_status", arguments: {} },
  });
}

interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function spawnServer(input: string, extraArgs: readonly string[] = []): Promise<SpawnResult> {
  const proc = Bun.spawn(
    [process.execPath, "src/mcp/serve.ts", "--caller", "coordinator", ...extraArgs],
    {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const sink = proc.stdin as unknown as {
    write(chunk: string): void;
    end(): void;
  };
  sink.write(input);
  sink.end();
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout: out, stderr: err };
}

async function writeLargeRegistry(env: McpTestEnv): Promise<void> {
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 0,
    items: [],
    submissions: [],
  });
  const sessions: Record<string, unknown>[] = [];
  for (let n = 0; n < 6000; n += 1) {
    const id = `w${String(n)}`;
    sessions.push({
      requestId: `${id}:0`,
      workItemId: id,
      repo: "example/demo",
      hostAlias: `host-${String(n).padStart(5, "0")}`,
      branch: `moc/${id}`,
      baseRef: "origin/main",
      resume: false,
      model: { providerId: "meta-api", model: "muse-spark-1.3-contributor" },
      briefSha256: "a".repeat(64),
      sessionId: null,
      worktree: null,
      baseCommit: null,
      startedAt: "2026-10-27T10:00:00.000Z",
      cursor: null,
      unreachableCount: 0,
      lastSeenState: "starting",
      lastSeenAt: "2026-10-27T10:00:00.000Z",
      cancelReason: null,
      terminal: null,
      resolvedAt: null,
      revision: 0,
    });
  }
  await writeTestFile(env.registryPath, { sessions });
}

test("SV1 stdout carries only JSON-RPC responses (SV1, D1)", async () => {
  const env = await createMcpTestEnv("mcp-sv1-");
  await Bun.write(
    env.storePath,
    JSON.stringify({ schemaVersion: "v1", revision: 0, items: [], submissions: [] }),
  );
  await Bun.write(env.registryPath, JSON.stringify({ sessions: [] }));
  const result = await spawnServer(`${initLine(1)}\n${listLine(2)}\n${callLine(3)}\n`, [
    "--config",
    env.mcpConfigPath,
  ]);
  expect(result.code).toBe(0);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(3);
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const entry of parsed) {
    expect(entry["jsonrpc"]).toBe("2.0");
  }
  expect((parsed[0] as { id: number }).id).toBe(1);
  expect((parsed[1] as { id: number }).id).toBe(2);
  const call = parsed[2] as {
    id: number;
    result: { structuredContent: { ok: boolean } };
  };
  expect(call.id).toBe(3);
  expect(call.result.structuredContent.ok).toBe(true);
  expect(result.stderr).not.toContain("{");
  const logText = await Bun.file(env.callLogPath).text();
  expect(logText).toContain('"event":"server-start"');
  expect(logText).toContain('"event":"server-stop"');
  expect(logText).toContain('"reason":"eof"');
});

test("SV2 a call followed by EOF is answered and the server exits 0 (SV2)", async () => {
  const env = await createMcpTestEnv("mcp-sv2-");
  await Bun.write(
    env.storePath,
    JSON.stringify({ schemaVersion: "v1", revision: 0, items: [], submissions: [] }),
  );
  await Bun.write(env.registryPath, JSON.stringify({ sessions: [] }));
  const result = await spawnServer(`${initLine(1)}\n${callLine(2)}\n`, [
    "--config",
    env.mcpConfigPath,
  ]);
  expect(result.code).toBe(0);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(2);
  const call = JSON.parse(lines[1] as string) as {
    id: number;
    result: { structuredContent: { ok: boolean } };
  };
  expect(call.id).toBe(2);
  expect(call.result.structuredContent.ok).toBe(true);
});

test("F1 a final call line without a newline is answered (F1, T3.2)", async () => {
  const env = await createMcpTestEnv("mcp-f1-");
  await Bun.write(
    env.storePath,
    JSON.stringify({ schemaVersion: "v1", revision: 0, items: [], submissions: [] }),
  );
  await Bun.write(env.registryPath, JSON.stringify({ sessions: [] }));
  const result = await spawnServer(`${initLine(1)}\n${callLine(2)}`, [
    "--config",
    env.mcpConfigPath,
  ]);
  expect(result.code).toBe(0);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(2);
  const call = JSON.parse(lines[1] as string) as {
    id: number;
    result: { structuredContent: { ok: boolean } };
  };
  expect(call.id).toBe(2);
  expect(call.result.structuredContent.ok).toBe(true);
  const logText = await Bun.file(env.callLogPath).text();
  expect(logText).toContain('"event":"call-end"');
});

test("a large response survives a slow reader (H1, F2, T3.2)", async () => {
  const env = await createMcpTestEnv("mcp-f2-");
  await writeLargeRegistry(env);
  // The pipe reader sleeps before draining, so the server must keep the
  // whole response buffered until stdout accepts it; exiting early or
  // resolving the write without its callback truncates the response.
  const slowReaderCmd = `${process.execPath} src/mcp/serve.ts --caller coordinator --config "${env.mcpConfigPath}" | (sleep 1; cat)`;
  const proc = Bun.spawn(["sh", "-c", slowReaderCmd], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const sink = proc.stdin as unknown as {
    write(chunk: string): void;
    end(): void;
  };
  sink.write(`${initLine(1)}\n${callLine(2)}\n`);
  sink.end();
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(stderr).not.toContain("{");
  expect(code).toBe(0);
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(2);
  const call = JSON.parse(lines[1] as string) as {
    id: number;
    result: {
      structuredContent: {
        ok: boolean;
        hosts: readonly { hostAlias: string }[];
      };
    };
  };
  expect(call.id).toBe(2);
  if (call.result.structuredContent.ok !== true) {
    console.log(`DEBUG-H1 payload: ${JSON.stringify(call.result.structuredContent).slice(0, 500)}`);
    console.log(`DEBUG-H1 stderr: ${stderr.slice(0, 500)}`);
    const h1log = await Bun.file(env.callLogPath).text().catch((e: unknown) => String(e));
    console.log(`DEBUG-H1 log: ${h1log.slice(0, 2000)}`);
  }
  expect(call.result.structuredContent.ok).toBe(true);
  expect(call.result.structuredContent.hosts.length).toBe(6000);
  expect(stdout.length).toBeGreaterThan(300000);
});

test("SIGTERM after EOF drops queued calls (H2, T3.4)", async () => {
  const env = await createMcpTestEnv("mcp-h2-");
  await writeLargeRegistry(env);
  // Stdout through (sleep 2; cat) fills the pipe, so the first large
  // response stays in flight while the rest queue behind it. The server
  // pid comes from its own server-start line, so SIGTERM hits the server
  // alone, not the reader. Stdin closes at once (EOF), then SIGTERM
  // arrives once the call log shows the first call-start.
  const queuedCmd = `${process.execPath} src/mcp/serve.ts --caller coordinator --config "${env.mcpConfigPath}" | (sleep 2; cat)`;
  const proc = Bun.spawn(["sh", "-c", queuedCmd], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const sink = proc.stdin as unknown as {
    write(chunk: string): void;
    end(): void;
  };
  sink.write(`${initLine(1)}\n${callLine(2)}\n${callLine(3)}\n${callLine(4)}\n${callLine(5)}\n`);
  sink.end();
  let serverPid = 0;
  let finishedFirstCall = false;
  for (let n = 0; n < 400 && (serverPid === 0 || !finishedFirstCall); n += 1) {
    const logText = await Bun.file(env.callLogPath)
      .text()
      .catch(() => "");
    const pidMatch = /"event":"server-start"[^}]*"pid":(\d+)/.exec(logText);
    if (pidMatch?.[1] !== undefined) {
      const parsed = Number.parseInt(pidMatch[1], 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        serverPid = parsed;
      }
    }
    if (logText.includes('"event":"call-end"')) {
      finishedFirstCall = true;
    }
    if (serverPid === 0 || !finishedFirstCall) {
      await Bun.sleep(25);
    }
  }
  expect(serverPid).toBeGreaterThan(0);
  expect(finishedFirstCall).toBe(true);
  process.kill(serverPid, "SIGTERM");
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  await new Response(proc.stdout).text();
  expect(stderr).not.toContain("{");
  expect(code).toBe(0);
  const logText = await Bun.file(env.callLogPath).text();
  const starts = logText.split("\n").filter((line) => line.includes('"event":"call-start"'));
  expect(starts.length).toBeLessThan(4);
  expect(logText).toContain('"event":"server-stop"');
  expect(logText).toContain('"reason":"signal"');
});

test("a too-large line over stdio is answered in order and logged (H4, P1)", async () => {
  const env = await createMcpTestEnv("mcp-h4-");
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 0,
    items: [],
    submissions: [],
  });
  await writeTestFile(env.registryPath, { sessions: [] });
  // Init, one call, then an oversized line in a single write: the
  // responses must arrive in order and the call log must hold exactly one
  // protocol-error with jsonrpcCode -32600.
  const oversized = `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"padding":"${"x".repeat(1048576)}"}}`;
  const result = await spawnServer(`${initLine(1)}\n${callLine(2)}\n${oversized}\n`, [
    "--config",
    env.mcpConfigPath,
  ]);
  expect(result.code).toBe(0);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(3);
  const ids = lines.map((line) => (JSON.parse(line) as { id: number | null }).id);
  expect(ids).toEqual([1, 2, null]);
  const tooLarge = JSON.parse(lines[2] as string) as {
    error: { code: number; message: string };
  };
  expect(tooLarge.error.code).toBe(-32600);
  expect(tooLarge.error.message).toBe("message too large");
  const logText = await Bun.file(env.callLogPath).text();
  const errors = logText.split("\n").filter((line) => line.includes('"event":"protocol-error"'));
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain('"jsonrpcCode":-32600');
});

test("SV3 startup failures exit 2 with empty stdout (SV3)", async () => {
  const env = await createMcpTestEnv("mcp-sv3-");
  // The temp config is passed, so a defaulted caller would start serving.
  const noCaller = Bun.spawn(
    [process.execPath, "src/mcp/serve.ts", "--config", env.mcpConfigPath],
    {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  (noCaller.stdin as unknown as { end(): void }).end();
  const [noCallerCode, noCallerOut, noCallerErr] = await Promise.all([
    noCaller.exited,
    new Response(noCaller.stdout).text(),
    new Response(noCaller.stderr).text(),
  ]);
  expect(noCallerCode).toBe(2);
  expect(noCallerOut).toBe("");
  expect(noCallerErr.trim()).toBe("mcp: --caller <name> is required exactly once");
  // Thrown messages carry no prefix; the printer adds it once (T3.1).
  expect(noCallerErr).not.toContain("mcp: mcp:");

  const badCaller = Bun.spawn(
    [process.execPath, "src/mcp/serve.ts", "--caller", "intruder", "--config", env.mcpConfigPath],
    { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  (badCaller.stdin as unknown as { end(): void }).end();
  const [badCallerCode, badCallerOut] = await Promise.all([
    badCaller.exited,
    new Response(badCaller.stdout).text(),
  ]);
  expect(badCallerCode).toBe(2);
  expect(badCallerOut).toBe("");

  const missingVerdict = await mkdtemp(join(tmpdir(), "mcp-sv3-missing-"));
  const configPath = join(missingVerdict, "mcp.json");
  const raw = JSON.parse(await Bun.file(env.mcpConfigPath).text()) as Record<string, unknown>;
  await writeFile(configPath, JSON.stringify(raw));
  const auditorPath = join(missingVerdict, "auditor.json");
  const auditorRaw = JSON.parse(await Bun.file(env.auditorConfigPath).text()) as Record<
    string,
    unknown
  >;
  auditorRaw["verdictDir"] = join(missingVerdict, "no-such-verdicts");
  await writeFile(auditorPath, JSON.stringify(auditorRaw));
  const patched = { ...raw, auditorConfigPath: auditorPath };
  await writeFile(configPath, JSON.stringify(patched));
  const missing = Bun.spawn(
    [process.execPath, "src/mcp/serve.ts", "--caller", "coordinator", "--config", configPath],
    { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  (missing.stdin as unknown as { end(): void }).end();
  const [missingCode, missingOut] = await Promise.all([
    missing.exited,
    new Response(missing.stdout).text(),
  ]);
  expect(missingCode).toBe(2);
  expect(missingOut).toBe("");
});

test("F13 a closed stdout aborts queued calls (F13, T3.4)", async () => {
  const entries: { event: string }[] = [];
  const slowGate = (() => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release: () => release?.() };
  })();
  const { createProtocol } = await import("../../src/mcp/protocol.ts");
  let runs = 0;
  const protocol = createProtocol({
    tools: [
      {
        name: "slow_tool",
        title: "Slow tool",
        toolClass: "read" as const,
        description: "[read] test tool",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        validate: () => null,
        run: async () => {
          runs += 1;
          await slowGate.gate;
          return { payload: { ok: true }, summary: null, detail: null };
        },
      },
    ],
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    caller: "coordinator",
    callLog: {
      append: (entry: Record<string, unknown>): Promise<void> => {
        entries.push(entry as { event: string });
        return Promise.resolve();
      },
    },
    now: () => new Date("2026-10-28T10:00:00.000Z"),
    runId: "run-f13",
  });
  await protocol.handleLine(initLine(1));
  // Two queued calls; a closed stdout aborts the queue like a signal, so
  // the second call never starts and no drain listener leaks.
  const first = protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "slow_tool", arguments: {} },
    }),
  );
  const second = protocol.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "slow_tool", arguments: {} },
    }),
  );
  await Bun.sleep(10);
  // Mirrors the serve.ts stdout-closed path: abort drops queued lines
  // that have not started, then the in-flight call finishes.
  protocol.abort();
  slowGate.release();
  await Promise.resolve();
  const [firstRaw, secondRaw] = await Promise.all([first, second]);
  await protocol.drain();
  expect(firstRaw === null || secondRaw === null).toBe(true);
  expect(runs).toBeLessThanOrEqual(1);
  const starts = entries.filter((entry) => entry.event === "call-start");
  expect(starts.length).toBeLessThanOrEqual(1);
});

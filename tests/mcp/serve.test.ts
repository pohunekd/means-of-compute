// MCP server transport tests (matrix SV1-SV3, C1): the spawned server
// answers over stdio (initialize, tools/list, fleet_status), keeps stdout
// free of diagnostics, answers a call before EOF and exits 0, and exits 2
// with empty stdout on startup failures.
import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpTestEnv, writeTestFile } from "../../tests/mcp/env.js";

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

async function spawnServer(
  envDir: string,
  input: string,
  extraArgs: readonly string[] = [],
): Promise<SpawnResult> {
  const proc = Bun.spawn(
    [process.execPath, "src/mcp/serve.ts", "--caller", "coordinator", ...extraArgs],
    {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MCP_TEST_DIR: envDir },
    },
  );
  if (envDir.length === 0) {
    throw new Error("test env dir is missing");
  }
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

test("SV1 stdout carries only JSON-RPC responses (SV1, D1)", async () => {
  const env = await createMcpTestEnv("mcp-sv1-");
  await Bun.write(
    env.storePath,
    JSON.stringify({ schemaVersion: "v1", revision: 0, items: [], submissions: [] }),
  );
  await Bun.write(env.registryPath, JSON.stringify({ sessions: [] }));
  const result = await spawnServer(env.dir, `${initLine(1)}\n${listLine(2)}\n${callLine(3)}\n`, [
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
  const result = await spawnServer(env.dir, `${initLine(1)}\n${callLine(2)}\n`, [
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
  const result = await spawnServer(env.dir, `${initLine(1)}\n${callLine(2)}`, [
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

test("F2 a large response is written whole before exit (F2, T3.2)", async () => {
  const env = await createMcpTestEnv("mcp-f2-");
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
      revision: 0,
    });
  }
  await writeTestFile(env.registryPath, { sessions });
  // Stdin closes right after the call; stdout is read only after the
  // child has exited, so any truncation fails the parse below.
  const result = await spawnServer(env.dir, `${initLine(1)}\n${callLine(2)}\n`, [
    "--config",
    env.mcpConfigPath,
  ]);
  expect(result.code).toBe(0);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
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
  expect(call.result.structuredContent.ok).toBe(true);
  expect(call.result.structuredContent.hosts.length).toBe(6000);
  expect(result.stdout.length).toBeGreaterThan(300000);
});

test("SV3 startup failures exit 2 with empty stdout (SV3)", async () => {
  const env = await createMcpTestEnv("mcp-sv3-");
  const noCaller = Bun.spawn([process.execPath, "src/mcp/serve.ts"], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  (noCaller.stdin as unknown as { end(): void }).end();
  const [noCallerCode, noCallerOut] = await Promise.all([
    noCaller.exited,
    new Response(noCaller.stdout).text(),
  ]);
  expect(noCallerCode).toBe(2);
  expect(noCallerOut).toBe("");

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

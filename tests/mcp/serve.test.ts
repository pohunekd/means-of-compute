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
  // The brace group records the server's own exit status: the pipeline
  // rc alone only covers the reader.
  const rcfile = join(env.dir, "server.rc");
  const slowReaderCmd = `{ ${process.execPath} src/mcp/serve.ts --caller coordinator --config "${env.mcpConfigPath}"; echo $? > "${rcfile}"; } | (sleep 1; cat)`;
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
  const h1ServerRc = (await Bun.file(rcfile).text()).trim();
  expect(h1ServerRc).toBe("0");
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
  // The brace group records the server's own exit status: the pipeline
  // rc alone only covers the reader.
  const rcfile = join(env.dir, "server.rc");
  const queuedCmd = `{ ${process.execPath} src/mcp/serve.ts --caller coordinator --config "${env.mcpConfigPath}"; echo $? > "${rcfile}"; } | (sleep 2; cat)`;
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
  const h2ServerRc = (await Bun.file(rcfile).text()).trim();
  expect(h2ServerRc).toBe("0");
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
  const [badCallerCode, badCallerOut, badCallerErr] = await Promise.all([
    badCaller.exited,
    new Response(badCaller.stdout).text(),
    new Response(badCaller.stderr).text(),
  ]);
  expect(badCallerCode).toBe(2);
  expect(badCallerOut).toBe("");
  // The exact stderr line for an unknown caller (H6, R2-5): the thrown
  // message carries no prefix, the printer adds it once (T3.1).
  expect(badCallerErr.trim()).toBe('mcp: unknown caller "intruder"');

  const badArg = Bun.spawn(
    [process.execPath, "src/mcp/serve.ts", "--caller", "coordinator", "--frobnicate"],
    { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  (badArg.stdin as unknown as { end(): void }).end();
  const [badArgCode, badArgOut, badArgErr] = await Promise.all([
    badArg.exited,
    new Response(badArg.stdout).text(),
    new Response(badArg.stderr).text(),
  ]);
  expect(badArgCode).toBe(2);
  expect(badArgOut).toBe("");
  expect(badArgErr.trim()).toBe('mcp: unknown argument "--frobnicate"');

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

test("too-deep arguments are refused and the server keeps serving (K1)", async () => {
  const env = await createMcpTestEnv("mcp-k1-");
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 0,
    items: [],
    submissions: [],
  });
  await writeTestFile(env.registryPath, { sessions: [] });
  // Arguments nested 100000 deep cannot be canonicalized: JSON.stringify
  // throws RangeError, so the protocol answers -32602 without a callId
  // while the plain calls before and after are still answered. The brace
  // group records the server's own exit status.
  let nested: unknown = [];
  for (let n = 0; n < 100000; n += 1) {
    nested = [nested];
  }
  // JSON.parse of the prebuilt string below keeps the depth; stringifying
  // in the test would throw the same RangeError first.
  const deepArgs = `[${"[".repeat(99999)}${"]".repeat(99999)}]`;
  const rcfile = join(env.dir, "server.rc");
  const serveCmd = `{ ${process.execPath} src/mcp/serve.ts --caller coordinator --config "${env.mcpConfigPath}"; echo $? > "${rcfile}"; }`;
  const proc = Bun.spawn(["sh", "-c", serveCmd], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const sink = proc.stdin as unknown as {
    write(chunk: string): void;
    end(): void;
  };
  const deepCall = `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fleet_status","arguments":{"x":${deepArgs}}}}`;
  sink.write(`${initLine(1)}\n${callLine(2)}\n${deepCall}\n${callLine(4)}\n`);
  sink.end();
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(code).toBe(0);
  const k1ServerRc = (await Bun.file(rcfile).text()).trim();
  expect(k1ServerRc).toBe("0");
  expect(stderr).not.toContain("{");
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(4);
  const parsed = lines.map((line) => JSON.parse(line) as { id: number });
  expect(parsed.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
  const refused = JSON.parse(lines[2] as string) as {
    error: { code: number; message: string };
  };
  expect(refused.error.code).toBe(-32602);
  const answered = JSON.parse(lines[3] as string) as {
    id: number;
    result: { structuredContent: { ok: boolean } };
  };
  expect(answered.id).toBe(4);
  expect(answered.result.structuredContent.ok).toBe(true);
  const logText = await Bun.file(env.callLogPath).text();
  const errors = logText.split("\n").filter((line) => line.includes('"event":"protocol-error"'));
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain('"jsonrpcCode":-32602');
  expect(errors[0]).toContain('"tool":"fleet_status"');
}, 20000);

test("closing stdout stops queued calls (H5, R2-4, R2-9)", async () => {
  const env = await createMcpTestEnv("mcp-h5-");
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 0,
    items: [],
    submissions: [],
  });
  await writeTestFile(env.registryPath, { sessions: [] });
  // The EOF-first H5 case closes stdin at once: the first failing write
  // marks stdoutOk false while the pipe still holds the 20 queued calls,
  // so the stop reason is stdout-closed only through the stdoutOk rule,
  // never through `done` (R2-9). The stdoutOk guard in enqueueTransport
  // is what skips the queued tasks.
  // The brace group records the server's own exit status: the pipeline
  // rc alone only covers the head reader.
  const rcfile = join(env.dir, "server.rc");
  const closingCmd = `{ ${process.execPath} src/mcp/serve.ts --caller coordinator --config "${env.mcpConfigPath}"; echo $? > "${rcfile}"; } | head -c 1`;
  const proc = Bun.spawn(["sh", "-c", closingCmd], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const sink = proc.stdin as unknown as {
    write(chunk: string): void;
    end(): void;
  };
  let input = `${initLine(1)}\n`;
  for (let id = 2; id <= 21; id += 1) {
    input += `${callLine(id)}\n`;
  }
  sink.write(input);
  // EOF now: stdin closes while the large queued batch is still blocked
  // on the one-byte reader. Every fleet_status call runs the registry
  // read, so the first responses land after stdout already closed.
  sink.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  await new Response(proc.stdout).text();
  expect(code).toBe(0);
  const h5ServerRc = (await Bun.file(rcfile).text()).trim();
  expect(h5ServerRc).toBe("0");
  expect(stderr).not.toContain("MaxListenersExceededWarning");
  const logText = await Bun.file(env.callLogPath).text();
  const starts = logText.split("\n").filter((line) => line.includes('"event":"call-start"'));
  expect(starts.length).toBeLessThanOrEqual(1);
  expect(logText).toContain('"event":"server-stop"');
  expect(logText).toContain('"reason":"stdout-closed"');
});

test("closing stdout stops queued calls with stdin open (I3)", async () => {
  const env = await createMcpTestEnv("mcp-h5-open-");
  await writeTestFile(env.storePath, {
    schemaVersion: "v1",
    revision: 0,
    items: [],
    submissions: [],
  });
  await writeTestFile(env.registryPath, { sessions: [] });
  // Stdout through `head -c 1` closes after one byte while stdin stays
  // open, so the queued calls never start. The brace group records the
  // server's own exit status: the pipeline rc alone only covers the head
  // reader. The failure branch resolves `done`, so the server exits even
  // though no EOF arrives; the wait below only bounds the test.
  const rcfile = join(env.dir, "server.rc");
  const closingCmd = `{ ${process.execPath} src/mcp/serve.ts --caller coordinator --config "${env.mcpConfigPath}"; echo $? > "${rcfile}"; } | head -c 1`;
  const proc = Bun.spawn(["sh", "-c", closingCmd], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const sink = proc.stdin as unknown as {
    write(chunk: string): void;
    end(): void;
  };
  let input = `${initLine(1)}\n`;
  for (let id = 2; id <= 21; id += 1) {
    input += `${callLine(id)}\n`;
  }
  sink.write(input);
  // stdin stays open: the server must exit through the stdout error path
  // alone. The wait bounds the test; the exit assertion proves the
  // server did not hang on the open pipe.
  const exited = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(5000).then(() => false),
  ]);
  sink.end();
  const [code, openStderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  await new Response(proc.stdout).text();
  expect(exited).toBe(true);
  expect(code).toBe(0);
  expect(openStderr).not.toContain("MaxListenersExceededWarning");
  const openServerRc = (await Bun.file(rcfile).text()).trim();
  expect(openServerRc).toBe("0");
  const logText = await Bun.file(env.callLogPath).text();
  const starts = logText.split("\n").filter((line) => line.includes('"event":"call-start"'));
  expect(starts.length).toBeLessThanOrEqual(1);
  expect(logText).toContain('"event":"server-stop"');
  expect(logText).toContain('"reason":"stdout-closed"');
}, 20000);

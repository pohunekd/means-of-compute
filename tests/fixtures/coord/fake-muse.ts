#!/usr/bin/env bun
// Fake muse binary for coordinator session tests: imitates the exec and
// export subcommands without running any model. The exec mode records its
// argv, env keys, cwd and stdin digest, optionally drives the MCP server
// over stdio, and exits with the scripted code.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod } from "node:fs/promises";
import { dirname } from "node:path";

interface FakeCall {
  readonly tool: string;
  readonly arguments?: unknown;
  readonly argumentsFile?: string;
}

interface FakeSurface {
  readonly provider: "echo" | "meta";
  readonly activeTools: readonly string[];
  readonly contextSources: readonly string[];
}

interface FakeScript {
  readonly calls: readonly FakeCall[];
  readonly exit: number;
  readonly hang: boolean;
  readonly exportFails: boolean;
  readonly surface?: FakeSurface;
}

function fail(message: string): never {
  process.stderr.write(`fake-muse: ${message}\n`);
  process.exit(2);
}

function readScriptEnv(name: string): string {
  const value: unknown = process.env[name];
  if (typeof value !== "string" || value === "") {
    fail(`${name} is not set`);
  }
  return value;
}

async function readStdinBytes(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sha256HexBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: unknown;
  readonly id?: unknown;
}

function parseScript(text: string): FakeScript {
  const raw = JSON.parse(text) as {
    readonly calls?: unknown;
    readonly exit?: unknown;
    readonly hang?: unknown;
    readonly exportFails?: unknown;
    readonly surface?: unknown;
  };
  if (!Array.isArray(raw.calls)) {
    fail("script is not a fake muse script");
  }
  const calls: FakeCall[] = [];
  for (const entry of raw.calls as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      fail("script is not a fake muse script");
    }
    const record = entry as { readonly tool?: unknown; readonly arguments?: unknown };
    if (typeof record.tool !== "string") {
      fail("script is not a fake muse script");
    }
    const fileValue = (entry as { readonly argumentsFile?: unknown }).argumentsFile;
    const call: FakeCall =
      fileValue === undefined
        ? { tool: record.tool, arguments: record.arguments }
        : typeof fileValue === "string"
          ? { tool: record.tool, argumentsFile: fileValue }
          : fail("script is not a fake muse script");
    calls.push(call);
  }
  const exit: unknown = raw.exit;
  const hang: unknown = raw.hang;
  const exportFails: unknown = raw.exportFails;
  if (typeof exit !== "number" || typeof hang !== "boolean" || typeof exportFails !== "boolean") {
    fail("script is not a fake muse script");
  }
  const surfaceRaw: unknown = raw.surface;
  if (surfaceRaw === undefined) {
    return { calls, exit, hang, exportFails };
  }
  if (typeof surfaceRaw !== "object" || surfaceRaw === null) {
    fail("script is not a fake muse script");
  }
  const surface = surfaceRaw as { readonly provider?: unknown; readonly activeTools?: unknown; readonly contextSources?: unknown };
  if (surface.provider !== "echo" && surface.provider !== "meta") {
    fail("script is not a fake muse script");
  }
  if (!Array.isArray(surface.activeTools) || !surface.activeTools.every((e: unknown) => typeof e === "string")) {
    fail("script is not a fake muse script");
  }
  if (!Array.isArray(surface.contextSources) || !surface.contextSources.every((e: unknown) => typeof e === "string")) {
    fail("script is not a fake muse script");
  }
  return {
    calls,
    exit,
    hang,
    exportFails,
    surface: {
      provider: surface.provider,
      activeTools: surface.activeTools as readonly string[],
      contextSources: surface.contextSources as readonly string[],
    },
  };
}

async function runExec(): Promise<void> {
  const scriptPath = readScriptEnv("FAKE_MUSE_SCRIPT");
  const script = parseScript(await Bun.file(scriptPath).text());
  const providerIndex = process.argv.indexOf("--provider");
  const provider = providerIndex === -1 ? undefined : process.argv[providerIndex + 1];
  const sessionIndex = process.argv.indexOf("--session-id");
  const sessionId = sessionIndex === -1 ? undefined : process.argv[sessionIndex + 1];
  if (provider === undefined || sessionId === undefined || sessionId === "") {
    fail("missing provider or session id");
  }
  const sessionValue: string = sessionId;
  const home = process.env["HOME"] ?? "";
  if (home !== "") {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(`${home}/fake-muse-sessions`, { recursive: true });
    await Bun.write(`${home}/fake-muse-sessions/${sessionValue}`, `${String(provider)}\n`);
  }
  if (provider === "echo") {
    await readStdinBytes();
    process.exit(0);
  }
  const stdinBytes = await readStdinBytes();
  const recordPath = readScriptEnv("FAKE_MUSE_RECORD");
  const record = {
    argv: process.argv.slice(2),
    envKeys: Object.keys(process.env).sort(),
    home: process.env["HOME"] ?? null,
    cwd: process.cwd(),
    stdinSha256: sha256HexBytes(stdinBytes),
    grandchildPid: null as number | null,
  };
  await Bun.write(recordPath, `${JSON.stringify(record)}\n`);
  await chmod(recordPath, 0o600);
  if (script.hang) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: false,
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) {
      fail("cannot spawn hang child");
    }
    await Bun.write(recordPath, `${JSON.stringify({ ...record, grandchildPid: pid })}\n`);
    await chmod(recordPath, 0o600);
    await new Promise<void>(() => {});
    return;
  }
  if (script.calls.length > 0) {
    await driveServer(script, scriptPath);
  }
  process.exit(script.exit);
}

async function driveServer(script: FakeScript, scriptPath: string): Promise<void> {
  const factoryFlag = process.argv.find((entry) => entry.startsWith("mcpServers.factory="));
  if (factoryFlag === undefined) {
    fail("missing mcpServers.factory flag");
  }
  const factory = JSON.parse(factoryFlag.slice("mcpServers.factory=".length)) as {
    readonly command?: unknown;
    readonly args?: unknown;
  };
  if (typeof factory.command !== "string" || !Array.isArray(factory.args)) {
    fail("factory entry is not an object");
  }
  const rawArgs: unknown = factory.args;
  const rawCommand: unknown = factory.command;
  if (!Array.isArray(rawArgs) || typeof rawCommand !== "string") {
    fail("factory entry is not an object");
  }
  const args: string[] = [];
  for (const entry of rawArgs) {
    const text: unknown = entry;
    if (typeof text !== "string") {
      fail("factory entry is not an object");
    }
    args.push(text);
  }
  const server = spawn(rawCommand, args, { stdio: ["pipe", "pipe", "inherit"] });
  const maybeOut: unknown = server.stdout;
  const maybeIn: unknown = server.stdin;
  if (maybeOut === null || maybeOut === undefined || maybeIn === null || maybeIn === undefined) {
    fail("cannot pipe to the MCP server");
  }
  const out = maybeOut as NodeJS.ReadableStream & AsyncIterable<Uint8Array>;
  const inp = maybeIn as { write(chunk: string): boolean; end(): void };
  let nextId = 0;
  let buffered = "";
  let serverEnded = false;
  server.on("exit", () => {
    serverEnded = true;
  });
  const decoder = new TextDecoder();
  const reader = out[Symbol.asyncIterator]();
  async function readLine(): Promise<string | null> {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return line;
      }
      if (serverEnded) {
        return null;
      }
      const next = await reader.next();
      if (next.done) {
        serverEnded = true;
        return null;
      }
      buffered += decoder.decode(next.value as Uint8Array, { stream: true });
    }
  }
  function send(value: unknown): void {
    inp.write(`${JSON.stringify(value)}\n`);
  }
  nextId += 1;
  send({
    jsonrpc: "2.0",
    id: nextId,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fake-muse", version: "0.0.0" },
    },
  });
  const initLine = await readLine();
  if (initLine === null) {
    process.exit(3);
  }
  const init = JSON.parse(initLine) as JsonRpcResponse;
  if (init.error !== undefined) {
    process.exit(3);
  }
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  for (const call of script.calls) {
    let callArgs: unknown;
    if (call.argumentsFile !== undefined) {
      const base = dirname(scriptPath);
      callArgs = JSON.parse(await Bun.file(`${base}/${call.argumentsFile}`).text()) as unknown;
    } else {
      callArgs = call.arguments;
    }
    nextId += 1;
    const id = nextId;
    send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: call.tool, arguments: callArgs },
    });
    const line = await readLine();
    if (line === null) {
      process.exit(3);
    }
    const response = JSON.parse(line) as JsonRpcResponse;
    if (response.error !== undefined || response.id !== id) {
      process.exit(3);
    }
  }
  inp.end();
  await new Promise<void>((resolve) => {
    server.on("exit", () => {
      resolve();
    });
  });
}

async function runExport(): Promise<void> {
  const scriptPath = readScriptEnv("FAKE_MUSE_SCRIPT");
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
  if (out === undefined || out === "") {
    fail("missing --out flag");
  }
  const outPath: string = out;
  const sessionIndex = process.argv.indexOf("--session");
  const sessionId = sessionIndex === -1 ? undefined : process.argv[sessionIndex + 1];
  const script = parseScript(await Bun.file(scriptPath).text());
  if (script.exportFails) {
    process.exit(5);
  }
  let provider = "meta";
  if (sessionId !== undefined && sessionId !== "") {
    const home = process.env["HOME"] ?? "";
    if (home !== "") {
      try {
        provider = (await Bun.file(`${home}/fake-muse-sessions/${sessionId}`).text()).trim();
      } catch {
        provider = "meta";
      }
    }
    if (provider !== "echo" && provider !== "meta") {
      provider = "meta";
    }
  }
  const surface = script.surface;
  const matches = surface !== undefined && surface.provider === provider;
  const tools: readonly string[] = matches
    ? surface.activeTools
    : [
        "mcp__factory__fleet_status",
        "mcp__factory__list_work",
        "mcp__factory__audit_results",
        "mcp__factory__submit_work",
        "mcp__factory__approve",
        "mcp__factory__pause_fleet",
      ];
  const sources: readonly string[] = matches
    ? surface.contextSources
    : [
        "capability_policy",
        "meta_context_note",
        "security_mode",
        "session_identity",
        "skills",
        "workspace_identity",
      ];
  const doc = {
    export_schema_version: 1,
    events: [
      {
        envelope: {
          payload_type: "runtime.session",
          payload: {
            event: {
              kind: "model_request_configured",
              toolset: { active_tools: tools, mode: "named", source: "settings" },
              run_context_messages: sources.map((s) => ({ source: s })),
              delegation_posture: { state: "inactive" },
              reminder_roster: { agents: [], source: "runtime" },
            },
          },
        },
      },
    ],
  };
  await Bun.write(outPath, `${JSON.stringify(doc)}\n`);
  await chmod(outPath, 0o600);
  process.exit(0);
}

const mode = process.argv[2];
if (mode === "exec") {
  await runExec();
} else if (mode === "export") {
  await runExport();
} else {
  fail(`unknown mode ${String(mode)}`);
}

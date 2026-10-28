// MCP server entry point: stdio transport, arg parsing, startup gates,
// and shutdown. Startup (design section 1 steps 1-8): parse args, load the
// MCP config, check the caller, load the work and dispatcher configs plus
// factory specs, require writable targets and the verdict dir, open the
// call log and append server-start. Shutdown: stdin EOF appends
// server-stop {reason:"eof"} and exits 0; SIGTERM/SIGINT finishes the
// message in flight, appends server-stop {reason:"signal"} and exits 0.
// Stdout carries only JSON-RPC messages; diagnostics go to stderr.
import { randomUUID } from "node:crypto";
import { createLineSplitter, createProtocol } from "./protocol.js";
import { loadMcpConfig } from "./config.js";
import { openCallLog } from "./call-log.js";
import type { CallLog } from "./protocol.js";
import { createTools } from "./tools.js";
import { loadWorkConfig } from "../work/config.js";
import { loadFactorySpecs } from "../work/specs.js";
import { loadDispatcherConfig } from "../dispatcher/config.js";
import { loadAuditorConfig } from "../auditor/config.js";
import { requireInputDir } from "../fs/input.js";
import { requireWritableTarget } from "../fs/write.js";

function parseArgs(args: readonly string[]): { caller: string; configPath: string } {
  let caller: string | null = null;
  let configPath = "config/mcp.json";
  let configSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--caller") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || caller !== null) {
        throw new Error("mcp: --caller <name> is required exactly once");
      }
      caller = value;
      index += 1;
    } else if (arg === "--config") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || configSeen) {
        throw new Error("mcp: --config <path> is allowed at most once");
      }
      configPath = value;
      configSeen = true;
      index += 1;
    } else {
      throw new Error(`mcp: unknown argument "${arg}"`);
    }
  }
  if (caller === null) {
    throw new Error("mcp: --caller <name> is required exactly once");
  }
  return { caller, configPath };
}

interface Startup {
  readonly protocol: ReturnType<typeof createProtocol>;
  readonly callLog: CallLog & { close(): Promise<void> };
  readonly maxMessageBytes: number;
  readonly run: string;
  readonly caller: string;
}

async function startup(caller: string, configPath: string): Promise<Startup> {
  const config = await loadMcpConfig(configPath);
  if (!config.callers.includes(caller)) {
    throw new Error(`mcp: unknown caller "${caller}"`);
  }
  const workConfig = await loadWorkConfig(config.workConfigPath);
  await loadFactorySpecs(workConfig.factorySpecsPath);
  const auditorConfig = await loadAuditorConfig(config.auditorConfigPath);
  await loadDispatcherConfig(config.dispatcherConfigPath);
  await requireWritableTarget("MCP call log", config.callLogPath);
  await requireWritableTarget("Work store", workConfig.storePath);
  await requireInputDir("Verdict dir", auditorConfig.verdictDir);
  const callLog = await openCallLog(config.callLogPath);
  const run = randomUUID();
  const now = new Date();
  const started = await callLog
    .append({
      ts: now.toISOString(),
      event: "server-start",
      run,
      caller,
      pid: process.pid,
    })
    .then(
      () => true,
      () => false,
    );
  if (!started) {
    await callLog.close().catch(() => undefined);
    throw new Error("mcp: call log unavailable");
  }
  const tools = createTools({
    workConfigPath: config.workConfigPath,
    dispatcherConfigPath: config.dispatcherConfigPath,
  });
  const protocol = createProtocol({
    tools,
    serverInfo: { name: config.serverInfo.name, version: config.serverInfo.version },
    caller,
    callLog,
    now: () => new Date(),
    runId: run,
  });
  return { protocol, callLog, maxMessageBytes: config.maxMessageBytes, run, caller };
}

// Writes through stdout and reports an EPIPE-style failure so the caller
// stops writing responses. A failed write resolves false; a closed stream
// resolves false as well.
async function writeStdout(text: string): Promise<boolean> {
  const ok = process.stdout.write(`${text}\n`);
  if (!ok) {
    await new Promise<void>((resolve) => {
      process.stdout.once("drain", () => {
        resolve();
      });
    }).catch(() => undefined);
  }
  if (process.stdout.writableEnded || process.stdout.destroyed) {
    return false;
  }
  return true;
}

async function serve(caller: string, configPath: string): Promise<number> {
  let state: Startup;
  try {
    state = await startup(caller, configPath);
  } catch (error: unknown) {
    process.stderr.write(`mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  process.stderr.write(`mcp: serving as ${caller}\n`);
  const { protocol, callLog, maxMessageBytes, run } = state;
  let stopping = false;
  let stdoutOk = true;
  async function stop(reason: string): Promise<void> {
    if (stopping) {
      return;
    }
    stopping = true;
    await callLog
      .append({ ts: new Date().toISOString(), event: "server-stop", run, reason })
      .catch(() => undefined);
    await callLog.close().catch(() => undefined);
  }
  async function handleTransportLine(line: string): Promise<void> {
    let response: string | null;
    try {
      response = await protocol.handleLine(line);
    } catch (error: unknown) {
      process.stderr.write(`mcp: ${error instanceof Error ? error.message : String(error)}\n`);
      await stop("error");
      process.exit(1);
      return;
    }
    if (response !== null && stdoutOk && !stopping) {
      stdoutOk = await writeStdout(response);
    }
  }
  const tooLargeResponse = JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "message too large" },
  });
  const splitter = createLineSplitter(
    maxMessageBytes,
    (line: string) => {
      handleTransportLine(line).catch(() => undefined);
    },
    () => {
      (async () => {
        if (stdoutOk && !stopping) {
          stdoutOk = await writeStdout(tooLargeResponse);
        }
      })().catch(() => undefined);
    },
  );
  process.stdin.setEncoding("utf8");
  const done = new Promise<string>((resolve) => {
    process.stdin.on("data", (chunk: string) => {
      splitter.push(chunk);
    });
    process.stdin.on("end", () => {
      // A final line without a trailing newline is still a message (T3.2).
      splitter.flush();
      resolve("eof");
    });
    process.on("SIGTERM", () => {
      resolve("signal");
    });
    process.on("SIGINT", () => {
      resolve("signal");
    });
    process.stdout.on("error", () => {
      resolve("stdout-closed");
    });
  });
  const reason = await done;
  // A signal drops lines that have not started, so no call-start line is
  // written for them; the message in flight finishes first.
  if (reason === "signal") {
    protocol.abort();
  }
  await protocol.drain();
  process.stdin.destroy();
  await stop(reason === "stdout-closed" ? "stdout-closed" : reason);
  return 0;
}

const args = Bun.argv.slice(2);
let parsed: { caller: string; configPath: string };
try {
  parsed = parseArgs(args);
} catch (error: unknown) {
  process.stderr.write(`mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
const code = await serve(parsed.caller, parsed.configPath);
process.exit(code);

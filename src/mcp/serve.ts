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
import { MCP_CONFIG_PATH, loadMcpConfig } from "./config.js";
import { openCallLog } from "./call-log.js";
import type { CallLog } from "./call-log.js";
import { createTools } from "./tools.js";
import { loadWorkConfig } from "../work/config.js";
import { loadFactorySpecs } from "../work/specs.js";
import { loadDispatcherConfig } from "../dispatcher/config.js";
import { loadAuditorConfig } from "../auditor/config.js";
import { requireInputDir } from "../fs/input.js";
import { requireWritableTarget } from "../fs/write.js";

function parseArgs(args: readonly string[]): { caller: string; configPath: string } {
  let caller: string | null = null;
  let configPath = MCP_CONFIG_PATH;
  let configSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--caller") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || caller !== null) {
        throw new Error("--caller <name> is required exactly once");
      }
      caller = value;
      index += 1;
    } else if (arg === "--config") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || configSeen) {
        throw new Error("--config <path> is allowed at most once");
      }
      configPath = value;
      configSeen = true;
      index += 1;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  if (caller === null) {
    throw new Error("--caller <name> is required exactly once");
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
    throw new Error(`unknown caller "${caller}"`);
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
    throw new Error("call log unavailable");
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

// Every response travels through one serialized transport queue below: the
// write callback (and drain under backpressure) is awaited before the queue
// moves on, so awaiting the queue covers written bytes. Serialization also
// means at most one drain listener is ever pending. A failed write resolves
// false; a closed stream resolves false as well.
async function writeStdout(text: string): Promise<boolean> {
  const line = `${text}\n`;
  let accepted: boolean | null = null;
  const flushedPromise = new Promise<boolean>((resolve) => {
    const done = (error: Error | null | undefined) => {
      resolve(error === null || error === undefined);
    };
    try {
      accepted = process.stdout.write(line, done);
    } catch {
      resolve(false);
    }
  });
  // The write callback above may run before write() returns, so accepted
  // can be true here; a false return means the kernel buffer is full.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (accepted === false) {
    // Backpressure: wait until the kernel takes the buffered bytes (or the
    // stream goes away) before the transport queue moves on.
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        process.stdout.removeListener("drain", onDrain);
        process.stdout.removeListener("error", onGone);
        process.stdout.removeListener("close", onGone);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onGone = () => {
        cleanup();
        resolve();
      };
      process.stdout.once("drain", onDrain);
      process.stdout.once("error", onGone);
      process.stdout.once("close", onGone);
    });
  }
  const ok = await flushedPromise;
  if (!ok) {
    return false;
  }
  if (process.stdout.writableEnded || process.stdout.destroyed) {
    return false;
  }
  return true;
}

// Ends stdout and waits until the kernel has taken every buffered byte.
async function endStdoutAndWait(): Promise<void> {
  if (process.stdout.writableEnded || process.stdout.destroyed) {
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      resolve();
    };
    process.stdout.once("finish", done);
    process.stdout.once("error", done);
    try {
      process.stdout.end(done);
    } catch {
      done();
    }
  });
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
  // One serialized transport queue: each task awaits its protocol line and
  // then the stdout write (callback, plus drain under backpressure) before
  // the queue moves on, so awaiting transportTail covers written bytes.
  // Serialization also means at most one drain listener is ever pending.
  let transportTail: Promise<void> = Promise.resolve();
  let transportFailed = false;
  function enqueueTransport(task: () => Promise<void>): void {
    const next = transportTail.then(async () => {
      if (stdoutOk && !stopping) {
        await task();
      }
    });
    transportTail = next.then(
      () => undefined,
      () => undefined,
    );
  }
  // Both transport failure branches (a rejected protocol line here, a
  // rejected too-large line below) resolve `done` with the internal reason
  // "transport-failed" through the resolver shared with the stdin, signal
  // and stdout listeners, so the shutdown below wakes even though stdin
  // never ends after destroy(). Each branch prints one stderr line, aborts
  // the protocol and stops reading stdin. No path reaches this with
  // fleet_status today (H7, R2-6).
  let resolveDone: (reason: string) => void = () => undefined;
  async function handleTransportLine(line: string): Promise<void> {
    let response: string | null;
    try {
      response = await protocol.handleLine(line);
    } catch (error: unknown) {
      process.stderr.write(`mcp: ${error instanceof Error ? error.message : String(error)}\n`);
      protocol.abort();
      process.stdin.destroy();
      transportFailed = true;
      resolveDone("transport-failed");
      return;
    }
    if (response !== null) {
      stdoutOk = await writeStdout(response);
    }
  }
  const splitter = createLineSplitter(
    maxMessageBytes,
    (line: string) => {
      enqueueTransport(() => handleTransportLine(line));
    },
    () => {
      enqueueTransport(async () => {
        let response: string | null;
        try {
          response = await protocol.handleTooLarge();
        } catch (error: unknown) {
          process.stderr.write(`mcp: ${error instanceof Error ? error.message : String(error)}\n`);
          protocol.abort();
          process.stdin.destroy();
          transportFailed = true;
          resolveDone("transport-failed");
          return;
        }
        // An aborted protocol answers no too-large line, as it answers
        // no other line (H8, R2-7): serve writes nothing for null.
        if (response !== null) {
          stdoutOk = await writeStdout(response);
        }
      });
    },
  );
  process.stdin.setEncoding("utf8");
  // A signal aborts the protocol even when stdin already ended: resolve()
  // is a no-op then, but the abort still drops every queued line and the
  // stop reason below still becomes "signal".
  let sawSignal: boolean = false;
  const done = new Promise<string>((resolve) => {
    resolveDone = resolve;
    process.stdin.on("data", (chunk: string) => {
      splitter.push(chunk);
    });
    process.stdin.on("end", () => {
      // A final line without a trailing newline is still a message (T3.2).
      splitter.flush();
      resolveDone("eof");
    });
    const onSignal = () => {
      sawSignal = true;
      protocol.abort();
      resolveDone("signal");
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    process.stdout.on("error", () => {
      resolveDone("stdout-closed");
    });
  });
  const reason = await done;
  // A signal or a closed stdout drops lines that have not started, so no
  // call-start line is written for them; the message in flight finishes
  // first (T3.4). The reason is read after the drain below: a signal can
  // arrive after stdin already ended, while a large write is still
  // blocked, and it must still win over "eof".
  if (reason === "signal" || reason === "stdout-closed" || reason === "transport-failed") {
    protocol.abort();
  }
  await protocol.drain();
  await transportTail;
  // A failed stdout write means the reader is gone: the stop reason is
  // "stdout-closed" whenever stdoutOk is false, even when stdin already
  // ended first (R2-9). The stdoutOk guard in enqueueTransport is what
  // skips the queued tasks after the close. A signal still wins (H2).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const stopReason = sawSignal ? "signal" : stdoutOk ? reason : "stdout-closed";
  switch (stopReason) {
    case "signal":
    case "stdout-closed": {
      protocol.abort();
      break;
    }
    default: {
      break;
    }
  }
  process.stdin.destroy();
  // transportFailed is only assigned inside the serialized queue, so by
  // this await its value is final; a failure skips server-stop (L1) and
  // only sets the exit code.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!transportFailed) {
    await stop(stopReason === "stdout-closed" ? "stdout-closed" : stopReason);
  }
  // A rejected line leaves no server-stop line, so the logged reason stays
  // within eof|signal|stdout-closed (L1); the exit code still reports the
  // failure. The started writes drained above; end stdout and wait for its
  // finish before exiting 1. stdin was already destroyed in the failure
  // branch, and nothing here waits for its end.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (transportFailed) {
    await endStdoutAndWait();
    process.exitCode = 1;
    return 1;
  }
  // On EOF and on signal the server ends stdout and waits for its finish,
  // so the last buffered bytes reach the client before the process exits.
  if (stopReason === "eof" || stopReason === "signal") {
    await endStdoutAndWait();
  }
  process.exitCode = 0;
  return 0;
}

const args = Bun.argv.slice(2);
let parsed: { caller: string; configPath: string } | null = null;
try {
  parsed = parseArgs(args);
} catch (error: unknown) {
  process.stderr.write(`mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
if (process.exitCode === undefined && parsed !== null) {
  process.exitCode = await serve(parsed.caller, parsed.configPath);
}

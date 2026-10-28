// MCP client used by mcp:call: spawns serve.ts over stdio pipes, sends
// initialize, notifications/initialized and tools/call, then prints the
// structuredContent as one compact JSON line.
import { fileURLToPath } from "node:url";

export class ClientError extends Error {
  readonly code: number;
  constructor(code: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClientError";
    this.code = code;
  }
}

export interface ClientOptions {
  readonly tool: string;
  readonly args: unknown;
  readonly configPath: string;
  readonly serverVersion: string;
  readonly clientTimeoutMs: number;
}

function sendLine(sink: { write(chunk: string): void }, value: unknown): void {
  sink.write(`${JSON.stringify(value)}\n`);
}

interface JsonRpcResponse {
  readonly result?: {
    readonly structuredContent?: unknown;
    readonly content?: unknown;
  };
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

export async function runClientCall(options: ClientOptions): Promise<unknown> {
  const servePath = fileURLToPath(new URL("./serve.ts", import.meta.url));
  const args = [servePath, "--caller", "mcp-call", "--config", options.configPath];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([process.execPath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
  } catch (error: unknown) {
    throw new ClientError(4, `mcp:call: cannot start server (${String(error)})`, { cause: error });
  }
  const sink = proc.stdin as unknown as { write(chunk: string): void; end(): void };
  const stdout = proc.stdout as unknown as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let done = false;
  async function readLine(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        return line;
      }
      if (done) {
        throw new ClientError(4, "mcp:call: server exited before answering");
      }
      const rest = deadline - Date.now();
      if (rest <= 0) {
        throw new ClientError(4, `mcp:call: no answer within ${String(timeoutMs)} ms`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, rest);
      });
      const next = await Promise.race([reader.read(), timeoutPromise]);
      clearTimeout(timer);
      if (next === "timeout") {
        throw new ClientError(4, `mcp:call: no answer within ${String(timeoutMs)} ms`);
      }
      if (next.done) {
        done = true;
        const tail = decoder.decode();
        if (tail.length > 0) {
          pending += tail;
        }
        continue;
      }
      pending += decoder.decode(next.value, { stream: true });
    }
  }
  function parseResponse(line: string): JsonRpcResponse {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new ClientError(4, "mcp:call: malformed response");
    }
    const candidate = raw;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new ClientError(4, "mcp:call: malformed response");
    }
    return raw as JsonRpcResponse;
  }
  try {
    sendLine(sink, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "mcp-call", version: options.serverVersion },
      },
    });
    const initRaw = parseResponse(await readLine(options.clientTimeoutMs));
    if (initRaw.error !== undefined) {
      throw new ClientError(4, `mcp:call: server error ${String(initRaw.error.message)}`);
    }
    if (initRaw.result === undefined) {
      throw new ClientError(4, "mcp:call: malformed response");
    }
    sendLine(sink, { jsonrpc: "2.0", method: "notifications/initialized" });
    sendLine(sink, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: options.tool, arguments: options.args },
    });
    const callRaw = parseResponse(await readLine(options.clientTimeoutMs));
    if (callRaw.error !== undefined) {
      throw new ClientError(4, `mcp:call: server error ${String(callRaw.error.message)}`);
    }
    const structured = callRaw.result?.structuredContent;
    if (
      typeof structured !== "object" ||
      structured === null ||
      Array.isArray(structured) ||
      typeof (structured as Record<string, unknown>)["ok"] !== "boolean"
    ) {
      throw new ClientError(4, "mcp:call: malformed response");
    }
    return structured;
  } finally {
    try {
      sink.end();
    } catch {
      // The server may already have exited; closing stdin adds nothing.
    }
    let exited = false;
    try {
      await Promise.race([
        proc.exited.then(() => {
          exited = true;
        }),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve();
          }, 1000);
        }),
      ]);
    } catch {
      // Waiting for the child adds no new failure mode.
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!exited) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // The child may have exited between the race and the kill.
      }
      await proc.exited.catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // Reader already released when the server exited.
    }
  }
}

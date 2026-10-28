// MCP JSON-RPC protocol (P1-P10 without transport).
// Line framing (createLineSplitter) and message semantics live here;
// serve.ts only moves bytes between stdio and the queue (T4). Tool results
// never carry exception text.
import { canonicalJson, sha256Hex } from "../work/canonical.js";
import type { CallLog } from "./call-log.js";
import type { McpServerInfo } from "./config.js";

export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export const LATEST_PROTOCOL_VERSION = "2025-11-25";

export type ToolClass = "read" | "write" | "sensitive";

export type ToolErrorCode = string;

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly [detail: string]: unknown;
}

export type ToolPayload =
  | { readonly ok: true; readonly [field: string]: unknown }
  | { readonly ok: false; readonly error: ToolError };

export interface ToolOutcome {
  readonly payload: ToolPayload;
  readonly summary: Readonly<Record<string, unknown>> | null;
  readonly detail: string | null;
}

export interface ToolContext {
  readonly caller: string;
  readonly now: () => Date;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly toolClass: ToolClass;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly validate: (args: unknown) => { readonly path: string; readonly keyword: string } | null;
  run(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

export interface ProtocolDeps {
  readonly tools: readonly ToolDefinition[];
  readonly serverInfo: McpServerInfo;
  readonly caller: string;
  readonly callLog: CallLog;
  readonly now: () => Date;
  readonly runId: string;
}

export interface Protocol {
  handleLine(line: string): Promise<string | null>;
  handleTooLarge(): Promise<string>;
  abort(): void;
  drain(): Promise<void>;
}

export interface LineSplitter {
  push(chunk: string | Buffer): void;
  flush(): void;
}

const TOOL_NAME_PATTERN = /^[a-z_]{1,64}$/;
const METHOD_PATTERN = /^[a-z/_]{1,64}$/;
const CLIENT_PATTERN = /^[\x20-\x7e]{1,64}$/;
const TOOL_ORDER: readonly string[] = [
  "fleet_status",
  "list_work",
  "audit_results",
  "submit_work",
  "approve",
  "pause_fleet",
];

const REFUSED_CODES: ReadonlySet<string> = new Set([
  "invalid-arguments",
  "item-too-large",
  "contract-invalid",
  "loop-state-not-initial",
  "repo-not-configured",
  "model-not-allowed",
  "duplicate-id",
  "id-exists",
  "unknown-dependency",
  "dag-cycle",
  "store-full",
  "unknown-work-item",
  "not-in-review",
  "pull-mismatch",
  "too-many-pending",
  "no-change",
]);

function outcomeFor(code: string): "ok" | "refused" | "error" {
  if (REFUSED_CODES.has(code)) {
    return "refused";
  }
  return "error";
}

function readParam(params: unknown, key: string): unknown {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  return (params as Record<string, unknown>)[key];
}

function isSafeId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function errorMessage(code: number, extra: string | null): string {
  switch (code) {
    case -32700:
      return "parse error";
    case -32600:
      return extra ?? "invalid request";
    case -32601:
      return "method not found";
    case -32602:
      return extra ?? "invalid params";
    default:
      return "invalid request";
  }
}

function annotationsFor(toolClass: ToolClass): Record<string, boolean> {
  if (toolClass === "read") {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function advertisedEntry(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: annotationsFor(tool.toolClass),
  };
}

export function createLineSplitter(
  maxBytes: number,
  onLine: (line: string) => void,
  onTooLarge: () => void,
): LineSplitter {
  let pending = "";
  let discarding = false;
  function handleComplete(raw: string): void {
    let line = raw;
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.length === 0) {
      return;
    }
    if (Buffer.byteLength(line, "utf8") > maxBytes) {
      onTooLarge();
      return;
    }
    onLine(line);
  }
  return {
    push(chunk: string | Buffer): void {
      let text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (discarding) {
        // A line already reported as too large: skip input up to and
        // including the next newline, so a runaway line stays bounded
        // by maxBytes plus one chunk (P1).
        const newlineAt = text.indexOf("\n");
        if (newlineAt === -1) {
          return;
        }
        discarding = false;
        text = text.slice(newlineAt + 1);
      }
      pending += text;
      let newlineAt = pending.indexOf("\n");
      while (newlineAt !== -1) {
        const raw = pending.slice(0, newlineAt);
        pending = pending.slice(newlineAt + 1);
        handleComplete(raw);
        newlineAt = pending.indexOf("\n");
      }
      // Without a newline the line is still incomplete: once its bytes
      // exceed the limit, report it once, drop it, and discard input
      // up to and including the next newline (P1).
      if (Buffer.byteLength(pending, "utf8") > maxBytes) {
        onTooLarge();
        pending = "";
        discarding = true;
      }
    },
    flush(): void {
      if (discarding) {
        pending = "";
        discarding = false;
        return;
      }
      if (pending.length === 0) {
        return;
      }
      const raw = pending;
      pending = "";
      handleComplete(raw);
    },
  };
}

export function createProtocol(deps: ProtocolDeps): Protocol {
  const { tools, serverInfo, caller, callLog, now, runId } = deps;
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    byName.set(tool.name, tool);
  }
  let didInitialize = false;
  let storedClient: { readonly name: string; readonly version: string } | null = null;
  let nextCallId = 1;
  let logFailed = false;
  let queue: Promise<void> = Promise.resolve();
  let aborted = false;

  function sanitizedMethod(value: unknown): string | null {
    return typeof value === "string" && METHOD_PATTERN.test(value) ? value : null;
  }

  function sanitizedTool(value: unknown): string | null {
    return typeof value === "string" && TOOL_NAME_PATTERN.test(value) ? value : null;
  }

  async function handleTooLarge(): Promise<string> {
    await logProtocolError(-32600, null, null);
    return jsonError(null, -32600, "message too large");
  }

  async function appendLog(entry: Record<string, unknown>): Promise<boolean> {
    try {
      await callLog.append(entry);
      return true;
    } catch (error: unknown) {
      logFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`mcp: call log append failed: ${message}\n`);
      return false;
    }
  }

  async function logProtocolError(code: number, method: unknown, tool: unknown): Promise<void> {
    await appendLog({
      ts: now().toISOString(),
      event: "protocol-error",
      run: runId,
      caller,
      jsonrpcCode: code,
      method: sanitizedMethod(method),
      tool: sanitizedTool(tool),
    });
  }

  function jsonError(id: string | number | null, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function toolResult(id: string | number | null, payload: ToolPayload): string {
    const failed = !payload.ok;
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: failed,
      },
    });
  }

  async function processLine(line: string): Promise<string | null> {
    if (line.trim().length === 0) {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      await logProtocolError(-32700, null, null);
      return jsonError(null, -32700, errorMessage(-32700, null));
    }
    if (Array.isArray(raw)) {
      await logProtocolError(-32600, null, null);
      return jsonError(null, -32600, "batch not supported");
    }
    if (typeof raw !== "object" || raw === null) {
      await logProtocolError(-32600, null, null);
      return jsonError(null, -32600, errorMessage(-32600, null));
    }
    const msg = raw as Record<string, unknown>;
    const rawId: unknown = msg["id"];
    if (msg["jsonrpc"] !== "2.0") {
      const id: string | number | null = isSafeId(rawId) ? rawId : null;
      await logProtocolError(-32600, msg["method"], null);
      return jsonError(id, -32600, errorMessage(-32600, null));
    }
    const hasId = "id" in msg;
    const idValue: unknown = msg["id"];
    if (hasId && !isSafeId(idValue)) {
      await logProtocolError(-32600, msg["method"], null);
      return jsonError(null, -32600, errorMessage(-32600, null));
    }
    const id = hasId ? (idValue as string | number) : null;
    const method: unknown = msg["method"];

    if (method === undefined || method === null) {
      if ("result" in msg || "error" in msg) {
        return null;
      }
      if (!hasId) {
        return null;
      }
      await logProtocolError(-32600, method, null);
      return jsonError(id, -32600, errorMessage(-32600, null));
    }
    if (typeof method !== "string") {
      if (!hasId) {
        return null;
      }
      await logProtocolError(-32600, method, null);
      return jsonError(id, -32600, errorMessage(-32600, null));
    }

    if (!hasId) {
      return null;
    }

    if (method === "initialize") {
      if (didInitialize) {
        await logProtocolError(-32600, method, null);
        return jsonError(id, -32600, "already initialized");
      }
      const versionValue: unknown = readParam(msg["params"], "protocolVersion");
      const nameValue: unknown = readParam(readParam(msg["params"], "clientInfo"), "name");
      const versionInfo: unknown = readParam(readParam(msg["params"], "clientInfo"), "version");
      // Only a non-string name is invalid params (P2); an empty name
      // initializes with client null, like any other pattern mismatch.
      if (typeof versionValue !== "string" || typeof nameValue !== "string") {
        await logProtocolError(-32602, method, null);
        return jsonError(id, -32602, errorMessage(-32602, null));
      }
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(versionValue)
        ? versionValue
        : LATEST_PROTOCOL_VERSION;
      const client =
        typeof versionInfo === "string" &&
        CLIENT_PATTERN.test(nameValue) &&
        CLIENT_PATTERN.test(versionInfo)
          ? { name: nameValue, version: versionInfo }
          : null;
      didInitialize = true;
      storedClient = client;
      await appendLog({
        ts: now().toISOString(),
        event: "session-init",
        run: runId,
        caller,
        client,
        protocolVersion: negotiated,
      });
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverInfo.name, version: serverInfo.version },
        },
      });
    }

    if (method === "ping") {
      return JSON.stringify({ jsonrpc: "2.0", id, result: {} });
    }

    if (method === "tools/list" || method === "tools/call") {
      if (!didInitialize) {
        await logProtocolError(-32600, method, null);
        return jsonError(id, -32600, "server not initialized");
      }
    }

    if (method === "tools/list") {
      const ordered = [...tools].sort((a, b) => {
        const ai = TOOL_ORDER.indexOf(a.name);
        const bi = TOOL_ORDER.indexOf(b.name);
        return (ai === -1 ? TOOL_ORDER.length : ai) - (bi === -1 ? TOOL_ORDER.length : bi);
      });
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { tools: ordered.map((tool) => advertisedEntry(tool)) },
      });
    }

    if (method === "tools/call") {
      const name: unknown = readParam(msg["params"], "name");
      const args: unknown = readParam(msg["params"], "arguments");
      const argsInvalid: boolean =
        args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args));
      if (typeof name !== "string" || argsInvalid) {
        await logProtocolError(-32602, method, typeof name === "string" ? name : null);
        return jsonError(id, -32602, errorMessage(-32602, null));
      }
      const tool = byName.get(name);
      if (tool === undefined) {
        const message = TOOL_NAME_PATTERN.test(name) ? `Unknown tool: ${name}` : "Unknown tool";
        await logProtocolError(-32602, method, name);
        return jsonError(id, -32602, message);
      }
      if (logFailed) {
        const payload: ToolPayload = {
          ok: false,
          error: {
            code: "call-log-unavailable",
            message: "call log unavailable",
            retryable: false,
          },
        };
        return toolResult(id, payload);
      }
      const callId = nextCallId;
      nextCallId += 1;
      const start = now();
      const argsValue: unknown = args ?? {};
      const argsText = canonicalJson(argsValue);
      const clientForCall: { readonly name: string; readonly version: string } | null =
        storedClient;
      const startOk = await appendLog({
        ts: start.toISOString(),
        event: "call-start",
        run: runId,
        callId,
        caller,
        client: clientForCall,
        tool: tool.name,
        class: tool.toolClass,
        argsSha256: sha256Hex(argsText),
        argsBytes: Buffer.byteLength(argsText, "utf8"),
      });
      if (!startOk) {
        const payload: ToolPayload = {
          ok: false,
          error: {
            code: "call-log-unavailable",
            message: "call log unavailable",
            retryable: false,
          },
        };
        return toolResult(id, payload);
      }
      const failed = tool.validate(argsValue);
      if (failed !== null) {
        const payload: ToolPayload = {
          ok: false,
          error: {
            code: "invalid-arguments",
            message: `invalid arguments at ${failed.path} (${failed.keyword})`,
            retryable: false,
            path: failed.path,
            keyword: failed.keyword,
          },
        };
        const end = now();
        await appendLog({
          ts: end.toISOString(),
          event: "call-end",
          run: runId,
          callId,
          caller,
          tool: tool.name,
          class: tool.toolClass,
          outcome: "refused",
          code: "invalid-arguments",
          durationMs: end.getTime() - start.getTime(),
          summary: null,
          detail: null,
        });
        return toolResult(id, payload);
      }
      let outcome: ToolOutcome;
      try {
        outcome = await tool.run(argsValue, { caller, now });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        const payload: ToolPayload = {
          ok: false,
          error: { code: "internal-error", message: "internal error", retryable: false },
        };
        const end = now();
        await appendLog({
          ts: end.toISOString(),
          event: "call-end",
          run: runId,
          callId,
          caller,
          tool: tool.name,
          class: tool.toolClass,
          outcome: "error",
          code: "internal-error",
          durationMs: end.getTime() - start.getTime(),
          summary: null,
          detail,
        });
        return toolResult(id, payload);
      }
      const end = now();
      const code = outcome.payload.ok ? null : outcome.payload.error.code;
      await appendLog({
        ts: end.toISOString(),
        event: "call-end",
        run: runId,
        callId,
        caller,
        tool: tool.name,
        class: tool.toolClass,
        outcome: outcome.payload.ok ? "ok" : outcomeFor(code ?? "internal-error"),
        code,
        durationMs: end.getTime() - start.getTime(),
        summary: outcome.summary,
        detail: outcome.detail,
      });
      return toolResult(id, outcome.payload);
    }

    await logProtocolError(-32601, method, null);
    return jsonError(id, -32601, errorMessage(-32601, null));
  }

  return {
    handleTooLarge(): Promise<string> {
      const task = queue.then(() =>
        aborted ? jsonError(null, -32600, "message too large") : handleTooLarge(),
      );
      queue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    handleLine(line: string): Promise<string | null> {
      if (aborted) {
        return Promise.resolve(null);
      }
      const task = queue.then(() => (aborted ? null : processLine(line)));
      queue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    abort(): void {
      aborted = true;
    },
    drain(): Promise<void> {
      return queue;
    },
  };
}

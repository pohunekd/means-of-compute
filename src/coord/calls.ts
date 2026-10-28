// Coordinator call-log reader: parses the MCP server's JSONL call log and
// returns the coordinator's call-end entries in file order. An absent file
// yields null; the launcher's entries are filtered out.
import { InputPathError, readInputText, statInputPath } from "../fs/input.js";
import type { ToolClass } from "../mcp/protocol.js";

export const COORDINATOR_CALLER = "coordinator";
export const LAUNCHER_CALLER = "mcp-call";

export interface CoordCallEnd {
  readonly ts: string;
  readonly event: "call-end";
  readonly run: string;
  readonly callId: number;
  readonly caller: string;
  readonly tool: string;
  readonly class: ToolClass;
  readonly outcome: "ok" | "refused" | "error";
  readonly code: string | null;
  readonly durationMs: number;
  readonly summary: Readonly<Record<string, unknown>> | null;
  readonly detail: string | null;
}

export class RunCallsDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunCallsDataError";
  }
}

const CALL_END_KEYS: readonly string[] = [
  "ts",
  "event",
  "run",
  "callId",
  "caller",
  "tool",
  "class",
  "outcome",
  "code",
  "durationMs",
  "summary",
  "detail",
];

function parseCallEnd(value: Record<string, unknown>): CoordCallEnd | null {
  if (Object.keys(value).length !== CALL_END_KEYS.length) {
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!CALL_END_KEYS.includes(key)) {
      return null;
    }
  }
  const ts: unknown = value["ts"];
  const run: unknown = value["run"];
  const callId: unknown = value["callId"];
  const caller: unknown = value["caller"];
  const tool: unknown = value["tool"];
  const toolClass: unknown = value["class"];
  const outcome: unknown = value["outcome"];
  const code: unknown = value["code"];
  const durationMs: unknown = value["durationMs"];
  const summary: unknown = value["summary"];
  const detail: unknown = value["detail"];
  if (typeof ts !== "string") {
    return null;
  }
  if (value["event"] !== "call-end") {
    return null;
  }
  if (typeof run !== "string") {
    return null;
  }
  if (typeof callId !== "number" || !Number.isInteger(callId) || callId < 1) {
    return null;
  }
  if (typeof caller !== "string" || caller.length === 0) {
    return null;
  }
  if (typeof tool !== "string" || tool.length === 0) {
    return null;
  }
  if (toolClass !== "read" && toolClass !== "write" && toolClass !== "sensitive") {
    return null;
  }
  if (outcome !== "ok" && outcome !== "refused" && outcome !== "error") {
    return null;
  }
  if (code !== null && typeof code !== "string") {
    return null;
  }
  if (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 0) {
    return null;
  }
  if (summary !== null && (typeof summary !== "object" || Array.isArray(summary))) {
    return null;
  }
  let summaryRecord: Readonly<Record<string, unknown>> | null = null;
  if (summary !== null) {
    if (typeof summary !== "object" || Array.isArray(summary)) {
      return null;
    }
    const entries = Object.entries(summary);
    const rebuilt: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      rebuilt[key] = entry;
    }
    summaryRecord = rebuilt;
  }
  let detailText: string | null = null;
  if (detail !== null) {
    if (typeof detail !== "string") {
      return null;
    }
    detailText = detail;
  }
  return {
    ts,
    event: "call-end",
    run,
    callId,
    caller,
    tool,
    class: toolClass,
    outcome,
    code,
    durationMs,
    summary: summaryRecord,
    detail: detailText,
  };
}

export async function readCoordCalls(path: string): Promise<readonly CoordCallEnd[] | null> {
  const label = "Run calls";
  try {
    if ((await statInputPath(label, path)) === "absent") {
      return null;
    }
    const text = await readInputText(label, path);
    const segments = text.split("\n");
    segments.pop();
    const result: CoordCallEnd[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const line = segments[index] as string;
      const n = index + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new RunCallsDataError(
          `Run calls ${path}: line ${String(n)} is not a JSON object with a string event`,
        );
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>)["event"] !== "string"
      ) {
        throw new RunCallsDataError(
          `Run calls ${path}: line ${String(n)} is not a JSON object with a string event`,
        );
      }
      const record = parsed as Record<string, unknown>;
      if (record["event"] === "call-end") {
        const entry = parseCallEnd(record);
        if (entry === null) {
          throw new RunCallsDataError(
            `Run calls ${path}: line ${String(n)} is not a valid call-end`,
          );
        }
        if (entry.caller === COORDINATOR_CALLER) {
          result.push(entry);
        }
      }
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof RunCallsDataError) {
      throw error;
    }
    if (error instanceof InputPathError) {
      throw new RunCallsDataError(error.message, { cause: error });
    }
    throw error;
  }
}

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
  if (
    typeof value["ts"] !== "string" ||
    value["event"] !== "call-end" ||
    typeof value["run"] !== "string" ||
    typeof value["callId"] !== "number" ||
    !Number.isInteger(value["callId"]) ||
    (value["callId"] as number) < 1 ||
    typeof value["caller"] !== "string" ||
    (value["caller"] as string).length === 0 ||
    typeof value["tool"] !== "string" ||
    (value["tool"] as string).length === 0 ||
    (value["class"] !== "read" && value["class"] !== "write" && value["class"] !== "sensitive") ||
    (value["outcome"] !== "ok" && value["outcome"] !== "refused" && value["outcome"] !== "error") ||
    (value["code"] !== null && typeof value["code"] !== "string") ||
    typeof value["durationMs"] !== "number" ||
    !Number.isInteger(value["durationMs"]) ||
    (value["durationMs"] as number) < 0 ||
    (value["summary"] !== null &&
      (typeof value["summary"] !== "object" || Array.isArray(value["summary"]))) ||
    (value["detail"] !== null && typeof value["detail"] !== "string")
  ) {
    return null;
  }
  return {
    ts: value["ts"] as string,
    event: "call-end",
    run: value["run"] as string,
    callId: value["callId"] as number,
    caller: value["caller"] as string,
    tool: value["tool"] as string,
    class: value["class"] as ToolClass,
    outcome: value["outcome"] as "ok" | "refused" | "error",
    code: value["code"] as string | null,
    durationMs: value["durationMs"] as number,
    summary: value["summary"] as Readonly<Record<string, unknown>> | null,
    detail: value["detail"] as string | null,
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

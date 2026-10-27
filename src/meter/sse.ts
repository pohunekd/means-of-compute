// Pure incremental usage taps of section 3.6. One tap decodes streamed
// server-sent events, the other buffers a single non-streaming body.
import type { CallOutcome } from "./usage-log.js";

export type UsageSeen =
  | { readonly seen: true; readonly inputTokens: number | null; readonly outputTokens: number | null }
  | { readonly seen: false };

export interface UsageTap {
  push(chunk: Uint8Array): void;
  end(): UsageSeen;
}

export function usageCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function candidateCounts(payload: unknown): UsageSeen {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { seen: false };
  }
  const usage = (payload as Record<string, unknown>)["usage"];
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return { seen: false };
  }
  const record = usage as Record<string, unknown>;
  return {
    seen: true,
    inputTokens: usageCount(record["prompt_tokens"]),
    outputTokens: usageCount(record["completion_tokens"]),
  };
}

const DATA_PREFIX = "data:";

function payloadOfLine(line: string): string | null {
  if (!line.startsWith(DATA_PREFIX)) {
    return null;
  }
  const rest = line.slice(DATA_PREFIX.length);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

export function createSseUsageTap(maxLineBytes: number): UsageTap {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let overflowLine = false;
  let last: UsageSeen = { seen: false };
  return {
    push(chunk: Uint8Array): void {
      const text = decoder.decode(chunk, { stream: true });
      for (const char of text) {
        if (char === "\n") {
          const line = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
          pending = "";
          if (overflowLine) {
            overflowLine = false;
            continue;
          }
          const payload = payloadOfLine(line);
          if (payload === null || payload === "[DONE]") {
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload) as unknown;
          } catch {
            continue;
          }
          const candidate = candidateCounts(parsed);
          if (candidate.seen) {
            last = candidate;
          }
        } else {
          pending += char;
          if (pending.length > maxLineBytes) {
            overflowLine = true;
            pending = "";
          }
        }
      }
    },
    end(): UsageSeen {
      return last;
    },
  };
}

export function createJsonUsageTap(maxBytes: number): UsageTap {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  return {
    push(chunk: Uint8Array): void {
      if (overflow) {
        return;
      }
      if (size + chunk.length > maxBytes) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    end(): UsageSeen {
      if (overflow) {
        return { seen: false };
      }
      const body = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        return { seen: false };
      }
      return candidateCounts(parsed);
    },
  };
}

export const SSE_OUTCOMES = ["ok", "no-usage"] as const satisfies readonly CallOutcome[];

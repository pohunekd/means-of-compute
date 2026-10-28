// Pure incremental usage taps of section 3.6. One tap decodes streamed
// server-sent events, the other buffers a single non-streaming body.

export type UsageSeen =
  | {
      readonly seen: true;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    }
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

// The tap works on bytes. Raw chunks split on byte 0x0A (UTF-8 never
// has 0x0A inside a sequence); the current line accumulates as byte
// parts, with lineBytes excluding the \n. Past the limit, overflow sticks
// for the whole stream and bytes drop up to the next 0x0A. A complete line
// decodes with one TextDecoder pass, one trailing \r strips, then the 3.6
// parsing applies. end() returns {seen:false} when overflow is set.
export function createSseUsageTap(maxLineBytes: number): UsageTap {
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  let overflow = false;
  let last: UsageSeen = { seen: false };
  const decoder = new TextDecoder("utf-8");
  function takeLine(): void {
    if (!overflow) {
      const bytes = Buffer.concat(parts);
      let line = decoder.decode(bytes);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      const payload = payloadOfLine(line);
      if (payload !== null && payload !== "[DONE]") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload) as unknown;
        } catch {
          parsed = null;
        }
        if (parsed !== null) {
          const candidate = candidateCounts(parsed);
          if (candidate.seen) {
            last = candidate;
          }
        }
      }
    }
    parts = [];
    lineBytes = 0;
  }
  return {
    push(chunk: Uint8Array): void {
      let start = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === 0x0a) {
          // The limit counts the bytes of every line part the moment
          // it arrives, including a completed line still in this chunk.
          parts.push(chunk.slice(start, i));
          lineBytes += i - start;
          start = i + 1;
          if (lineBytes > maxLineBytes) {
            overflow = true;
          }
          if (!overflow) {
            takeLine();
          } else {
            parts = [];
            lineBytes = 0;
          }
        }
      }
      if (start < chunk.length && !overflow) {
        const piece = chunk.slice(start);
        parts.push(piece);
        lineBytes += piece.length;
        if (lineBytes > maxLineBytes) {
          overflow = true;
          parts = [];
          lineBytes = 0;
        }
      }
    },
    end(): UsageSeen {
      if (overflow) {
        return { seen: false };
      }
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

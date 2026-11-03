// Meter usage taps (row 1): the cached input count is read from the last
// usage object and recorded only when it is an integer from 0 to the input.
import { expect, test } from "bun:test";
import { createJsonUsageTap, createSseUsageTap, type UsageSeen } from "../../src/meter/sse.js";

const LIMIT = 1 << 20;

function jsonSeen(body: unknown): UsageSeen {
  const tap = createJsonUsageTap(LIMIT);
  tap.push(new TextEncoder().encode(JSON.stringify(body)));
  return tap.end();
}

test("cached count is kept when valid and dropped when missing or above input", () => {
  // Counts of the 2026-11-03 Baseten probe; usage comes in several chunks, the last is final.
  const sse = createSseUsageTap(LIMIT);
  const events = [
    { choices: [{ delta: { content: "ok" } }], usage: null },
    { usage: { prompt_tokens: 8551, completion_tokens: 1, prompt_tokens_details: null } },
    {
      usage: {
        prompt_tokens: 8551,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 8448 },
      },
    },
  ];
  sse.push(
    new TextEncoder().encode(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    ),
  );
  expect(sse.end()).toEqual({
    seen: true,
    inputTokens: 8551,
    outputTokens: 2,
    cachedInputTokens: 8448,
  });
  expect(jsonSeen({ usage: { prompt_tokens: 8551, completion_tokens: 2 } })).toEqual({
    seen: true,
    inputTokens: 8551,
    outputTokens: 2,
  });
  expect(
    jsonSeen({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 101 },
      },
    }),
  ).toEqual({ seen: true, inputTokens: 100, outputTokens: 2 });
});

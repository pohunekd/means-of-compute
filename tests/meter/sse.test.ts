// SSE tap tests: split events, last-wins, ignored choices usage, overflow,
// and non-integer counts.
import { expect, test } from "bun:test";
import { createJsonUsageTap, createSseUsageTap } from "../../src/meter/sse.js";

function chunk(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

test("a usage event split across chunks is found", () => {
  const tap = createSseUsageTap(1024);
  tap.push(chunk('data: {"usage": {"prompt_tokens": 12'));
  tap.push(chunk('00, "completion_tokens": 80}}\n\n'));
  const seen = tap.end();
  expect(seen.seen).toBe(true);
  if (seen.seen) {
    expect(seen.inputTokens).toBe(1200);
    expect(seen.outputTokens).toBe(80);
  }
});

test("the last of two usage events wins", () => {
  const tap = createSseUsageTap(1024);
  tap.push(chunk('data: {"usage": {"prompt_tokens": 1, "completion_tokens": 1}}\n\n'));
  tap.push(chunk('data: {"usage": {"prompt_tokens": 9, "completion_tokens": 8}}\n\n'));
  const seen = tap.end();
  expect(seen.seen).toBe(true);
  if (seen.seen) {
    expect(seen.inputTokens).toBe(9);
    expect(seen.outputTokens).toBe(8);
  }
});

test("choices usage alone leaves nothing seen", () => {
  const tap = createSseUsageTap(1024);
  tap.push(chunk('data: {"choices": [{"usage": {"prompt_tokens": 5}}]}\n\n'));
  expect(tap.end().seen).toBe(false);
});

test("a line over the scan limit is discarded with a later usage line", () => {
  const tap = createSseUsageTap(16);
  tap.push(chunk("data: {\"usage\": {\"prompt_tokens\": 5, \"completion_tokens\": 5}}\n\n"));
  tap.push(chunk('data: {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}\n\n'));
  expect(tap.end().seen).toBe(false);
});

test("a string count gives a null input", () => {
  const tap = createSseUsageTap(1024);
  tap.push(chunk('data: {"usage": {"prompt_tokens": "12", "completion_tokens": 4}}\n\n'));
  const seen = tap.end();
  expect(seen.seen).toBe(true);
  if (seen.seen) {
    expect(seen.inputTokens).toBeNull();
    expect(seen.outputTokens).toBe(4);
  }
});

test("a non-streaming body over the limit is unseen", () => {
  const tap = createJsonUsageTap(10);
  tap.push(chunk('{"usage": {"prompt_tokens": 1}}'));
  expect(tap.end().seen).toBe(false);
});

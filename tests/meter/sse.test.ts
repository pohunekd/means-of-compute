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

test("an overflowed line makes the whole stream unseen", () => {
  const tap = createSseUsageTap(1024);
  tap.push(chunk(`data: ${"x".repeat(2000)}\n`));
  tap.push(chunk('data: {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}\n\n'));
  expect(tap.end().seen).toBe(false);
});

test("an earlier overflow nulls a later usage", () => {
  const tap = createSseUsageTap(1024);
  tap.push(chunk('data: {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}\n\n'));
  tap.push(chunk(`data: ${"x".repeat(2000)}\n`));
  tap.push(chunk('data: {"usage": {"prompt_tokens": 5, "completion_tokens": 4}}\n\n'));
  expect(tap.end().seen).toBe(false);
});

test("the limit counts bytes, not characters", () => {
  const tap = createSseUsageTap(64);
  // This usage line is 61 bytes and fits under the 64-byte limit.
  tap.push(chunk('data: {"usage": {"p": 1}}\n'));
  // `data: ` plus 30 `€` chars is 6 + 90 + 1 = 97 bytes but only
  // 6 + 30 + 1 = 37 UTF-16 units: a unit-counting tap would stay
  // under the limit, a byte-counting tap overflows and stays unseen.
  tap.push(chunk(`data: ${"€".repeat(30)}\n`));
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

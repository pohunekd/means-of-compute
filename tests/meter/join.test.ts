// Meter join (row 1): a billed call without usage counts in
// unmeasuredRequests instead of nulling the group. Row 2: cached counts sum
// per group and price at the cached rate.
import { expect, test } from "bun:test";
import { costOfRecord } from "../../src/budget/cost.js";
import { joinUsage } from "../../src/meter/join.js";
import type { CallEndRecord, UsageIndex } from "../../src/meter/usage-log.js";

const MODEL = "muse-spark-1.3-contributor";

function indexWith(timedOut: boolean): UsageIndex {
  const starts = new Map();
  const ends = new Map();
  const startOrder: string[] = [];
  const calls: { callId: string; input: number | null; output: number | null; billed: boolean }[] =
    [
      { callId: "c1", input: 100, output: 10, billed: true },
      { callId: "c2", input: 200, output: 20, billed: true },
    ];
  if (timedOut) {
    calls.push({ callId: "c3", input: null, output: null, billed: true });
  }
  for (const call of calls) {
    starts.set(call.callId, {
      kind: "call-start",
      at: "2026-10-30T10:00:00.000Z",
      callId: call.callId,
      requestId: "w1-demo:0",
      providerId: "meta-api",
      model: MODEL,
      stream: false,
    });
    startOrder.push(call.callId);
    ends.set(call.callId, {
      kind: "call-end",
      at: "2026-10-30T10:00:01.000Z",
      callId: call.callId,
      requestId: "w1-demo:0",
      outcome: call.input === null ? "first-byte-timeout" : "ok",
      billed: call.billed,
      status: call.input === null ? 504 : 200,
      inputTokens: call.input,
      outputTokens: call.output,
      clientGone: false,
      ms: 1,
      bytesIn: 1,
      bytesOut: 1,
    });
  }
  return {
    grants: new Map([
      [
        "w1-demo:0",
        {
          open: {
            kind: "grant-open",
            at: "2026-10-30T10:00:00.000Z",
            requestId: "w1-demo:0",
            workItemId: "w1-demo",
            hostAlias: "host-a",
            providerId: "meta-api",
            model: MODEL,
          },
          lastOpenAt: "2026-10-30T10:00:00.000Z",
          sessionId: null,
          closed: false,
        },
      ],
    ]),
    requestBySession: new Map(),
    starts,
    startOrder,
    ends,
  };
}

test("timed-out billed call counts as unmeasured, known sums kept", () => {
  const usage = joinUsage(indexWith(true), "w1-demo:0");
  expect(usage.tokens).toEqual([
    {
      provider: "meta-api",
      model: MODEL,
      inputTokens: 300,
      outputTokens: 30,
      requests: 3,
      unmeasuredRequests: 1,
      source: "meter-proxy",
    },
  ]);
});

test("calls without a timeout carry no unmeasured key", () => {
  const usage = joinUsage(indexWith(false), "w1-demo:0");
  expect(usage.tokens).toEqual([
    {
      provider: "meta-api",
      model: MODEL,
      inputTokens: 300,
      outputTokens: 30,
      requests: 2,
      source: "meter-proxy",
    },
  ]);
});

test("cached counts sum per group and price at the cached rate when priced", () => {
  const index = indexWith(false);
  const ends = index.ends as Map<string, CallEndRecord>;
  const first = ends.get("c1");
  if (first === undefined) {
    throw new Error("expected call c1");
  }
  ends.set("c1", { ...first, cachedInputTokens: 80 });
  const usage = joinUsage(index, "w1-demo:0");
  // c2 reported no cached count and adds 0.
  expect(usage.tokens.map((token) => token.cachedInputTokens)).toEqual([80]);
  const record = { workItemId: "w1-demo", finishedAt: "2026-10-30T10:00:01.000Z", ...usage };
  const bound = { inputTokens: 1, outputTokens: 1 };
  const bounds = { auditCall: bound, meterCall: bound, meterCallByProvider: new Map() };
  const price = { inputNanoPer1M: 100_000_000n, outputNanoPer1M: 200_000_000n };
  // 80 * 0.002 + 220 * 0.1 + 30 * 0.2 USD per 1M tokens, in nano-USD.
  const cached = new Map([["meta-api", { ...price, cachedInputNanoPer1M: 2_000_000n }]]);
  expect(costOfRecord(record, cached, bounds)).toBe(28_160n);
  // Without a cached price all 300 input tokens are charged at 0.1.
  expect(costOfRecord(record, new Map([["meta-api", price]]), bounds)).toBe(36_000n);
});

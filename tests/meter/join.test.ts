// Join tests: the unknown, unbilled, orphan and zero rules of section 4.4.
// L5 settles a real grant with zero billed calls and expects one
// all-zero row back, instead of hand-building records.
// Uses the live meter through the fixture.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinUsage } from "../../src/meter/join.js";
import { replayUsageLog } from "../../src/meter/usage-log.js";
import type { UsageLogRecord } from "../../src/meter/usage-log.js";
import { openBoundGrant, withMeter } from "./helpers.js";

function at(no: number): string {
  return new Date(Date.UTC(2026, 9, 27, 10, 0, no)).toISOString();
}

function grant(
  requestId: string,
  workItemId: string,
  providerId: string,
  model: string,
): UsageLogRecord {
  return {
    kind: "grant-open",
    at: at(1),
    requestId,
    workItemId,
    hostAlias: "laptop-a",
    providerId,
    model,
  };
}

function start(
  callId: string,
  requestId: string,
  providerId: string,
  model: string,
  no: number,
): UsageLogRecord {
  return { kind: "call-start", at: at(no), callId, requestId, providerId, model, stream: false };
}

function end(
  callId: string,
  requestId: string,
  overrides: Partial<Extract<UsageLogRecord, { kind: "call-end" }>> = {},
): UsageLogRecord {
  return {
    kind: "call-end",
    at: at(9),
    callId,
    requestId,
    outcome: "ok",
    billed: true,
    status: 200,
    inputTokens: 100,
    outputTokens: 10,
    clientGone: false,
    ms: 5,
    bytesIn: 10,
    bytesOut: 20,
    ...overrides,
  };
}

async function joinOf(
  records: readonly UsageLogRecord[],
  requestId: string,
): Promise<ReturnType<typeof joinUsage>> {
  const dir = mkdtempSync(join(tmpdir(), "meter-join-"));
  const path = join(dir, "usage.jsonl");
  try {
    await Bun.write(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const index = await replayUsageLog(path, "read-only", () => {});
    return joinUsage(index, requestId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("L5: settle with zero billed calls returns one all-zero row", async () => {
  await withMeter("tests/meter/recordings/json-ok.json", async ({ meter }) => {
    const { sessionId } = await openBoundGrant(meter);
    const usage = await meter.settle(sessionId, "finished");
    expect(usage?.tokens).toEqual([
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        source: "meter-proxy",
      },
    ]);
  });
});

test("billed plus unknown gives null counts with two requests", async () => {
  const usage = await joinOf(
    [
      grant("w1-demo:0", "w1-demo", "meta-api", "muse-spark-1.3-contributor"),
      start("c1", "w1-demo:0", "meta-api", "muse-spark-1.3-contributor", 2),
      start("c2", "w1-demo:0", "meta-api", "muse-spark-1.3-contributor", 3),
      end("c1", "w1-demo:0"),
      end("c2", "w1-demo:0", { outcome: "no-usage", inputTokens: null, outputTokens: null }),
    ],
    "w1-demo:0",
  );
  expect(usage.tokens.length).toBe(1);
  expect(usage.tokens[0]?.inputTokens).toBeNull();
  expect(usage.tokens[0]?.outputTokens).toBeNull();
  expect(usage.tokens[0]?.requests).toBe(2);
  expect(usage.tokens[0]?.source).toBe("meter-proxy");
});

test("an unbilled call is excluded", async () => {
  const usage = await joinOf(
    [
      grant("w1-demo:0", "w1-demo", "meta-api", "muse-spark-1.3-contributor"),
      start("c1", "w1-demo:0", "meta-api", "muse-spark-1.3-contributor", 2),
      start("c2", "w1-demo:0", "meta-api", "muse-spark-1.3-contributor", 3),
      end("c1", "w1-demo:0"),
      end("c2", "w1-demo:0", {
        outcome: "upstream-status",
        billed: false,
        status: 429,
        inputTokens: null,
        outputTokens: null,
      }),
    ],
    "w1-demo:0",
  );
  expect(usage.tokens.length).toBe(1);
  expect(usage.tokens[0]?.inputTokens).toBe(100);
  expect(usage.tokens[0]?.requests).toBe(1);
});

test("an orphan start counts as one unknown request", async () => {
  const usage = await joinOf(
    [
      grant("w1-demo:0", "w1-demo", "meta-api", "muse-spark-1.3-contributor"),
      start("c1", "w1-demo:0", "meta-api", "muse-spark-1.3-contributor", 2),
    ],
    "w1-demo:0",
  );
  expect(usage.tokens.length).toBe(1);
  expect(usage.tokens[0]?.inputTokens).toBeNull();
  expect(usage.tokens[0]?.requests).toBe(1);
});

test("no calls give a measured zero", async () => {
  const usage = await joinOf(
    [grant("w1-demo:0", "w1-demo", "meta-api", "muse-spark-1.3-contributor")],
    "w1-demo:0",
  );
  expect(usage.tokens.length).toBe(1);
  expect(usage.tokens[0]?.inputTokens).toBe(0);
  expect(usage.tokens[0]?.outputTokens).toBe(0);
  expect(usage.tokens[0]?.requests).toBe(0);
});

test("two provider pairs give two tokens in first-appearance order", async () => {
  // A hand-written index: the replay predicate ties every call to the
  // grant's provider, but the join groups by the call's own pair.
  const { joinUsage: joinDirect } = await import("../../src/meter/join.js");
  const grantRecord = grant("w1-demo:0", "w1-demo", "meta-api", "muse-spark-1.3-contributor");
  if (grantRecord.kind !== "grant-open") throw new Error("unreachable");
  const s1 = start("c1", "w1-demo:0", "meta-api", "muse-spark-1.3-contributor", 2);
  const s2 = start("c2", "w1-demo:0", "nvidia-build", "meta/muse-glimmer-30b", 3);
  const e1 = end("c1", "w1-demo:0");
  const e2 = end("c2", "w1-demo:0", { inputTokens: 7, outputTokens: 3 });
  if (s1.kind !== "call-start" || s2.kind !== "call-start") throw new Error("unreachable");
  if (e1.kind !== "call-end" || e2.kind !== "call-end") throw new Error("unreachable");
  const usage = joinDirect(
    {
      grants: new Map([
        ["w1-demo:0", { open: grantRecord, lastOpenAt: at(1), sessionId: null, closed: false }],
      ]),
      requestBySession: new Map(),
      starts: new Map([
        ["c1", s1],
        ["c2", s2],
      ]),
      startOrder: ["c1", "c2"],
      ends: new Map([
        ["c1", e1],
        ["c2", e2],
      ]),
    },
    "w1-demo:0",
  );
  expect(usage.tokens.length).toBe(2);
  expect(usage.tokens[0]?.provider).toBe("meta-api");
  expect(usage.tokens[1]?.provider).toBe("nvidia-build");
  expect(usage.tokens[1]?.inputTokens).toBe(7);
});

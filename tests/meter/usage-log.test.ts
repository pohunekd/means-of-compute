// Usage-log tests: one failing case per replay predicate of section 4.3,
// the torn-tail repair, and the write-ahead latch.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageAppender, replayUsageLog } from "../../src/meter/usage-log.js";
import type { MeterLogEvent } from "../../src/meter/meter.js";
import type { UsageLogRecord } from "../../src/meter/usage-log.js";

function at(no: number): string {
  return new Date(Date.UTC(2026, 9, 27, 10, 0, no)).toISOString();
}

function openGrant(
  overrides: Partial<Extract<UsageLogRecord, { kind: "grant-open" }>> = {},
): UsageLogRecord {
  return {
    kind: "grant-open",
    at: at(1),
    requestId: "w1-demo:0",
    workItemId: "w1-demo",
    hostAlias: "laptop-a",
    providerId: "meta-api",
    model: "muse-spark-1.3-contributor",
    ...overrides,
  };
}

function bind(
  overrides: Partial<Extract<UsageLogRecord, { kind: "grant-bind" }>> = {},
): UsageLogRecord {
  return {
    kind: "grant-bind",
    at: at(2),
    requestId: "w1-demo:0",
    sessionId: "sess-1",
    ...overrides,
  };
}

function closeGrant(
  overrides: Partial<Extract<UsageLogRecord, { kind: "grant-close" }>> = {},
): UsageLogRecord {
  return {
    kind: "grant-close",
    at: at(3),
    requestId: "w1-demo:0",
    state: "finished",
    ...overrides,
  };
}

function start(
  overrides: Partial<Extract<UsageLogRecord, { kind: "call-start" }>> = {},
): UsageLogRecord {
  return {
    kind: "call-start",
    at: at(4),
    callId: "call-1",
    requestId: "w1-demo:0",
    providerId: "meta-api",
    model: "muse-spark-1.3-contributor",
    stream: true,
    ...overrides,
  };
}

function end(
  overrides: Partial<Extract<UsageLogRecord, { kind: "call-end" }>> = {},
): UsageLogRecord {
  return {
    kind: "call-end",
    at: at(5),
    callId: "call-1",
    requestId: "w1-demo:0",
    outcome: "ok",
    billed: true,
    status: 200,
    inputTokens: 10,
    outputTokens: 5,
    clientGone: false,
    ms: 12,
    bytesIn: 40,
    bytesOut: 60,
    ...overrides,
  };
}

async function writeLog(
  path: string,
  records: readonly UsageLogRecord[],
  tail = "",
): Promise<void> {
  const text = records.map((r) => JSON.stringify(r)).join("\n");
  await Bun.write(path, text === "" ? tail : `${text}\n${tail}`);
}

function withDir(run: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "meter-log-"));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "replay accepts a valid sequence",
  withDir(async (dir) => {
    const path = join(dir, "usage.jsonl");
    await writeLog(path, [openGrant(), bind(), start(), end(), closeGrant()]);
    const events: MeterLogEvent[] = [];
    const index = await replayUsageLog(path, "repair", (e) => events.push(e));
    expect(index.grants.get("w1-demo:0")?.sessionId).toBe("sess-1");
    expect(index.ends.has("call-1")).toBe(true);
    expect(events.length).toBe(0);
  }),
);

test(
  "conflicting grant-open fails with its line",
  withDir(async (dir) => {
    const path = join(dir, "usage.jsonl");
    await writeLog(path, [openGrant(), openGrant({ model: "other-model", at: at(6) })]);
    let message = "";
    try {
      await replayUsageLog(path, "read-only", () => {});
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain(":2:");
  }),
);

test(
  "duplicate bind fails",
  withDir(async (dir) => {
    const path = join(dir, "usage.jsonl");
    await writeLog(path, [openGrant(), bind(), bind({ at: at(6) })]);
    let message = "";
    try {
      await replayUsageLog(path, "read-only", () => {});
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain(":3:");
  }),
);

test(
  "call-end billed flag must match its outcome",
  withDir(async (dir) => {
    const path = join(dir, "usage.jsonl");
    await writeLog(path, [
      openGrant(),
      start(),
      end({ outcome: "upstream-unreachable", billed: true }),
    ]);
    let message = "";
    try {
      await replayUsageLog(path, "read-only", () => {});
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain(":3:");
  }),
);

test(
  "torn tail is truncated with one warn event",
  withDir(async (dir) => {
    const path = join(dir, "usage.jsonl");
    await writeLog(path, [openGrant()], '{"kind":"grant-bin');
    const events: MeterLogEvent[] = [];
    const index = await replayUsageLog(path, "repair", (e) => events.push(e));
    expect(index.grants.has("w1-demo:0")).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0]?.event).toBe("usage-log-torn-tail");
    const indexAgain = await replayUsageLog(path, "read-only", () => {});
    expect(indexAgain.grants.has("w1-demo:0")).toBe(true);
  }),
);

test(
  "write-ahead: append fault on call-start latches the meter",
  withDir(async (dir) => {
    const path = join(dir, "usage.jsonl");
    await writeLog(path, [openGrant()]);
    const events: MeterLogEvent[] = [];
    const index = await replayUsageLog(path, "repair", () => {});
    const appender = await openUsageAppender(path, index, (e) => events.push(e));
    // Force the append to fail by closing the handle first; the write then
    // rejects and the failure latch must engage.
    await appender.close();
    const verdict = await appender.appendGuarded(start(), () => null);
    expect(verdict).toBe("meter-unavailable");
    expect(appender.failed).toBe(true);
    expect(events.some((e) => e.event === "usage-log-failed")).toBe(true);
  }),
);

// Usage-log tests: one failing case per replay predicate of section 4.3,
// the torn-tail repair, and the write-ahead latch.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageAppender, replayUsageLog, systemUsageLogIo } from "../../src/meter/usage-log.js";
import { createFaultyIo } from "./faulty-io.js";
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

// One row per 4.3 predicate: replay must reject with MeterLogError
// naming the line and the given text. Rows M23 and M26 kill their
// mutations at the round-2 head.
const replayRows: ReadonlyArray<{
  readonly name: string;
  readonly records: () => UsageLogRecord[];
  readonly tail: string;
  readonly line: number;
  readonly text: string;
}> = [
  {
    name: "not JSON",
    records: () => [openGrant()],
    tail: "{bad\n",
    line: 2,
    text: "line is not valid JSON",
  },
  {
    name: "schema",
    records: () => [openGrant(), start({ stream: "yes" as unknown as boolean })],
    tail: "",
    line: 2,
    text: "does not match the usage-log schema",
  },
  {
    name: "bad at",
    records: () => [openGrant({ at: "2026-10-27T10:00:00Z" })],
    tail: "",
    line: 1,
    text: "invalid at timestamp",
  },
  {
    name: "open conflict",
    records: () => [openGrant(), openGrant({ hostAlias: "laptop-b", at: at(6) })],
    tail: "",
    line: 2,
    text: "grant-open conflicts",
  },
  {
    name: "bind without open",
    records: () => [bind()],
    tail: "",
    line: 1,
    text: "grant-bind without an earlier grant-open",
  },
  {
    name: "duplicate bind",
    records: () => [openGrant(), bind(), bind({ at: at(6) })],
    tail: "",
    line: 3,
    text: "duplicate grant-bind",
  },
  {
    name: "grant bound twice",
    records: () => [openGrant(), bind(), bind({ sessionId: "sess-2", at: at(6) })],
    tail: "",
    line: 3,
    text: "grant already bound to another session",
  },
  {
    name: "session on two grants",
    records: () => [
      openGrant(),
      openGrant({ requestId: "w2-demo:0", workItemId: "w2-demo", at: at(6) }),
      bind(),
      bind({ requestId: "w2-demo:0", at: at(7) }),
    ],
    tail: "",
    line: 4,
    text: "session already bound to another grant",
  },
  {
    name: "close without open",
    records: () => [closeGrant()],
    tail: "",
    line: 1,
    text: "grant-close without an earlier grant-open",
  },
  {
    name: "duplicate close",
    records: () => [openGrant(), closeGrant(), closeGrant({ at: at(6) })],
    tail: "",
    line: 3,
    text: "duplicate grant-close",
  },
  {
    name: "start without open",
    records: () => [start()],
    tail: "",
    line: 1,
    text: "call-start without an earlier grant-open",
  },
  {
    name: "call-start after grant-close",
    records: () => [openGrant(), closeGrant(), start()],
    tail: "",
    line: 3,
    text: "call-start after grant-close",
  },
  {
    name: "duplicate callId",
    records: () => [openGrant(), start(), start({ at: at(6) })],
    tail: "",
    line: 3,
    text: "duplicate callId",
  },
  {
    name: "start provider differs",
    records: () => [openGrant(), start({ providerId: "nvidia-build" })],
    tail: "",
    line: 2,
    text: "provider or model differs",
  },
  {
    name: "end without start",
    records: () => [openGrant(), end()],
    tail: "",
    line: 2,
    text: "call-end without a matching call-start",
  },
  {
    name: "duplicate end",
    records: () => [openGrant(), start(), end(), end({ at: at(6) })],
    tail: "",
    line: 4,
    text: "duplicate call-end",
  },
  {
    name: "billed mismatch",
    records: () => [openGrant(), start(), end({ outcome: "upstream-status", billed: true })],
    tail: "",
    line: 3,
    text: "billed flag does not match",
  },
];

for (const row of replayRows) {
  test(
    `replay predicate ${row.name} fails with its line`,
    withDir(async (dir) => {
      const path = join(dir, "usage.jsonl");
      await writeLog(path, row.records(), row.tail);
      let message = "";
      try {
        await replayUsageLog(path, "read-only", () => {});
      } catch (error: unknown) {
        message = (error as Error).message;
      }
      expect(message).toContain(`:${String(row.line)}:`);
      expect(message).toContain(row.text);
    }),
  );
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
  "torn tail after a non-ASCII session id is cut at the byte boundary",
  withDir(async (dir) => {
    const path = join(dir, "usage.jsonl");
    // L5: two complete lines, then a torn tail without a newline. The cut
    // and the dropped count are in bytes, not UTF-16 units.
    await writeLog(path, [openGrant(), bind({ sessionId: "séance-1" })], '{"kind":"call-st');
    const events: MeterLogEvent[] = [];
    const index = await replayUsageLog(path, "repair", (e) => events.push(e));
    expect(index.requestBySession.get("séance-1")).toBe("w1-demo:0");
    const reread = await Bun.file(path).text();
    const expected = [openGrant(), bind({ sessionId: "séance-1" })]
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(reread).toBe(`${expected}\n`);
    expect(reread.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(reread, "utf8")).toBe(
      Buffer.byteLength(`${expected}\n`, "utf8"),
    );
    const tail = '{"kind":"call-st';
    const torn = events.find((e) => e.event === "usage-log-torn-tail");
    expect(torn?.count).toBe(Buffer.byteLength(tail, "utf8"));
    const indexAgain = await replayUsageLog(path, "read-only", () => {});
    expect(indexAgain.requestBySession.get("séance-1")).toBe("w1-demo:0");
  }),
);

test(
  "write-ahead: a failing fsync leaves the in-memory index unchanged",
  withDir(async (dir) => {
    const path = join(dir, "usage.jsonl");
    await writeLog(path, [openGrant()]);
    const events: MeterLogEvent[] = [];
    const index = await replayUsageLog(path, "repair", () => {});
    const io = createFaultyIo(systemUsageLogIo, { failDatasync: true });
    const appender = await openUsageAppender(path, index, (e) => events.push(e), io);
    // The write lands but the datasync fails: the latch engages, verdict is
    // meter-unavailable, and the in-memory index never applies the record —
    // commitRecord runs only after the datasync.
    const verdict = await appender.appendGuarded(start(), () => null);
    expect(verdict).toBe("meter-unavailable");
    expect(appender.failed).toBe(true);
    expect(index.starts.has("call-1")).toBe(false);
    const torn = await Bun.file(path).text();
    expect(torn.endsWith("\n")).toBe(true);
    // The bytes did reach the file (only the sync failed), so a later
    // replay recovers the record even though this process never applied it.
    const replayed = await replayUsageLog(path, "read-only", () => {});
    expect(replayed.starts.has("call-1")).toBe(true);
    expect(events.some((e) => e.event === "usage-log-failed")).toBe(true);
    await appender.close();
  }),
);

test("write-ahead: the fsync precedes the in-memory apply in source order", async () => {
  // A failing fsync must not leave an applied-but-undurable record behind.
  // The order is structural, so assert it structurally: the S6 split runs
  // checkRecord (validate) before the write, then write, then datasync,
  // then commitRecord (apply) — all inside the append step.
  const source = await Bun.file("src/meter/usage-log.ts").text();
  const marker = "async function runAppend<F extends string>(";
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const body = source.slice(at);
  const checkAt = body.indexOf("checkRecord(index, record, path, 0);");
  const writeAt = body.indexOf("await handle.write(");
  const syncAt = body.indexOf("await handle.datasync();");
  const commitAt = body.indexOf("commitRecord(mutable, record);");
  expect(checkAt).toBeGreaterThanOrEqual(0);
  expect(writeAt).toBeGreaterThan(checkAt);
  expect(syncAt).toBeGreaterThan(writeAt);
  expect(commitAt).toBeGreaterThan(syncAt);
  expect(source.match(/await handle\.write\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
});

// Usage-log tests: one failing case per replay predicate of section 4.3,
// the torn-tail repair, and the write-ahead latch.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMeterConfig, resolveMeterEnv } from "../../src/meter/config.js";
import type { MeterConfig } from "../../src/meter/config.js";
import { startMeter, type MeterLogEvent } from "../../src/meter/meter.js";
import { getProviders, resetProvidersCache } from "../../src/providers/config.js";
import { openUsageAppender, replayUsageLog, systemUsageLogIo } from "../../src/meter/usage-log.js";
import { createFaultyIo } from "./faulty-io.js";
import { createManualTimers } from "./manual-timers.js";
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
// naming the line and the given text.
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
  "bindGrant with an empty session id is refused and the log still replays",
  withDir(async (dir) => {
    const path = join(dir, "usage.jsonl");
    // Replay accepts the empty file, then a grant-open commits. The
    // schema check in checkRecord refuses the empty-session grant-bind
    // on the rejection path: usage-log-rejected, no latch, no write.
    const events: MeterLogEvent[] = [];
    const log = (e: MeterLogEvent): void => {
      events.push(e);
    };
    resetProvidersCache();
    const savedEnv: Record<string, string | undefined> = {
      META_API_KEY: process.env.META_API_KEY,
      NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
      PROVIDER_META_API_BASE_URL: process.env.PROVIDER_META_API_BASE_URL,
      PROVIDER_NVIDIA_BUILD_BASE_URL: process.env.PROVIDER_NVIDIA_BUILD_BASE_URL,
    };
    const restoreEnv = (): void => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };
    process.env.META_API_KEY = "test-meta-key";
    process.env.NVIDIA_API_KEY = "test-nvidia-key";
    process.env.PROVIDER_META_API_BASE_URL = "http://127.0.0.1:1";
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = "http://127.0.0.1:1";
    try {
      const base = await loadMeterConfig();
      const config: MeterConfig = { ...base, usageLogPath: path };
      await Bun.write(join(dir, "hosts.json"), JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
      const env = await resolveMeterEnv(config, {
        MOC_METER_LISTEN: "127.0.0.1:0",
        MOC_METER_SECRET: randomBytes(32).toString("base64"),
        MOC_METER_HOST_ADDRESSES_FILE: join(dir, "hosts.json"),
      });
      const meter = await startMeter({
        config,
        env,
        providers: await getProviders(),
        timers: createManualTimers(),
        logIo: systemUsageLogIo,
        now: () => new Date(),
        log,
      });
      try {
        await meter.openGrant({
          requestId: "w1-demo:0",
          workItemId: "w1-demo",
          hostAlias: "laptop-a",
          providerId: "meta-api",
          model: "muse-spark-1.3-contributor",
        });
        // The schema check in checkRecord refuses the empty
        // session id on the rejection path — usage-log-rejected, no
        // latch, no write — and the meter stays usable.
        let message = "";
        try {
          await meter.bindGrant("w1-demo:0", "");
        } catch (error: unknown) {
          message = (error as Error).message;
        }
        expect(message).toContain("meter: usage log rejected a record");
        expect(events.some((e) => e.event === "usage-log-rejected" && e.level === "error")).toBe(
          true,
        );
        await meter.bindGrant("w1-demo:0", "sess-1");
      } finally {
        await meter.close();
      }
      // A startMeter on the same log directory then succeeds.
      const meter2 = await startMeter({
        config,
        env,
        providers: await getProviders(),
        timers: createManualTimers(),
        logIo: systemUsageLogIo,
        now: () => new Date(),
        log,
      });
      await meter2.close();
    } finally {
      resetProvidersCache();
      restoreEnv();
    }
  }),
);

test(
  "torn tail after a non-ASCII session id is cut at the byte boundary",
  withDir(async (dir) => {
    const path = join(dir, "usage.jsonl");
    // Two complete lines, then a torn tail without a newline. The cut
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
    expect(Buffer.byteLength(reread, "utf8")).toBe(Buffer.byteLength(`${expected}\n`, "utf8"));
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
  // The order is structural, so assert it structurally: the split runs
  // checkRecord (validate) before the write, then write, then datasync,
  // then commitRecord (apply) — all inside the append step. The datasync
  // in the append step is the second datasync site in the file (the
  // first belongs to the UsageLogHandle wrapper).
  const source = await Bun.file("src/meter/usage-log.ts").text();
  const writeSite = "await handle.write(`${JSON.stringify(record)}\\n`);";
  const at = source.indexOf(writeSite);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(source.match(/await handle\.write\(/g)?.length ?? 0).toBe(2);
  const syncAt = source.indexOf("await handle.datasync();", at);
  const commitAt = source.indexOf("commitRecord(mutable, record);", syncAt);
  expect(syncAt).toBeGreaterThan(at);
  expect(commitAt).toBeGreaterThan(syncAt);
  const checkAt = source.indexOf("checkRecord(index, record, path, 0);");
  expect(checkAt).toBeGreaterThanOrEqual(0);
  expect(checkAt).toBeLessThan(at);
});

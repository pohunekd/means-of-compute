// Settle tests: the drain aborts, the close race, latch idempotence,
// grant-record races, bind errors and settle determinism of section 4.6.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadMeterConfig, resolveMeterEnv } from "../../src/meter/config.js";
import type { MeterConfig } from "../../src/meter/config.js";
import {
  startMeter,
  type Meter,
  MeterGrantError,
  type MeterLogEvent,
} from "../../src/meter/meter.js";
import { getProviders, resetProvidersCache } from "../../src/providers/config.js";
import { startLoopback } from "../../src/providers/loopback.js";
import { createManualTimers } from "./manual-timers.js";
import { joinUsage } from "../../src/meter/join.js";
import { replayUsageLog, systemUsageLogIo } from "../../src/meter/usage-log.js";
import { createFaultyIo } from "./faulty-io.js";
import { meterUrl, openBoundGrant, readLogLines, withMeter } from "./helpers.js";
import type { MeterOverrides } from "./helpers.js";
import type { UsageLogIo } from "../../src/meter/usage-log.js";

function chatBody(): Record<string, unknown> {
  return {
    model: "moc-session",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  };
}

interface CallEndRow {
  outcome: string;
  billed: boolean;
  status: number;
  requestId?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  ms?: number;
}

function readEnd(lines: readonly string[]): CallEndRow {
  const line = lines.find((line: string) => line.includes('"kind":"call-end"'));
  return JSON.parse(line ?? "{}") as CallEndRow;
}

async function post(
  meter: { readonly port: number },
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(meterUrl(meter), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function readFirstChunk(resp: Response): Promise<string> {
  // The pump may forward the usage frame in several caller chunks, so
  // the caller reads until the first line completes: only a whole
  // `data:` line proves the tap parsed the usage.
  const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
  try {
    let text = "";
    for (;;) {
      const next = await reader.read();
      text += new TextDecoder().decode(next.value ?? new Uint8Array());
      if (text.includes("\n") || next.done) {
        return text;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

test("drain: settle aborts a slow call and waits for its end", async () => {
  await withMeter(
    "tests/meter/recordings/stream-hold-after-usage.json",
    async ({ meter, logPath, loopback, timers, waitForEvent }) => {
      const { requestId, token, sessionId } = await openBoundGrant(meter);
      // The usage frame sits behind the gate: opening it lets the pump
      // push the first chunk to the caller, so the caller proves the tap
      // saw the usage before the settle below queues its close.
      loopback.release();
      const head = await post(meter, token, chatBody());
      expect(head.status).toBe(200);
      expect(await readFirstChunk(head)).toContain("prompt_tokens");
      // The grant-close is durable once the 30 s drain timer arms;
      // advancing it fires the abort, and the usage joins after the end.
      const settling = meter.settle(sessionId, "finished");
      await timers.waitForTimer(30000);
      timers.advance(30000);
      const usage = await settling;
      expect(usage?.tokens[0]).toMatchObject({
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        requests: 1,
        inputTokens: 7,
        outputTokens: 3,
      });
      const lines = await readLogLines(logPath);
      const end = JSON.parse(lines.find((line) => line.includes('"kind":"call-end"')) ?? "{}") as {
        outcome: string;
        billed: boolean;
        inputTokens: number;
        outputTokens: number;
      };
      expect(end.outcome).toBe("closed-abort");
      expect(end.billed).toBe(true);
      expect(end.inputTokens).toBe(7);
      expect(end.outputTokens).toBe(3);
      // The usage the caller saw is the replayed join, computed
      // only after every end went durable.
      const replayed = await replayUsageLog(logPath, "read-only", () => {});
      if (usage === null) {
        throw new Error("settle returned null");
      }
      expect(joinUsage(replayed, requestId)).toEqual(usage);
      const finished = await waitForEvent((e) => e.event === "call-finished" && "requestId" in e);
      expect(finished).toMatchObject({ requestId });
    },
    { config: { drainTimeoutMs: 30000 } },
  );
});

test("a non-2xx body that stalls is aborted at drain and not billed", async () => {
  await withMeter(
    "tests/meter/recordings/status-500-hold.json",
    async ({ meter, logPath, loopback, timers, waitForEvent }) => {
      const { token, sessionId } = await openBoundGrant(meter);
      const resp = await post(meter, token, chatBody());
      expect(resp.status).toBe(500);
      // The whole body stalls behind the gate: nothing reaches the
      // caller. The drain timer decides the abort: the settle queues
      // the grant-close, then the drain aborts the stalled non-2xx
      // call on the 777 ms budget. All other timeouts stay above 777,
      // so only the drain fires.
      await loopback.waitHeld(1);
      const settling = meter.settle(sessionId, "finished");
      await timers.waitForTimer(777);
      timers.advance(777);
      const usage = await settling;
      // The grant carried no billed call, so the join has one zero row.
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
      const lines8500 = await readLogLines(logPath);
      const end8500 = readEnd(lines8500);
      // A non-2xx end is upstream-status, unbilled, with null
      // counts, whatever happened to the body. The manual clock ran
      // only to the drain, so ms is 777.
      expect(end8500.outcome).toBe("upstream-status");
      expect(end8500.billed).toBe(false);
      expect(end8500.status).toBe(500);
      expect(end8500.inputTokens).toBeNull();
      expect(end8500.outputTokens).toBeNull();
      expect(end8500.ms).toBe(777);
      const aborted = await waitForEvent((e) => e.event === "drain-abort");
      expect(aborted).toMatchObject({ count: 1 });
      await waitForEvent((e) => e.event === "call-finished");
      await meter.close();
    },
    {
      config: {
        idleTimeoutMs: 60001,
        firstByteTimeoutMs: 60001,
        totalTimeoutMs: 60001,
        drainTimeoutMs: 777,
      },
    },
  );
});

test("close aborts a held call without release", async () => {
  await withMeter(
    "tests/meter/recordings/status-500-hold.json",
    async ({ meter, logPath, loopback, waitForEvent }) => {
      const { requestId, token } = await openBoundGrant(meter);
      const resp = await post(meter, token, chatBody());
      expect(resp.status).toBe(500);
      // The call is held upstream, and meter.close() below aborts it
      // without the hold ever being released: close must still return.
      await loopback.waitHeld(1);
      await meter.close();
      await waitForEvent((e) => e.event === "call-finished");
      const lines = await readLogLines(logPath);
      const end = readEnd(lines);
      expect(end.billed).toBe(false);
      expect(end.outcome).toBe("upstream-status");
      expect(end.status).toBe(500);
      expect(end.requestId).toBe(requestId);
    },
  );
});

test("drain with drainTimeoutMs 0 still awaits the end", async () => {
  await withMeter(
    "tests/meter/recordings/stream-hold-after-usage.json",
    async ({ meter, logPath, loopback, timers }) => {
      const { requestId, token, sessionId } = await openBoundGrant(meter);
      loopback.release();
      const head = await post(meter, token, chatBody());
      expect(head.status).toBe(200);
      expect(await readFirstChunk(head)).toContain("prompt_tokens");
      // The same drain with a zero budget: the abort fires at once, but
      // settle still awaits the aborted end before the join.
      const settling = meter.settle(sessionId, "finished");
      await timers.waitForTimer(0);
      timers.advance(0);
      const usage = await settling;
      expect(usage?.tokens[0]).toMatchObject({
        requests: 1,
        inputTokens: 7,
        outputTokens: 3,
      });
      const linesZero = await readLogLines(logPath);
      const endZero = readEnd(linesZero);
      expect(endZero.outcome).toBe("closed-abort");
      expect(endZero.billed).toBe(true);
      const replayed = await replayUsageLog(logPath, "read-only", () => {});
      if (usage === null) {
        throw new Error("settle returned null");
      }
      expect(joinUsage(replayed, requestId)).toEqual(usage);
    },
    { config: { drainTimeoutMs: 0 } },
  );
});

test("close race: concurrent calls are either counted or refused", async () => {
  // Ten calls are live and held upstream; ten more calls are sent
  // before the drain timer below is awaited, racing a close the chain
  // step cannot interleave until each either commits or refuses.
  await withMeter(
    "tests/meter/recordings/stream-hold-after-first.json",
    async ({ meter, loopback, timers }) => {
      const { token, sessionId } = await openBoundGrant(meter);
      // Ten calls reach the upstream hold and stay there.
      const pendings = Array.from({ length: 10 }, () => post(meter, token, chatBody()));
      await loopback.waitHeld(10);
      const timerArmed = timers.waitForTimer(999);
      // When settle() returns, the grant-close is queued in the append
      // chain. It becomes durable before the drain timer arms, and the
      // late calls queue behind that pending close: each is refused
      // 403 grant-closed, and none reaches the upstream.
      const settling = meter.settle(sessionId, "finished");
      const late = await Promise.all(
        Array.from({ length: 10 }, () => post(meter, token, chatBody())),
      );
      for (const resp of late) {
        expect(resp.status).toBe(403);
        expect(((await resp.json()) as { error: { code: string } }).error.code).toBe(
          "grant-closed",
        );
      }
      expect(loopback.requests().length).toBe(10);
      await timerArmed;
      // The first ten finish once the gate opens; the drain then joins.
      loopback.release();
      const first = await Promise.all(pendings);
      for (const resp of first) {
        expect(resp.status).toBe(200);
        await resp.text();
      }
      const usage = await settling;
      expect(usage?.tokens[0]?.requests).toBe(10);
    },
    { config: { drainTimeoutMs: 999, maxInFlightPerSession: 32 } },
  );
});

test("a settled grant returns its memo after a later latch", async () => {
  // Settle A, latch the meter through the IO seam with grant B,
  // then settle A again. The resolved memo wins over the latch.
  let failWrites = false;
  const latchIo = (base: UsageLogIo): UsageLogIo => ({
    async open(path: string) {
      const real = await base.open(path);
      return {
        async write(text: string): Promise<void> {
          if (failWrites) {
            throw new Error("injected write failure");
          }
          await real.write(text);
        },
        async datasync(): Promise<void> {
          await real.datasync();
        },
        async close(): Promise<void> {
          await real.close();
        },
      };
    },
  });
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter, events }) => {
      const { token, sessionId } = await openBoundGrant(meter);
      // Settle A while the IO is healthy: the memo is durable.
      const resp = await post(meter, token, chatBody());
      expect(resp.status).toBe(200);
      await resp.text();
      const once = await meter.settle(sessionId, "finished");
      expect(once?.tokens[0]?.requests).toBe(1);
      // Settle A closed the grant, so open a second grant B, then latch
      // the meter through the IO seam with a call on B whose call-start
      // write fails: the caller gets 503 meter-unavailable and the
      // usage-log-failed event is logged. Then settle A again: the
      // resolved memo wins over the latch, with no error.
      await meter.openGrant({
        requestId: "w2-demo:0",
        workItemId: "w2-demo",
        hostAlias: "laptop-a",
        providerId: "meta-api",
        model: "muse-spark-1.3-contributor",
      });
      await meter.bindGrant("w2-demo:0", "sess-2");
      const tokenB = meter.tokenFor("w2-demo:0");
      failWrites = true;
      const latched = await post(meter, tokenB, chatBody());
      expect(latched.status).toBe(503);
      expect(((await latched.json()) as { error: { code: string } }).error.code).toBe(
        "meter-unavailable",
      );
      expect(events.some((e) => e.event === "usage-log-failed")).toBe(true);
      failWrites = false;
      const again = await meter.settle(sessionId, "finished");
      expect(again).toEqual(once);
    },
    { logIo: latchIo(systemUsageLogIo) },
  );
});

test("a latched call-end does not free a sibling slot twice", async () => {
  const overrides: MeterOverrides = {
    config: { maxInFlightPerSession: 2 },
    logIo: createFaultyIo(systemUsageLogIo, {
      failWhen: (line) => line.includes('"kind":"call-end"'),
    }),
  };
  await withMeter(
    "tests/meter/recordings/latch-pair.json",
    async ({ live, loopback, meter, waitForEvent }) => {
      // Call B runs on faulty IO: every call-end append fails, so the
      // meter latches on B's end while B's caller stream errors.
      const { token } = await openBoundGrant(meter);
      // Call A reaches entry 0 and holds after its first usage chunk.
      const pendingA = post(meter, token, chatBody());
      await loopback.waitHeld(1);
      expect(live.liveCount("w1-demo:0")).toBe(1);
      // Call B completes on entry 1; its end write fails and latches.
      // The caller stream errors in the same burst as the body frames,
      // so the test observes the event, not the response: the socket
      // may close before the headers flush.
      const pendingB = post(meter, token, chatBody());
      pendingB.catch(() => {});
      const erroredB = await waitForEvent(
        (e) => e.event === "caller-stream-errored" && e.callId !== undefined,
      );
      expect(erroredB).toMatchObject({
        requestId: "w1-demo:0",
        outcome: "meter-unavailable",
      });
      const callB = erroredB.callId as string;
      // Only B's end settled: A is still live, so the count is 1.
      expect(live.liveCount("w1-demo:0")).toBe(1);
      // A ends once the gate opens; its end step returns
      // meter-unavailable, its caller stream errors, and its slot
      // releases exactly once.
      loopback.release();
      const erroredA = await waitForEvent(
        (e) => e.event === "caller-stream-errored" && e.callId !== callB,
      );
      expect(erroredA).toMatchObject({
        requestId: "w1-demo:0",
        outcome: "meter-unavailable",
      });
      expect(live.liveCount("w1-demo:0")).toBe(0);
      const respA = await pendingA;
      expect(respA.status).toBe(200);
      const textOutcome = await respA.text().then(
        () => "resolved",
        () => "rejected",
      );
      expect(textOutcome).toBe("rejected");
    },
    overrides,
  );
});

test("concurrent identical binds write one record", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter, logPath }) => {
    await meter.openGrant({
      requestId: "w1-demo:0",
      workItemId: "w1-demo",
      hostAlias: "laptop-a",
      providerId: "meta-api",
      model: "muse-spark-1.3-contributor",
    });
    const both = await Promise.allSettled([
      meter.bindGrant("w1-demo:0", "sess-1"),
      meter.bindGrant("w1-demo:0", "sess-1"),
    ]);
    // The first bind wins the chain step; the second's guard sees the
    // same session and returns already-bound, a success with no record.
    expect(both[0].status).toBe("fulfilled");
    expect(both[1].status).toBe("fulfilled");
    const lines = await readLogLines(logPath);
    expect(lines.filter((line) => line.includes('"kind":"grant-bind"')).length).toBe(1);
    await replayUsageLog(logPath, "repair", () => {});
    // The grant is usable and the latch never set: a second request
    // opens cleanly after the race.
    await meter.openGrant({
      requestId: "w2-demo:0",
      workItemId: "w2-demo",
      hostAlias: "laptop-a",
      providerId: "meta-api",
      model: "muse-spark-1.3-contributor",
    });
  });
});

test("concurrent conflicting binds keep one", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter, logPath }) => {
    await meter.openGrant({
      requestId: "w1-demo:0",
      workItemId: "w1-demo",
      hostAlias: "laptop-a",
      providerId: "meta-api",
      model: "muse-spark-1.3-contributor",
    });
    const both = await Promise.allSettled([
      meter.bindGrant("w1-demo:0", "sess-1"),
      meter.bindGrant("w1-demo:0", "sess-2"),
    ]);
    // Exactly one writer wins; the loser meets session-conflict.
    expect(both.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rejected = both.filter((r) => r.status === "rejected");
    expect(rejected.length).toBe(1);
    const first = rejected[0];
    if (first === undefined) {
      throw new Error("expected one rejected bind");
    }
    const reason: unknown = first.reason;
    expect(reason).toBeInstanceOf(MeterGrantError);
    expect((reason as MeterGrantError).code).toBe("session-conflict");
    const lines = await readLogLines(logPath);
    expect(lines.filter((line) => line.includes('"kind":"grant-bind"')).length).toBe(1);
    await replayUsageLog(logPath, "repair", () => {});
  });
});

test("a taken port fails with the alias and the code only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meter-l4-"));
  const hostsFile = join(dir, "hosts.json");
  await Bun.write(hostsFile, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
  resetProvidersCache();
  const savedPortEnv: Record<string, string | undefined> = {
    META_API_KEY: process.env.META_API_KEY,
    NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
    LOCAL_MODEL_BASE_URL: process.env.LOCAL_MODEL_BASE_URL,
    PROVIDER_META_API_BASE_URL: process.env.PROVIDER_META_API_BASE_URL,
    PROVIDER_NVIDIA_BUILD_BASE_URL: process.env.PROVIDER_NVIDIA_BUILD_BASE_URL,
  };
  const restorePortEnv = (): void => {
    for (const key of Object.keys(savedPortEnv)) {
      const value = savedPortEnv[key];
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  process.env.META_API_KEY = "test-meta-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_META_API_BASE_URL = "http://127.0.0.1:1";
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = "http://127.0.0.1:1";
  const secret = randomBytes(32).toString("base64");
  const started: Meter[] = [];
  const timers = createManualTimers();
  const events: MeterLogEvent[] = [];
  const log = (e: MeterLogEvent): void => {
    events.push(e);
  };
  try {
    const base = await loadMeterConfig();
    const listenEnv = (overrides: Record<string, string>): Record<string, string | undefined> => ({
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: secret,
      MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
      ...overrides,
    });
    const providers = await getProviders();
    const configA: MeterConfig = {
      ...base,
      usageLogPath: join(dir, "a.jsonl"),
    };
    const meterA = await startMeter({
      config: configA,
      env: await resolveMeterEnv(configA, listenEnv({})),
      providers,
      timers,
      logIo: systemUsageLogIo,
      now: () => new Date(),
      log,
    });
    started.push(meterA);
    // The second listener names its alias and the errno code only;
    // the Bun message with the taken port never surfaces.
    const configB: MeterConfig = {
      ...base,
      usageLogPath: join(dir, "b.jsonl"),
    };
    let message = "";
    try {
      await startMeter({
        config: configB,
        env: await resolveMeterEnv(
          configB,
          listenEnv({ MOC_METER_LISTEN: `127.0.0.1:${String(meterA.port)}` }),
        ),
        providers,
        timers,
        logIo: systemUsageLogIo,
        now: () => new Date(),
        log,
      });
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toBe("meter listener factory: EADDRINUSE");
    expect(message.includes(String(meterA.port))).toBe(false);
  } finally {
    for (const meter of started) {
      await meter.close().catch(() => {});
    }
    resetProvidersCache();
    restorePortEnv();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(events.filter((e) => e.event === "listening")).toEqual([
    { level: "info", event: "listening", hostAlias: "factory" },
  ]);
});

test("determinism: settle twice, restart, settle again", async () => {
  // The restart shares the log path, timers and IO across both meters,
  // so no wall clock or fresh state can sneak into the second settle.
  const dir = mkdtempSync(join(tmpdir(), "meter-restart-"));
  const hostsFile = join(dir, "hosts.json");
  const logPath = join(dir, "usage.jsonl");
  await Bun.write(hostsFile, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
  const loopback = await startLoopback("tests/meter/recordings/stream-ok.json");
  resetProvidersCache();
  const savedRestartEnv: Record<string, string | undefined> = {
    META_API_KEY: process.env.META_API_KEY,
    NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
    LOCAL_MODEL_BASE_URL: process.env.LOCAL_MODEL_BASE_URL,
    PROVIDER_META_API_BASE_URL: process.env.PROVIDER_META_API_BASE_URL,
    PROVIDER_NVIDIA_BUILD_BASE_URL: process.env.PROVIDER_NVIDIA_BUILD_BASE_URL,
  };
  const restoreRestartEnv = (): void => {
    for (const key of Object.keys(savedRestartEnv)) {
      const value = savedRestartEnv[key];
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  process.env.META_API_KEY = "test-meta-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  const secret = randomBytes(32).toString("base64");
  const timers = createManualTimers();
  const events: MeterLogEvent[] = [];
  try {
    const base = await loadMeterConfig();
    const config: MeterConfig = { ...base, usageLogPath: logPath };
    const envOf = (): Promise<Awaited<ReturnType<typeof resolveMeterEnv>>> =>
      resolveMeterEnv(config, {
        MOC_METER_LISTEN: "127.0.0.1:0",
        MOC_METER_SECRET: secret,
        MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
      });
    const providers = await getProviders();
    const startArgs = {
      config,
      providers,
      timers,
      logIo: systemUsageLogIo,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      log: (e: MeterLogEvent): void => {
        events.push(e);
      },
    };
    const first = await startMeter({ ...startArgs, env: await envOf() });
    const { token, sessionId } = await openBoundGrant(first);
    const resp = await post(first, token, chatBody());
    expect(resp.status).toBe(200);
    await resp.text();
    const once = await first.settle(sessionId, "finished");
    const twice = await first.settle(sessionId, "finished");
    expect(twice).toEqual(once);
    await first.close();
    // Restart: the same log, timers and IO replay the durable close,
    // so the join matches the pre-restart value bit for bit.
    const second = await startMeter({ ...startArgs, env: await envOf() });
    try {
      const again = await second.settle(sessionId, "finished");
      expect(again).toEqual(once);
    } finally {
      await second.close();
    }
  } finally {
    await loopback.stop();
    resetProvidersCache();
    restoreRestartEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

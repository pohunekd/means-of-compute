// Proxy tests: one row per design rule of sections 1.5, 3.1 to 3.8, 4.2
// to 4.6 and 5.1 to 5.8, plus one regression test per fixed defect.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMeterConfig, resolveMeterEnv } from "../../src/meter/config.js";
import type { MeterConfig } from "../../src/meter/config.js";
import { startMeter, type Meter, type MeterLogEvent } from "../../src/meter/meter.js";
import { callStartGuard, handleMeterRequest } from "../../src/meter/proxy.js";
import type { UsageIndex } from "../../src/meter/usage-log.js";
import { createFaultyIo } from "./faulty-io.js";
import { systemUsageLogIo } from "../../src/meter/usage-log.js";
import { createManualTimers } from "./manual-timers.js";
import { getProviders, resetProvidersCache } from "../../src/providers/config.js";
import { startLoopback } from "../../src/providers/loopback.js";
import { meterUrl, openBoundGrant, readLogLines, withMeter } from "./helpers.js";

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "moc-session",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    ...overrides,
  };
}

function post(
  meter: { readonly port: number },
  token: string | null,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(meterUrl(meter), { method: "POST", headers, body: JSON.stringify(body) });
}

function readEnd(lines: string[]): Record<string, unknown> {
  return JSON.parse(lines.find((l) => l.includes('"kind":"call-end"')) ?? "{}") as Record<
    string,
    unknown
  >;
}

test("auth order: no token gives 401 and the loopback sees nothing", async () => {
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter, loopback, events, logPath }) => {
      const resp = await fetch(meterUrl(meter), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chatBody()),
      });
      expect(resp.status).toBe(401);
      expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
      // Nothing upstream, no record; the 401 fired before
      // A1, so the event carries no requestId.
      expect(loopback.requests().length).toBe(0);
      expect(await readLogLines(logPath)).toEqual([]);
      const rejected = events.filter((event) => event.event === "request-rejected");
      expect(rejected.length).toBe(1);
      expect(rejected[0]?.code).toBe("unauthorized");
      expect(rejected[0]?.status).toBe(401);
      expect(rejected[0]?.requestId).toBeUndefined();
    },
  );
});

test("auth order: a token for an unknown grant gives 403", async () => {
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter, tokenFor, loopback, events, logPath }) => {
      const resp = await post(meter, tokenFor("w9-unknown:0"), chatBody());
      expect(resp.status).toBe(403);
      expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("no-grant");
      // Nothing upstream, no record; A1 held, so the event
      // carries the requestId.
      expect(loopback.requests().length).toBe(0);
      expect(await readLogLines(logPath)).toEqual([]);
      const rejected = events.filter((event) => event.event === "request-rejected");
      expect(rejected.length).toBe(1);
      expect(rejected[0]?.code).toBe("no-grant");
      expect(rejected[0]?.status).toBe(403);
      expect(rejected[0]?.requestId).toBe("w9-unknown:0");
    },
  );
});

for (const row of [
  {
    name: "an unknown path gives 404",
    path: "/v1/other",
    method: "POST",
    headers: {},
    body: chatBody(),
    code: "not-found",
    status: 404,
  },
  {
    name: "a wrong method gives 405",
    path: undefined,
    method: "GET",
    headers: {},
    body: chatBody(),
    code: "method-not-allowed",
    status: 405,
  },
  {
    name: "a wrong content type gives 415",
    path: undefined,
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: chatBody(),
    code: "unsupported-media-type",
    status: 415,
  },
  {
    name: "invalid JSON gives 400 invalid-json",
    path: undefined,
    method: "POST",
    headers: {},
    body: undefined,
    raw: "{bad",
    code: "invalid-json",
    status: 400,
  },
  {
    name: "a non-object body gives 400 invalid-body",
    path: undefined,
    method: "POST",
    headers: {},
    body: [1, 2],
    code: "invalid-body",
    status: 400,
  },
  {
    name: "a non-boolean stream gives 400 invalid-body",
    path: undefined,
    method: "POST",
    headers: {},
    body: { ...chatBody(), stream: "yes" },
    code: "invalid-body",
    status: 400,
  },
  {
    name: "a non-object stream_options gives 400 invalid-body",
    path: undefined,
    method: "POST",
    headers: {},
    body: { ...chatBody(), stream_options: 7 },
    code: "invalid-body",
    status: 400,
  },
] as const) {
  test(row.name, async () => {
    await withMeter(
      "tests/meter/recordings/stream-ok.json",
      async ({ meter, tokenFor, events, loopback }) => {
        const { requestId } = await openBoundGrant(meter);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenFor(requestId)}`,
          ...row.headers,
        };
        // GET cannot carry a body. The 404 check fires before auth, so
        // only rows past the router still carry the requestId.
        const init: RequestInit =
          row.method === "GET"
            ? { method: row.method, headers }
            : {
                method: row.method,
                headers,
                body: row.body === undefined && "raw" in row ? row.raw : JSON.stringify(row.body),
              };
        const resp = await fetch(meterUrl(meter, row.path ?? "/v1/chat/completions"), init);
        expect(resp.status).toBe(row.status);
        expect(((await resp.json()) as { error: { code: string } }).error.code).toBe(row.code);
        // Nothing upstream, and exactly one request-rejected log
        // with this code and status.
        expect(loopback.requests().length).toBe(0);
        const rejected = events.filter((event) => event.event === "request-rejected");
        expect(rejected.length).toBe(1);
        expect(rejected[0]?.code).toBe(row.code);
        expect(rejected[0]?.status).toBe(row.status);
        // The 404 and 405 checks fire before auth, so they carry no
        // requestId; everything past the router does.
        if (row.code === "not-found" || row.code === "method-not-allowed") {
          expect(rejected[0]?.requestId).toBeUndefined();
        } else {
          expect(rejected[0]?.requestId).toBe(requestId);
        }
      },
      {},
    );
  });
}

test("an oversize body gives 413", async () => {
  // Bun's own transport cap answers before the handler when the
  // real bytes exceed it, so this row calls handleMeterRequest with a
  // lying Content-Length header. The branch answers on the header
  // value alone, before reading the body.
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter, tokenFor, events, loopback, internals }) => {
      const { requestId } = await openBoundGrant(meter);
      // Bun's own transport cap answers before the handler when the
      // real bytes exceed it, so this row calls handleMeterRequest
      // with the live state and a lying Content-Length header. The
      // branch answers on the header value alone, before any append.
      const req = new Request(meterUrl(meter), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenFor(requestId)}`,
          "Content-Length": "2000",
        },
        body: JSON.stringify(chatBody()),
      });
      expect(req.headers.get("content-length")).toBe("2000");
      const resp = await handleMeterRequest(
        internals.buildState(),
        req,
        null,
        "127.0.0.1",
        internals.usageIndex,
      );
      expect(resp.status).toBe(413);
      expect(((await resp.json()) as { error: { code: string } }).error.code).toBe(
        "body-too-large",
      );
      expect(loopback.requests().length).toBe(0);
      const rejected = events.filter((event) => event.event === "request-rejected");
      expect(rejected.length).toBe(1);
      expect(rejected[0]?.code).toBe("body-too-large");
      expect(rejected[0]?.status).toBe(413);
      expect(rejected[0]?.requestId).toBe(requestId);
    },
    { config: { maxRequestBytes: 100 } },
  );
});

test("wrong host gives 403", async () => {
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter, tokenFor, loopback, events, logPath }) => {
      const { requestId } = await openBoundGrant(meter);
      const resp = await post(meter, tokenFor(requestId), chatBody());
      expect(resp.status).toBe(403);
      expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("wrong-host");
      // Nothing upstream; the grant-open record stays. A1 held, so
      // the event carries the requestId. Through the live state this
      // also covers the owner-of lookup: dropping it leaves the alias
      // unknown and this test fails.
      expect(loopback.requests().length).toBe(0);
      expect(
        (await readLogLines(logPath)).some((line) => line.includes('"kind":"grant-open"')),
      ).toBe(true);
      const rejected = events.filter((event) => event.event === "request-rejected");
      expect(rejected.length).toBe(1);
      expect(rejected[0]?.code).toBe("wrong-host");
      expect(rejected[0]?.status).toBe(403);
      expect(rejected[0]?.requestId).toBe(requestId);
    },
    { hosts: { "laptop-a": ["127.0.0.2"] } },
  );
});

test("unbound grant past TTL gives 403, then 200 after bind", async () => {
  const openedAt = new Date("2026-10-27T10:00:00.000Z");
  let now = openedAt;
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter, tokenFor, events, logPath }) => {
      await meter.openGrant({
        requestId: "w1-demo:0",
        workItemId: "w1-demo",
        hostAlias: "laptop-a",
        providerId: "meta-api",
        model: "muse-spark-1.3-contributor",
      });
      // The TTL runs from the last open, so T0+2000 is past the
      // 1000 ms TTL of the T0 open.
      now = new Date(openedAt.getTime() + 2000);
      const denied = await post(meter, tokenFor("w1-demo:0"), chatBody());
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
        "grant-unbound",
      );
      // A reopen refreshes the last-open time, so this call is
      // admitted even though T0 is past the TTL.
      await meter.openGrant({
        requestId: "w1-demo:0",
        workItemId: "w1-demo",
        hostAlias: "laptop-a",
        providerId: "meta-api",
        model: "muse-spark-1.3-contributor",
      });
      const admitted = await post(meter, tokenFor("w1-demo:0"), chatBody());
      expect(admitted.status).toBe(200);
      await admitted.text();
      // Two TTLs later the TTL bites again.
      now = new Date(openedAt.getTime() + 4000);
      const deniedAgain = await post(meter, tokenFor("w1-demo:0"), chatBody());
      expect(deniedAgain.status).toBe(403);
      expect(((await deniedAgain.json()) as { error: { code: string } }).error.code).toBe(
        "grant-unbound",
      );
      await meter.bindGrant("w1-demo:0", "sess-1");
      const allowed = await post(meter, tokenFor("w1-demo:0"), chatBody());
      expect(allowed.status).toBe(200);
      await allowed.text();
      // Only the exact T0+1100/T0+2000 spacing distinguishes the correct
      // TTL from a from-the-first-open reading: both denials below carry
      // grant-unbound and write no call-start for them.
      const unbound = events.filter(
        (event) => event.event === "request-rejected" && event.code === "grant-unbound",
      );
      expect(unbound.length).toBe(2);
      expect(unbound[0]?.status).toBe(403);
      expect(unbound[0]?.requestId).toBe("w1-demo:0");
      expect(unbound[1]?.status).toBe(403);
      const starts = (await readLogLines(logPath)).filter((line) =>
        line.includes('"kind":"call-start"'),
      );
      expect(starts.length).toBe(2);
    },
    {
      config: { unboundGrantTtlMs: 1000 },
      now: () => now,
    },
  );
  // A fresh meter proves the TTL bites again from its own open.
  let then = openedAt;
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter, tokenFor }) => {
      await meter.openGrant({
        requestId: "w1-demo:0",
        workItemId: "w1-demo",
        hostAlias: "laptop-a",
        providerId: "meta-api",
        model: "muse-spark-1.3-contributor",
      });
      then = new Date(openedAt.getTime() + 2000);
      const denied = await post(meter, tokenFor("w1-demo:0"), chatBody());
      expect(denied.status).toBe(403);
    },
    {
      config: { unboundGrantTtlMs: 1000 },
      now: () => then,
    },
  );
});

test("caller model is rejected and the grant model is forwarded", async () => {
  await withMeter(
    "tests/meter/recordings/json-ok.json",
    async ({ meter, tokenFor, loopback, events }) => {
      const { requestId } = await openBoundGrant(meter);
      const bad = await post(
        meter,
        tokenFor(requestId),
        chatBody({ model: "meta/muse-glimmer-30b" }),
      );
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("model-mismatch");
      const rejected = events.filter(
        (e) => e.event === "request-rejected" && e.code === "model-mismatch",
      );
      expect(rejected.length).toBe(1);
      expect(rejected[0]?.status).toBe(400);
      expect(rejected[0]?.requestId).toBe(requestId);
      // A correct call forwards the grant model, not the caller one.
      const good = await post(meter, tokenFor(requestId), chatBody({ stream: false }));
      expect(good.status).toBe(200);
      await good.text();
      expect(loopback.requests().length).toBe(1);
      const sent = JSON.parse(loopback.requests()[0]?.body ?? "{}") as Record<string, unknown>;
      expect(sent["model"]).toBe("muse-spark-1.3-contributor");
    },
  );
});

test("key handling: upstream sees the provider key, never the caller token", async () => {
  await withMeter(
    "tests/meter/recordings/json-ok.json",
    async ({ meter, loopback, events, logPath }) => {
      const { token } = await openBoundGrant(meter);
      const resp = await post(meter, token, chatBody({ stream: false }), { "X-Caller-Probe": "1" });
      expect(resp.status).toBe(200);
      await resp.text();
      const seen = loopback.requests();
      expect(seen.length).toBe(1);
      expect(seen[0]?.headers["authorization"]).toBe("Bearer test-meta-key");
      expect(seen[0]?.headers["x-caller-probe"]).toBeUndefined();
      // No upstream header value carries the caller token, under
      // any name.
      for (const value of Object.values(seen[0]?.headers ?? {})) {
        expect(value.includes(token)).toBe(false);
      }
      const bodies = await readLogLines(logPath);
      for (const line of [...bodies, JSON.stringify(events)]) {
        expect(line.includes("test-meta-key")).toBe(false);
        expect(line.includes(token)).toBe(false);
      }
    },
  );
});

test("include_usage is forced on streamed calls", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter, loopback, events }) => {
    const { token, requestId } = await openBoundGrant(meter);
    const resp = await post(meter, token, chatBody({ stream_options: { include_usage: false } }));
    expect(resp.status).toBe(200);
    await resp.text();
    const sent = JSON.parse(loopback.requests()[0]?.body ?? "{}") as Record<string, unknown>;
    expect((sent["stream_options"] as Record<string, unknown>)["include_usage"]).toBe(true);
    // call-finished carries the host alias for the billing join.
    const finished = events.find((event) => event.event === "call-finished");
    expect(finished?.hostAlias).toBe("laptop-a");
    expect(finished?.requestId).toBe(requestId);
    // Even a billed 200 logs no request-rejected.
    expect(events.some((event) => event.event === "request-rejected")).toBe(false);
  });
});

test("no failover and no budget import: 429 passes through unbilled", async () => {
  const { Glob } = await import("bun");
  const glob = new Glob("src/meter/*.ts");
  const pattern = /(?:from\s*|import\s*\()\s*["'][^"']*\/budget\//;
  for await (const path of glob.scan({ cwd: "." })) {
    const source = await Bun.file(path).text();
    expect(source.match(pattern)).toBeNull();
    expect(source.includes("callWithFallback")).toBe(false);
  }
  await withMeter(
    "tests/meter/recordings/upstream-429.json",
    async ({ meter, tokenFor, logPath, events, loopback }) => {
      const { requestId } = await openBoundGrant(meter, { providerId: "meta-api" });
      const resp = await post(meter, tokenFor(requestId), chatBody());
      expect(resp.status).toBe(429);
      await resp.text();
      const end = readEnd(await readLogLines(logPath));
      expect(end["outcome"]).toBe("upstream-status");
      expect(end["billed"]).toBe(false);
      expect(end["inputTokens"]).toBeNull();
      // No failover means exactly the one recorded attempt.
      expect(loopback.requests().length).toBe(1);
      expect(events.some((event) => event.event === "request-rejected")).toBe(false);
    },
  );
});

test("first-byte timeout is billed with null counts", async () => {
  await withMeter(
    "tests/meter/recordings/stream-hold-headers.json",
    async ({ meter, tokenFor, logPath, loopback, timers }) => {
      const { requestId } = await openBoundGrant(meter);
      const pending = post(meter, tokenFor(requestId), chatBody());
      // The upstream holds before the headers; the first-byte deadline is
      // a manual timer, so no wall clock is involved.
      await loopback.waitHeld(1);
      await timers.waitForTimer(3001);
      timers.advance(3001);
      const resp = await pending;
      expect(resp.status).toBe(504);
      expect(((await resp.json()) as { error: { code: string } }).error.code).toBe(
        "upstream-timeout",
      );
      const end = readEnd(await readLogLines(logPath));
      expect(end["outcome"]).toBe("first-byte-timeout");
      expect(end["billed"]).toBe(true);
      expect(end["inputTokens"]).toBeNull();
      loopback.release();
    },
    { config: { firstByteTimeoutMs: 3001 } },
  );
});

test("call-end ms comes from the monotonic clock", async () => {
  await withMeter(
    "tests/meter/recordings/stream-hold-after-first.json",
    async ({ meter, tokenFor, logPath, loopback, timers, waitForEvent }) => {
      const { requestId } = await openBoundGrant(meter);
      const pending = post(meter, tokenFor(requestId), chatBody());
      await loopback.waitHeld(1);
      // The only clock the meter reads is the injected one.
      timers.advance(250);
      loopback.release();
      const resp = await pending;
      expect(resp.status).toBe(200);
      await resp.text();
      await waitForEvent((e) => e.event === "call-finished");
      const end = readEnd(await readLogLines(logPath));
      expect(end["ms"]).toBe(250);
    },
  );
});

test("stream 200 without usage is billed with null counts", async () => {
  await withMeter(
    "tests/meter/recordings/stream-no-usage.json",
    async ({ meter, tokenFor, logPath }) => {
      const { requestId } = await openBoundGrant(meter);
      const resp = await post(meter, tokenFor(requestId), chatBody());
      expect(resp.status).toBe(200);
      await resp.text();
      const end = readEnd(await readLogLines(logPath));
      expect(end["outcome"]).toBe("no-usage");
      expect(end["billed"]).toBe(true);
      expect(end["inputTokens"]).toBeNull();
      expect(end["outputTokens"]).toBeNull();
    },
  );
});

test("2xx other than 200 is metered like 200", async () => {
  await withMeter("tests/meter/recordings/json-201.json", async ({ meter, tokenFor, logPath }) => {
    const first = await openBoundGrant(meter, { requestId: "w1-demo:0" });
    const one = await post(meter, tokenFor(first.requestId), chatBody({ stream: false }));
    expect(one.status).toBe(201);
    await one.text();
    const second = await openBoundGrant(meter, { requestId: "w2-demo:0" });
    const two = await post(meter, tokenFor(second.requestId), chatBody({ stream: false }));
    expect(two.status).toBe(201);
    await two.text();
    const lines = await readLogLines(logPath);
    const ends = lines
      .filter((l) => l.includes('"kind":"call-end"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ends.length).toBe(2);
    expect(ends[0]?.["outcome"]).toBe("ok");
    expect(ends[0]?.["billed"]).toBe(true);
    expect(ends[0]?.["inputTokens"]).toBe(9);
    expect(ends[0]?.["outputTokens"]).toBe(4);
    expect(ends[1]?.["outcome"]).toBe("no-usage");
    expect(ends[1]?.["inputTokens"]).toBeNull();
    expect(ends[1]?.["outputTokens"]).toBeNull();
  });
});

test("only config timeouts apply, never the descriptor timeout", async () => {
  const source = await Bun.file("src/meter/proxy.ts").text();
  expect(source.includes("descriptor.timeoutMs")).toBe(false);
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter, tokenFor, logPath }) => {
      const { requestId } = await openBoundGrant(meter);
      const resp = await post(meter, tokenFor(requestId), chatBody());
      expect(resp.status).toBe(200);
      await resp.text();
      expect(readEnd(await readLogLines(logPath))["outcome"]).toBe("ok");
    },
    { config: { firstByteTimeoutMs: 60000, idleTimeoutMs: 60000, totalTimeoutMs: 60000 } },
  );
});

test("idle timeout aborts a slow stream", async () => {
  await withMeter(
    "tests/meter/recordings/stream-hold-after-first.json",
    async ({ meter, tokenFor, logPath, loopback, timers, waitForEvent }) => {
      const { requestId } = await openBoundGrant(meter);
      const resp = await post(meter, tokenFor(requestId), chatBody());
      // The caller side is read only through the reader: the first
      // chunk proves the tap saw the content frame, and the rest of
      // the body holds at the loopback.
      const reader = resp.body?.getReader();
      if (reader === undefined) {
        throw new Error("no body");
      }
      const first = await reader.read();
      expect(first.done).toBe(false);
      await loopback.waitHeld(1);
      // The idle timer re-armed on the first chunk; the 4001ms timer
      // must be pending before advancing, or the advance skips it.
      await timers.waitForTimer(4001);
      timers.advance(4001);
      await reader.read().catch(() => ({ done: true, value: undefined }));
      expect(resp.status).toBe(200);
      // The record is read only after call-finished, never from a
      // half-written log.
      await waitForEvent((e) => e.event === "call-finished");
      const end = readEnd(await readLogLines(logPath));
      expect(end["outcome"]).toBe("idle-timeout");
      expect(end["billed"]).toBe(true);
      // The usage frame is still held at the loopback, so the tap never
      // saw it: billed with null counts ("counts if seen").
      expect(end["inputTokens"]).toBeNull();
      expect(end["outputTokens"]).toBeNull();
    },
    { config: { idleTimeoutMs: 4001, firstByteTimeoutMs: 60001 } },
  );
});

test("total timeout runs from t0, not from the headers", async () => {
  await withMeter(
    "tests/meter/recordings/stream-hold-headers-then-first.json",
    async ({ meter, tokenFor, logPath, loopback, timers, waitForEvent }) => {
      const { requestId } = await openBoundGrant(meter);
      const pending = post(meter, tokenFor(requestId), chatBody());
      // 3000 ms pass before the headers arrive.
      await loopback.waitHeld(1);
      timers.advance(3000);
      loopback.release();
      // The first chunk arrives; the body then holds again.
      const resp = await pending;
      const reader = resp.body?.getReader();
      if (reader === undefined) {
        throw new Error("no body");
      }
      const first = await reader.read();
      expect(first.done).toBe(false);
      await loopback.waitHeld(2);
      // 2001 ms more: 5001 since t0, but the idle timer (60001) never
      // fires. Only a t0-based total timer kills this call.
      timers.advance(2001);
      await reader.read().catch(() => ({ done: true, value: undefined }));
      await waitForEvent((e) => e.event === "call-finished");
      const end = readEnd(await readLogLines(logPath));
      expect(end["outcome"]).toBe("total-timeout");
      expect(end["billed"]).toBe(true);
    },
    { config: { firstByteTimeoutMs: 3001, totalTimeoutMs: 5001, idleTimeoutMs: 60001 } },
  );
});

test("connection failure gives 502 and is not billed", async () => {
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter, tokenFor, logPath, loopback }) => {
      const { requestId } = await openBoundGrant(meter);
      const resp = await post(meter, tokenFor(requestId), chatBody());
      expect(resp.status).toBe(502);
      expect(((await resp.json()) as { error: { code: string } }).error.code).toBe(
        "upstream-unreachable",
      );
      const end = readEnd(await readLogLines(logPath));
      expect(end["outcome"]).toBe("upstream-unreachable");
      expect(end["billed"]).toBe(false);
      expect(loopback.requests().length).toBe(0);
    },
    { upstreamBaseUrl: "http://127.0.0.1:9" },
  );
});

test("a non-2xx body that stalls times out as upstream-status", async () => {
  await withMeter(
    "tests/meter/recordings/status-500-hold.json",
    async ({ meter, tokenFor, logPath, loopback, timers, waitForEvent }) => {
      const { requestId } = await openBoundGrant(meter);
      const resp = await post(meter, tokenFor(requestId), chatBody());
      expect(resp.status).toBe(500);
      // The whole body stalls behind the gate: nothing reaches the
      // caller yet. The idle timer armed at the headers; the 4001ms
      // timer must be pending before advancing.
      await loopback.waitHeld(1);
      await timers.waitForTimer(4001);
      timers.advance(4001);
      // The stall is over: the idle timeout won, the end went durable,
      // and the caller pull now rejects with the pump's error.
      const finished = await waitForEvent((e) => e.event === "call-finished");
      expect(finished.outcome).toBe("upstream-status");
      const textOutcome = await resp.text().then(
        () => "resolved",
        () => "rejected",
      );
      expect(textOutcome).toBe("rejected");
      const end = readEnd(await readLogLines(logPath));
      expect(end["outcome"]).toBe("upstream-status");
      expect(end["billed"]).toBe(false);
      expect(end["status"]).toBe(500);
      expect(end["inputTokens"]).toBeNull();
    },
    { config: { idleTimeoutMs: 4001, firstByteTimeoutMs: 60001 } },
  );
});

test("concurrency limit admits exactly one of five concurrent calls", async () => {
  await withMeter(
    "tests/meter/recordings/stream-hold-after-first.json",
    async ({ meter, tokenFor, logPath, loopback, events }) => {
      const { requestId } = await openBoundGrant(meter);
      const token = tokenFor(requestId);
      const calls = [0, 1, 2, 3, 4].map(() => post(meter, token, chatBody()));
      const resps = await Promise.all(calls);
      const statuses = resps.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses).toEqual([200, 429, 429, 429, 429]);
      for (const resp of resps) {
        if (resp.status === 429) {
          expect(((await resp.json()) as { error: { code: string } }).error.code).toBe(
            "session-concurrency",
          );
        }
      }
      const lines = await readLogLines(logPath);
      expect(lines.filter((l) => l.includes('"kind":"call-start"')).length).toBe(1);
      // Every rejection above 400 logs exactly one request-rejected.
      const concurrency = events.filter(
        (e) => e.event === "request-rejected" && e.code === "session-concurrency",
      );
      expect(concurrency.length).toBe(4);
      for (const event of concurrency) {
        expect(event.status).toBe(429);
        expect(event.requestId).toBe(requestId);
      }
      loopback.release();
      const ok = resps.find((r) => r.status === 200);
      if (ok === undefined) {
        throw new Error("no admitted call");
      }
      await ok.text();
    },
    { config: { maxInFlightPerSession: 1, idleTimeoutMs: 60000, totalTimeoutMs: 60000 } },
  );
});

test("callStartGuard checks the closed grant before the limit", () => {
  const grants = new Map([
    [
      "w1-demo:0",
      { open: undefined as never, lastOpenAt: "", sessionId: null as string | null, closed: true },
    ],
    [
      "w2-demo:0",
      { open: undefined as never, lastOpenAt: "", sessionId: null as string | null, closed: false },
    ],
  ]);
  const index = {
    grants,
    requestBySession: new Map(),
    starts: new Map(),
    startOrder: [],
    ends: new Map(),
  } as unknown as UsageIndex;
  expect(callStartGuard(index, "w1-demo:0", 0, 1, false)).toBe("grant-closed");
  expect(callStartGuard(index, "w2-demo:0", 1, 1, false)).toBe("session-concurrency");
  expect(callStartGuard(index, "w2-demo:0", 0, 1, true)).toBe("meter-unavailable");
  expect(callStartGuard(index, "w2-demo:0", 0, 1, false)).toBeNull();
});

test("a failed call-start write forwards nothing and latches", async () => {
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter, tokenFor, loopback, events, logPath }) => {
      const { requestId } = await openBoundGrant(meter);
      const first = await post(meter, tokenFor(requestId), chatBody());
      expect(first.status).toBe(503);
      expect(((await first.json()) as { error: { code: string } }).error.code).toBe(
        "meter-unavailable",
      );
      // No fetch started, no record written, and the latch holds for
      // the next call too.
      const second = await post(meter, tokenFor(requestId), chatBody());
      expect(second.status).toBe(503);
      expect(loopback.requests().length).toBe(0);
      expect(
        (await readLogLines(logPath)).filter((l) => l.includes('"kind":"call-start"')).length,
      ).toBe(0);
      expect(events.some((e) => e.event === "usage-log-failed")).toBe(true);
      const rejected = events.filter(
        (e) => e.event === "request-rejected" && e.code === "meter-unavailable",
      );
      expect(rejected.length).toBe(2);
    },
    {
      logIo: createFaultyIo(systemUsageLogIo, {
        failWhen: (line) => line.includes('"kind":"call-start"'),
      }),
    },
  );
});

test("call-end is durable before the caller stream errors", async () => {
  await withMeter(
    "tests/meter/recordings/stream-hold-after-first.json",
    async ({ meter, tokenFor, logPath, loopback, timers, events, waitForEvent }) => {
      const { requestId } = await openBoundGrant(meter);
      const resp = await post(meter, tokenFor(requestId), chatBody());
      expect(resp.status).toBe(200);
      // Do not touch the caller body at all here: nobody pulls, the
      // pump stalls on the gate, the idle timer fires, and the pump
      // the untouched caller stream. The order is then
      // observable on the events alone.
      await loopback.waitHeld(1);
      // The idle timer armed at the headers; the 4001ms timer must be
      // pending before advancing, or the advance skips it.
      await timers.waitForTimer(4001);
      timers.advance(4001);
      // Wait for the pump's durable end; the caller stream errors after.
      const finished = await waitForEvent((e) => e.event === "call-finished");
      expect(finished.outcome).toBe("idle-timeout");
      const errored = await waitForEvent((e) => e.event === "caller-stream-errored");
      // call-finished (the call-end is already durable) precedes the
      // stream error for the same call.
      const finishedAt = events.findIndex((e) => e.event === "call-finished");
      const erroredAt = events.findIndex((e) => e.event === "caller-stream-errored");
      expect(finishedAt).toBeGreaterThanOrEqual(0);
      expect(erroredAt).toBeGreaterThanOrEqual(0);
      expect(finishedAt).toBeLessThan(erroredAt);
      expect(events[finishedAt]?.callId).toBe(events[erroredAt]?.callId);
      expect(errored.outcome).toBe("idle-timeout");
      const end = readEnd(await readLogLines(logPath));
      expect(end["outcome"]).toBe("idle-timeout");
    },
    { config: { idleTimeoutMs: 4001, firstByteTimeoutMs: 60001 } },
  );
});

test("a caller error frees the session slot first", async () => {
  // Latch-pair entry 0 holds after its first usage chunk like
  // stream-hold-after-first entry 0; entry 1 is stream-ok-like, so the
  // second post has a hold-free response to return 200 on.
  await withMeter(
    "tests/meter/recordings/latch-pair.json",
    async ({ meter, tokenFor, loopback, timers, waitForEvent }) => {
      const { requestId } = await openBoundGrant(meter);
      const token = tokenFor(requestId);
      const first = await post(meter, token, chatBody());
      expect(first.status).toBe(200);
      // Nobody pulls the caller stream at all: the pump stalls on the
      // gate, the idle timer fires, the end goes durable, and the
      // untouched caller stream errors. No text() read is needed.
      await loopback.waitHeld(1);
      // Same idle-timer wait: the 4001ms timer must be pending
      // before advancing, or the advance skips the stall.
      await timers.waitForTimer(4001);
      timers.advance(4001);
      const finished = await waitForEvent((e) => e.event === "call-finished");
      expect(finished.outcome).toBe("idle-timeout");
      loopback.release();
      // The slot is free before the second call starts: finish() ran
      // before the stream errored, so this returns 200, not 429.
      const second = await post(meter, token, chatBody());
      expect(second.status).toBe(200);
      await second.text();
    },
    {
      config: { maxInFlightPerSession: 1, idleTimeoutMs: 4001, firstByteTimeoutMs: 60001 },
    },
  );
});

test("caller disconnect still records usage with clientGone", async () => {
  await withMeter(
    "tests/meter/recordings/stream-hold-after-first.json",
    async ({ meter, logPath, loopback, waitForEvent }) => {
      const { token } = await openBoundGrant(meter);
      const resp = await fetch(meterUrl(meter), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(chatBody()),
      });
      expect(resp.status).toBe(200);
      // Hold the loopback before the usage frame, cancel the
      // caller's reader, await caller-gone, then release. The log event
      // proves the pump observed the disconnect, so no counted yields
      // remain.
      const reader = resp.body?.getReader();
      if (reader === undefined) {
        throw new Error("no body");
      }
      const first = await reader.read();
      expect(first.done).toBe(false);
      await loopback.waitHeld(1);
      await reader.cancel();
      await waitForEvent((e) => e.event === "caller-gone");
      // The usage frame arrives only after the hold releases; the caller
      // already left, so clientGone is set but the outcome still bills.
      loopback.release();
      const finished = await waitForEvent((e) => e.event === "call-finished");
      expect(finished.outcome).toBe("ok");
      const end = readEnd(await readLogLines(logPath));
      expect(end["clientGone"]).toBe(true);
      expect(end["outcome"]).toBe("ok");
      expect(end["inputTokens"]).toBe(1200);
      expect(end["outputTokens"]).toBe(80);
    },
  );
});

test("a grant whose provider left the routes gives 503 provider-not-routed", async () => {
  // The grant opens while meta-api is still routed; a second meter on
  // the same log directory then serves the call with meta-api removed
  // from the route table. The fixture cannot swap providers mid-test,
  // so this test builds both meters by hand.
  const dir = mkdtempSync(join(tmpdir(), "meter-unrouted-"));
  const hostsFile = join(dir, "hosts.json");
  await Bun.write(hostsFile, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
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
  const loopback = await startLoopback("tests/meter/recordings/json-ok.json");
  const started: Meter[] = [];
  try {
    process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
    const base = await loadMeterConfig();
    const secret = randomBytes(32).toString("base64");
    const full = await getProviders();
    const firstConfig: MeterConfig = { ...base, usageLogPath: join(dir, "usage.jsonl") };
    const firstEnv = await resolveMeterEnv(firstConfig, {
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: secret,
      MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
    });
    const first = await startMeter({
      config: firstConfig,
      env: firstEnv,
      providers: full,
      timers: createManualTimers(),
      logIo: systemUsageLogIo,
      now: () => new Date(),
      log: () => {},
    });
    started.push(first);
    await first.openGrant({
      requestId: "w1-demo:0",
      workItemId: "w1-demo",
      hostAlias: "laptop-a",
      providerId: "meta-api",
      model: "muse-spark-1.3-contributor",
    });
    await first.bindGrant("w1-demo:0", "sess-1");
    const token = first.tokenFor("w1-demo:0");
    await first.close();
    const reduced = { ...full };
    delete reduced["meta-api"];
    const events: MeterLogEvent[] = [];
    const second = await startMeter({
      config: firstConfig,
      env: firstEnv,
      providers: reduced,
      timers: createManualTimers(),
      logIo: systemUsageLogIo,
      now: () => new Date(),
      log: (e) => events.push(e),
    });
    started.push(second);
    const resp = await fetch(meterUrl(second), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(chatBody({ stream: false })),
    });
    expect(resp.status).toBe(503);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe(
      "provider-not-routed",
    );
    const rejected = events.filter((event) => event.event === "request-rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.code).toBe("provider-not-routed");
    expect(rejected[0]?.status).toBe(503);
    expect(rejected[0]?.requestId).toBe("w1-demo:0");
  } finally {
    for (const meter of started) {
      await meter.close().catch(() => {});
    }
    await loopback.stop();
    resetProvidersCache();
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider key missing gives 503", async () => {
  await withMeter("tests/meter/recordings/json-ok.json", async ({ meter, tokenFor, events }) => {
    const { requestId } = await openBoundGrant(meter);
    delete process.env.META_API_KEY;
    const resp = await post(meter, tokenFor(requestId), chatBody({ stream: false }));
    expect(resp.status).toBe(503);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe(
      "provider-key-missing",
    );
    const rejected = events.filter((event) => event.event === "request-rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.code).toBe("provider-key-missing");
    expect(rejected[0]?.status).toBe(503);
    expect(rejected[0]?.requestId).toBe(requestId);
  });
});

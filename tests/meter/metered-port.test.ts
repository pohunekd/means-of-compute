// Metered-port tests of amendment section 4: the grant lifecycle
// around the inner port, usage replacement, rejection mapping and
// deep-equal P3 terminals.
import { expect, test } from "bun:test";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import {
  PortRejectedError,
  PortUnreachableError,
  type StartRequest,
} from "../../src/dispatcher/port.js";
import { createFaultyIo } from "./faulty-io.js";
import { readLogLines, withMeter } from "./helpers.js";
import { createMeteredPort } from "../../src/meter/metered-port.js";
import { MeterUnavailableError } from "../../src/meter/meter.js";
import { systemUsageLogIo } from "../../src/meter/usage-log.js";

function startReq(overrides: Partial<StartRequest> = {}): StartRequest {
  return {
    requestId: "w1-demo:0",
    workItemId: "w1-demo",
    repo: "example/demo",
    hostAlias: "laptop-a",
    branch: "moc/w1-demo",
    baseRef: "origin/main",
    resume: false,
    model: { providerId: "meta-api", model: "muse-spark-1.3-contributor" },
    brief: "Do the work.",
    ...overrides,
  };
}

test("P1 replay opens twice and binds once", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter, logPath }) => {
    const control = createMemoryPort();
    const events: Array<{ event: string }> = [];
    const port = createMeteredPort(control.port, meter, (e) => {
      events.push(e);
    });
    const req = startReq();
    const first = await port.start(req);
    const second = await port.start(req);
    expect(second).toEqual(first);
    const lines = await readLogLines(logPath);
    expect(lines.filter((line) => line.includes('"kind":"grant-open"'))).toHaveLength(2);
    const binds = lines.filter((line) => line.includes('"kind":"grant-bind"'));
    expect(binds).toHaveLength(1);
    expect((JSON.parse(binds[0] as string) as { sessionId: unknown }).sessionId).toBe(
      first.sessionId,
    );
    expect(control.sessions()).toHaveLength(1);
  });
});

test("a terminal wait replaces the inner usage", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter, events }) => {
    const control = createMemoryPort();
    const port = createMeteredPort(control.port, meter, (e) => {
      events.push(e);
    });
    const handle = await port.start(startReq());
    control.complete(handle.sessionId, {
      state: "finished",
      usage: {
        tokens: [
          {
            provider: "test-provider",
            model: "test-model",
            inputTokens: 5,
            outputTokens: 6,
            requests: 2,
            source: "test-port",
          },
        ],
      },
      detail: "x",
    });
    const result = await port.wait(
      { sessionId: handle.sessionId, hostAlias: "laptop-a" },
      1000,
      null,
    );
    if (result.state !== "finished") {
      throw new Error("expected a finished terminal");
    }
    expect(result.usage?.tokens).toEqual([
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        source: "meter-proxy",
      },
    ]);
    expect(events.filter((e) => e.event === "port-usage-ignored")).toHaveLength(1);
  });
});

test("an unrouted provider is rejected before the inner start", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter }) => {
    const control = createMemoryPort();
    const port = createMeteredPort(control.port, meter, () => {});
    let error: unknown;
    try {
      await port.start(startReq({ model: { providerId: "local", model: "local-model" } }));
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PortRejectedError);
    expect((error as PortRejectedError).code).toBe("meter-provider-not-routed");
    expect(control.sessions()).toHaveLength(0);
  });
});

test("a closed grant on start is unreachable", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter }) => {
    const control = createMemoryPort();
    const port = createMeteredPort(control.port, meter, () => {});
    const req = startReq();
    await meter.openGrant({
      requestId: req.requestId,
      workItemId: req.workItemId,
      hostAlias: req.hostAlias,
      providerId: req.model.providerId,
      model: req.model.model,
    });
    await meter.bindGrant(req.requestId, "sess-closed");
    await meter.settleRequest(req.requestId, "lost");
    let error: unknown;
    try {
      await port.start(req);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PortUnreachableError);
    expect(error).not.toBeInstanceOf(PortRejectedError);
  });
});

test("a latched meter passes MeterUnavailableError through", async () => {
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter }) => {
      const control = createMemoryPort();
      const port = createMeteredPort(control.port, meter, () => {});
      let error: unknown;
      try {
        await port.start(startReq());
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(MeterUnavailableError);
      expect(control.sessions()).toHaveLength(0);
    },
    {
      logIo: createFaultyIo(systemUsageLogIo, {
        failWhen: (l) => l.includes('"kind":"grant-open"'),
      }),
    },
  );
});

test("cancel and wait return deep-equal terminals", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter, logPath }) => {
    const control = createMemoryPort();
    const port = createMeteredPort(control.port, meter, () => {});
    const handle = await port.start(startReq());
    control.complete(handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    const first = await port.wait(ref, 1000, null);
    const second = await port.wait(ref, 1000, null);
    const cancelled = await port.cancel(ref, "host-left");
    expect(second).toEqual(first);
    expect(cancelled).toEqual(first);
    expect(
      (await readLogLines(logPath)).filter((l) => l.includes('"kind":"grant-close"')),
    ).toHaveLength(1);
  });
});

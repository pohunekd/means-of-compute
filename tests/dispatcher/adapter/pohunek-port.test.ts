// Pohunek port tests (design 6.2, start and P1 rows): the first start runs
// S2, S4, S6 in order with an accepted phase and a P7 handle; A1-A9 behave as
// named in 5.3; P1 replay and conflict rows hold. The fake daemon stands in
// for the host; real Clients run over the Transport seam.
import { expect, test } from "bun:test";
import { createFakeDaemon } from "../../../src/dispatcher/adapter/fake-daemon.js";
import {
  MOC_METADATA,
  requestDigestOf,
  type waitDecision,
} from "../../../src/dispatcher/adapter/map.js";

type SessionWaitTurnResult = Parameters<typeof waitDecision>[1];
import {
  createPohunekPort,
  type AdapterLogEvent,
} from "../../../src/dispatcher/adapter/pohunek-port.js";
import type { PohunekAdapterConfig } from "../../../src/dispatcher/adapter/config.js";
import { PortRejectedError, type StartRequest } from "../../../src/dispatcher/port.js";

const CONFIG: PohunekAdapterConfig = {
  agentProfile: "moc-worker",
  project: "means-of-compute",
  cols: 200,
  rows: 50,
  inputAckTimeoutMs: 8000,
  connectTimeoutMs: 5000,
  cancelWaitTimeoutMs: 30000,
  diffLogPath: "logs/dispatch-diff.jsonl",
  resolveLogPath: "logs/dispatch-resolve.jsonl",
  hostRoutesFileEnv: "MOC_HOST_ROUTES_FILE",
};

const METER_TOKEN = (rid: string): string => "moc1." + rid + ".T";

function request(overrides: Partial<StartRequest> = {}): StartRequest {
  return {
    requestId: "req-1",
    workItemId: "item-1",
    repo: "example-repo",
    hostAlias: "laptop-a",
    branch: "moc/item-1",
    baseRef: "origin/main",
    resume: false,
    model: { providerId: "test-provider", model: "test-model" },
    brief: "do the thing",
    ...overrides,
  };
}

function eventsOf(log: readonly AdapterLogEvent[]): readonly string[] {
  return log.map((entry) => entry.event);
}

function setup(): {
  fake: ReturnType<typeof createFakeDaemon>;
  log: AdapterLogEvent[];
  port: ReturnType<typeof createPohunekPort>;
} {
  const fake = createFakeDaemon(["laptop-a"], CONFIG.agentProfile);
  const log: AdapterLogEvent[] = [];
  const port = createPohunekPort(CONFIG, {
    connector: fake.connector,
    log: (event) => {
      log.push(event);
    },
    meterToken: METER_TOKEN,
  });
  return { fake, log, port };
}

async function teardown(
  fake: ReturnType<typeof createFakeDaemon>,
  port: ReturnType<typeof createPohunekPort>,
): Promise<void> {
  await port.close();
  await fake.connector.close();
}

function methodNames(fake: ReturnType<typeof createFakeDaemon>, alias: string): readonly string[] {
  return fake.calls(alias).map((call) => call.method);
}

test("the first start runs S2, S4 and S6 in order with an accepted phase", async () => {
  const { fake, log, port } = setup();
  try {
    const req = request();
    const handle = await port.start(req);
    expect(handle.sessionId).toBe("fake-1");
    expect(handle.requestId).toBe("req-1");
    expect(handle.hostAlias).toBe("laptop-a");
    expect(handle.branch).toBe("moc/item-1");
    expect(handle.worktree).toBe("/fake/laptop-a/1");
    expect(handle.baseCommit).toBeNull();
    const methods = methodNames(fake, "laptop-a").filter((method) => method.startsWith("session."));
    expect(methods).toEqual(["session.list", "session.new", "session.set_metadata"]);
    const listed = fake.sessions("laptop-a");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.metadata?.[MOC_METADATA.start]).toBe("accepted");
    expect(listed[0]?.metadata?.[MOC_METADATA.requestDigest]).toBe(requestDigestOf(req));
    expect(eventsOf(log)).toContain("adapter-start-accepted");
  } finally {
    await teardown(fake, port);
  }
});

function finishedTurn(id: string, cursor = "cursor-1"): SessionWaitTurnResult {
  return {
    reason: "event",
    event: {
      session_id: id,
      kind: "turn_completed",
      at: "2026-10-27T00:00:00Z",
    },
    cursor,
    progress: [{ session_id: id, state: "running", output_advanced: true }],
  };
}

test("retire removes a finished session through session.remove_accepting_unconfirmed", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId));
    const result = await port.wait(
      { sessionId: handle.sessionId, hostAlias: "laptop-a" },
      1000,
      null,
    );
    expect(result.state).toBe("finished");
    const live = await port.start(request({ requestId: "req-live" }));
    const liveRetire = await port.retire({ sessionId: live.sessionId, hostAlias: "laptop-a" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(liveRetire).toBeInstanceOf(PortRejectedError);
    expect((liveRetire as PortRejectedError).code).toBe("session-live");
    expect(fake.sessions("laptop-a").some((info) => info.id === live.sessionId)).toBe(true);
    const first = await port.retire({ sessionId: handle.sessionId, hostAlias: "laptop-a" });
    expect(first).toBe("removed");
    expect(methodNames(fake, "laptop-a")).toContain("session.remove_accepting_unconfirmed");
    const second = await port.retire({ sessionId: handle.sessionId, hostAlias: "laptop-a" });
    expect(second).toBe("absent");
  } finally {
    await teardown(fake, port);
  }
});

test("wait stores a finished terminal with set_metadata then stop (W5, W6)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId));
    const result = await port.wait(
      { sessionId: handle.sessionId, hostAlias: "laptop-a" },
      1000,
      null,
    );
    expect(result).toEqual({
      state: "finished",
      sessionId: handle.sessionId,
      cursor: "cursor-1",
      usage: null,
      detail: "turn completed",
    });
    const methods = methodNames(fake, "laptop-a");
    const markIndex = methods.lastIndexOf("session.set_metadata");
    const stopIndex = methods.lastIndexOf("session.stop");
    expect(markIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(markIndex);
    expect(fake.sessions("laptop-a")[0]?.metadata?.[MOC_METADATA.outcome]).toBe("finished");
  } finally {
    await teardown(fake, port);
  }
});

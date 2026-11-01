// Pohunek port tests (design 6.2, start and P1 rows): the first start runs
// S2, S4, S6 in order with an accepted phase and a P7 handle; A1-A9 behave as
// named in 5.3; P1 replay and conflict rows hold. The fake daemon stands in
// for the host; real Clients run over the Transport seam.
import { expect, test } from "bun:test";
import { createFakeDaemon, fakeErrors } from "../../../src/dispatcher/adapter/fake-daemon.js";
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
  meterTokenEnv: "MOC_METER_TOKEN",
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

test("a voided start removes its session so the branch is free for the retry", async () => {
  const { fake, log, port } = setup();
  try {
    fake.onNew("laptop-a", () => ({
      warnings: [{ kind: "fetch", message: "fetch of origin failed" }],
    }));
    let error: unknown;
    try {
      await port.start(request());
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PortRejectedError);
    expect((error as PortRejectedError).code).toBe("fetch-failed");
    const methods = methodNames(fake, "laptop-a").filter((method) => method.startsWith("session."));
    expect(methods).toEqual([
      "session.list",
      "session.new",
      "session.stop",
      "session.set_metadata",
      "session.remove_accepting_unconfirmed",
    ]);
    expect(fake.sessions("laptop-a")).toHaveLength(0);
    expect(eventsOf(log)).toContain("adapter-start-void");
  } finally {
    await teardown(fake, port);
  }
});

test("start sends the token in the secret env slot (D1)", async () => {
  const { fake, log, port } = setup();
  try {
    await port.start(request());
    const news = fake.calls("laptop-a").filter((call) => call.method === "session.new");
    expect(news).toHaveLength(1);
    const params = news[0]?.params as { secret_env?: unknown; metadata?: unknown };
    expect(params.secret_env).toEqual({ MOC_METER_TOKEN: METER_TOKEN("req-1") });
    const metadata = params.metadata as Record<string, string>;
    for (const value of Object.values(metadata)) {
      expect(value).not.toBe(METER_TOKEN("req-1"));
    }
    expect(JSON.stringify(fake.sessions("laptop-a"))).not.toContain(METER_TOKEN("req-1"));
    expect(JSON.stringify(log)).not.toContain(METER_TOKEN("req-1"));
  } finally {
    await teardown(fake, port);
  }
});

test("a refused void removal is logged and the void keeps its code", async () => {
  const { fake, log, port } = setup();
  try {
    fake.onNew("laptop-a", () => ({
      warnings: [{ kind: "fetch", message: "fetch of origin failed" }],
    }));
    fake.failNext("laptop-a", "session.remove_accepting_unconfirmed", {
      errCode: "fake_unscripted",
      apply: false,
    });
    let error: unknown;
    try {
      await port.start(request());
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PortRejectedError);
    expect((error as PortRejectedError).code).toBe("fetch-failed");
    const sessions = fake.sessions("laptop-a");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.metadata?.[MOC_METADATA.start]).toBe("void");
    const failed = log.find((entry) => entry.event === "adapter-void-remove-failed");
    expect(failed).toBeDefined();
    expect(failed?.hostAlias).toBe("laptop-a");
  } finally {
    await teardown(fake, port);
  }
});

test("a fresh start that reuses a branch with no work beyond the base is accepted", async () => {
  const { fake, log, port } = setup();
  try {
    fake.onNew("laptop-a", () => ({
      warnings: [{ kind: "base_branch_fallback", message: "branch already exists" }],
    }));
    const handle = await port.start(request());
    expect(handle.sessionId).toBe("fake-1");
    expect(handle.branch).toBe("moc/item-1");
    const methods = methodNames(fake, "laptop-a").filter((method) => method.startsWith("session."));
    expect(methods).toEqual([
      "session.list",
      "session.new",
      "session.diff",
      "session.set_metadata",
    ]);
    const diffCall = fake.calls("laptop-a").find((call) => call.method === "session.diff");
    expect((diffCall?.params as { base: string }).base).toBe("origin/main");
    expect(fake.sessions("laptop-a")[0]?.metadata?.[MOC_METADATA.start]).toBe("accepted");
    const warning = log.find(
      (entry) => entry.event === "adapter-start-warning" && entry.detail === "base_branch_fallback",
    );
    expect(warning).toBeDefined();
    expect(eventsOf(log)).toContain("adapter-start-accepted");
  } finally {
    await teardown(fake, port);
  }
});

test("start without the secret env capability refuses host-unsupported (D2)", async () => {
  const { fake, log, port } = setup();
  try {
    fake.setCapabilities("laptop-a", { session_new_secret_env_supported: false });
    const outcome = await port.start(request()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(PortRejectedError);
    expect((outcome as PortRejectedError).code).toBe("host-unsupported");
    expect(methodNames(fake, "laptop-a")).not.toContain("session.new");
    expect(
      log.some(
        (entry) =>
          entry.event === "adapter-host-unsupported" &&
          entry.detail === "session_new_secret_env_supported",
      ),
    ).toBe(true);
  } finally {
    await teardown(fake, port);
  }
});

test("a fresh start that reuses a branch with work beyond the base is voided", async () => {
  const { fake, log, port } = setup();
  try {
    fake.onNew("laptop-a", () => ({
      warnings: [{ kind: "base_branch_fallback", message: "branch already exists" }],
    }));
    fake.setDiff("laptop-a", "fake-1", {
      diff: "diff --git a/x b/x\n",
      base: "origin/main",
      truncated: false,
    });
    let error: unknown;
    try {
      await port.start(request());
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PortRejectedError);
    expect((error as PortRejectedError).code).toBe("base-branch-fallback");
    const methods = methodNames(fake, "laptop-a").filter((method) => method.startsWith("session."));
    expect(methods).toEqual([
      "session.list",
      "session.new",
      "session.diff",
      "session.stop",
      "session.set_metadata",
      "session.remove_accepting_unconfirmed",
    ]);
    expect(fake.sessions("laptop-a")).toHaveLength(0);
    expect(eventsOf(log)).toContain("adapter-start-void");
  } finally {
    await teardown(fake, port);
  }
});

test("a reuse diff that times out voids the start on the open client", async () => {
  const { fake, log, port } = setup();
  try {
    fake.onNew("laptop-a", () => ({
      warnings: [{ kind: "base_branch_fallback", message: "branch already exists" }],
    }));
    fake.failNext("laptop-a", "session.diff", {
      error: fakeErrors.requestTimeout("laptop-a"),
      apply: false,
    });
    let error: unknown;
    try {
      await port.start(request());
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PortRejectedError);
    expect((error as PortRejectedError).code).toBe("base-branch-fallback");
    const methods = methodNames(fake, "laptop-a").filter((method) => method.startsWith("session."));
    expect(methods).toEqual([
      "session.list",
      "session.new",
      "session.diff",
      "session.stop",
      "session.set_metadata",
      "session.remove_accepting_unconfirmed",
    ]);
    expect(fake.sessions("laptop-a")).toHaveLength(0);
    const failed = log.find((entry) => entry.event === "adapter-reuse-diff-failed");
    expect(failed?.code).toBe("unreachable");
    expect(eventsOf(log)).toContain("adapter-start-void");
    expect(eventsOf(log)).not.toContain("adapter-connection-dropped");
  } finally {
    await teardown(fake, port);
  }
});

test("secret_env_missing on a continued item rejects without resume or fork (D3)", async () => {
  const { fake, port } = setup();
  try {
    fake.failNext("laptop-a", "session.new", { errCode: "secret_env_missing", apply: false });
    const outcome = await port.start(request({ resume: true, baseRef: "origin/moc/item-1" })).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(PortRejectedError);
    expect((outcome as PortRejectedError).code).toBe("secret-env-missing");
    const methods = methodNames(fake, "laptop-a");
    expect(methods.filter((method) => method === "session.new")).toHaveLength(1);
    expect(methods).not.toContain("session.resume");
    expect(methods).not.toContain("session.fork");
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

// Concurrent worktree creations on one host race on its git fetch, so the
// port runs one start per host at a time; other hosts never wait.
test("starts on one host run one at a time and a voided start releases the next", async () => {
  const fake = createFakeDaemon(["laptop-a", "laptop-b"], CONFIG.agentProfile);
  const port = createPohunekPort(CONFIG, {
    connector: fake.connector,
    log: () => undefined,
    meterToken: METER_TOKEN,
  });
  try {
    let created = 0;
    fake.onNew("laptop-a", () => {
      created += 1;
      return created === 1
        ? { warnings: [{ kind: "fetch", message: "fetch of origin failed" }] }
        : {};
    });
    const paused = fake.pauseNext("laptop-a", "session.new");
    const first = port.start(request());
    const gate = await paused;
    const second = port.start(
      request({ requestId: "req-2", workItemId: "item-2", branch: "moc/item-2" }),
    );
    const other = await port.start(request({ requestId: "req-3", hostAlias: "laptop-b" }));
    expect(other.hostAlias).toBe("laptop-b");
    const newCalls = methodNames(fake, "laptop-a").filter((method) => method === "session.new");
    expect(newCalls).toHaveLength(1);
    gate.release();
    let error: unknown;
    try {
      await first;
    } catch (caught: unknown) {
      error = caught;
    }
    expect((error as PortRejectedError).code).toBe("fetch-failed");
    expect((await second).requestId).toBe("req-2");
  } finally {
    await teardown(fake, port);
  }
});

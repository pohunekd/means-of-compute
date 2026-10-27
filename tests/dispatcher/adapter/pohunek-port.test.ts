// Pohunek port tests (design 6.2, start and P1 rows): the first start runs
// S2, S4, S6 in order with an accepted phase and a P7 handle; A1-A9 behave as
// named in 5.3; P1 replay and conflict rows hold. The fake daemon stands in
// for the host; real Clients run over the Transport seam.
import { expect, test } from "bun:test";
import type { SessionNewParams, SessionWaitTurnResult } from "@pohunek/sdk";
import { createFakeDaemon, fakeErrors } from "../../../src/dispatcher/adapter/fake-daemon.js";
import {
  MOC_METADATA,
  requestDigestOf,
  sessionNewParams,
} from "../../../src/dispatcher/adapter/map.js";
import {
  createPohunekPort,
  type AdapterLogEvent,
} from "../../../src/dispatcher/adapter/pohunek-port.js";
import type { PohunekAdapterConfig } from "../../../src/dispatcher/adapter/config.js";
import type { SessionHandle, StartRequest } from "../../../src/dispatcher/port.js";
import { PortRejectedError, PortUnreachableError } from "../../../src/dispatcher/port.js";
import { PohunekAdapterError } from "../../../src/dispatcher/adapter/pohunek-port.js";

const CONFIG: PohunekAdapterConfig = {
  agentProfile: "moc-worker",
  project: "means-of-compute",
  cols: 200,
  rows: 50,
  inputAckTimeoutMs: 8000,
  connectTimeoutMs: 5000,
  cancelWaitTimeoutMs: 30000,
  hostRoutesFileEnv: "MOC_HOST_ROUTES_FILE",
};

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

test("a resume start sends branch_source remote and reports the base commit", async () => {
  const { fake, port } = setup();
  try {
    const req = request({ resume: true });
    const params = sessionNewParams(req, CONFIG, requestDigestOf(req));
    expect(params.branch_source).toBe("remote");
    expect("base_branch" in params).toBe(false);
    const handle = await port.start(req);
    expect(handle.baseCommit).toBe("0123456789abcdef0123456789abcdef01234567");
  } finally {
    await teardown(fake, port);
  }
});

test("host-unsupported makes no session call", async () => {
  const { fake, log, port } = setup();
  try {
    fake.setCapabilities("laptop-a", { git_available: false });
    await expect(port.start(request())).rejects.toBeInstanceOf(PortRejectedError);
    await expect(port.start(request())).rejects.toMatchObject({ code: "host-unsupported" });
    expect(methodNames(fake, "laptop-a")).not.toContain("session.list");
    expect(eventsOf(log)).toContain("adapter-host-unsupported");
    expect(log.find((entry) => entry.event === "adapter-host-unsupported")?.detail).toBe(
      "git_available",
    );
  } finally {
    await teardown(fake, port);
  }
});

test("unknown-host-alias makes no connection", async () => {
  const { fake, port } = setup();
  try {
    const portError = await port
      .start(request({ hostAlias: "unknown-host" }))
      .catch((error: unknown) => error);
    expect(portError).toBeInstanceOf(PortRejectedError);
    expect((portError as PortRejectedError).code).toBe("unknown-host-alias");
    expect(methodNames(fake, "laptop-a")).toHaveLength(0);
  } finally {
    await teardown(fake, port);
  }
});

test("an unreachable host before session.new creates nothing (A1)", async () => {
  const { fake, port } = setup();
  try {
    fake.setUnreachable("laptop-a", true);
    await expect(port.start(request())).rejects.toBeInstanceOf(PortUnreachableError);
    expect(fake.sessions("laptop-a")).toHaveLength(0);
    fake.setUnreachable("laptop-a", false);
    const handle = await port.start(request());
    expect(handle.sessionId).toBe("fake-1");
  } finally {
    await teardown(fake, port);
  }
});

test("a lost session.new reply is voided on replay (A2)", async () => {
  const { fake, port } = setup();
  try {
    fake.failNext("laptop-a", "session.new", {
      error: fakeErrors.requestTimeout("laptop-a"),
      apply: true,
    });
    await expect(port.start(request())).rejects.toBeInstanceOf(PortUnreachableError);
    await expect(port.start(request())).rejects.toMatchObject({ code: "start-unconfirmed" });
    const handle = await port.start(request());
    expect(handle.sessionId).toBe("fake-2");
    const sessions = fake.sessions("laptop-a");
    expect(sessions.map((session) => session.metadata?.[MOC_METADATA.start])).toEqual([
      "void",
      "accepted",
    ]);
    const news = methodNames(fake, "laptop-a").filter((method) => method === "session.new");
    expect(news).toHaveLength(2);
  } finally {
    await teardown(fake, port);
  }
});

test("an unreachable accept write is voided on replay (A4)", async () => {
  const { fake, port } = setup();
  try {
    fake.failNext("laptop-a", "session.set_metadata", {
      error: fakeErrors.requestTimeout("laptop-a"),
      apply: false,
    });
    await expect(port.start(request())).rejects.toBeInstanceOf(PortUnreachableError);
    await expect(port.start(request())).rejects.toMatchObject({ code: "start-unconfirmed" });
    const handle = await port.start(request());
    expect(handle.sessionId).toBe("fake-2");
    expect(fake.sessions("laptop-a")[0]?.metadata?.[MOC_METADATA.start]).toBe("void");
  } finally {
    await teardown(fake, port);
  }
});

test("a replayed start returns the same session (A5, P1)", async () => {
  const { fake, port } = setup();
  try {
    const first = await port.start(request());
    const newsBefore = methodNames(fake, "laptop-a").filter(
      (method) => method === "session.new",
    ).length;
    const second = await port.start(request());
    expect(second.sessionId).toBe(first.sessionId);
    expect(second).toEqual(first);
    const newsAfter = methodNames(fake, "laptop-a").filter(
      (method) => method === "session.new",
    ).length;
    expect(newsAfter).toBe(newsBefore);
  } finally {
    await teardown(fake, port);
  }
});

test("a changed brief gives request-conflict (P1)", async () => {
  const { fake, port } = setup();
  try {
    await port.start(request());
    await expect(port.start(request({ brief: "a different task" }))).rejects.toMatchObject({
      code: "request-conflict",
    });
    expect(fake.sessions("laptop-a")).toHaveLength(1);
  } finally {
    await teardown(fake, port);
  }
});

test("two bound sessions give request-duplicated (P1)", async () => {
  const { fake, port } = setup();
  try {
    await port.start(request());
    const client = await fake.connector.client("laptop-a");
    await client.call("session.new", {
      agent: CONFIG.agentProfile,
      name: request().requestId,
      cols: CONFIG.cols,
      rows: CONFIG.rows,
      project: CONFIG.project,
      branch: request().branch,
      input: request().brief,
      input_ack_timeout_ms: CONFIG.inputAckTimeoutMs,
      metadata: {
        [MOC_METADATA.requestId]: request().requestId,
        [MOC_METADATA.requestDigest]: requestDigestOf(request()),
        [MOC_METADATA.start]: "pending",
      },
    } satisfies SessionNewParams);
    await expect(port.start(request())).rejects.toMatchObject({
      code: "request-duplicated",
    });
  } finally {
    await teardown(fake, port);
  }
});

test("a failed stop keeps the binding (A6)", async () => {
  const { fake, port } = setup();
  try {
    fake.onNew(
      "laptop-a",
      () => ({ prompt_delivered: false }) as Partial<import("@pohunek/sdk").SessionNewResult>,
    );
    fake.failNext("laptop-a", "session.stop", {
      error: fakeErrors.requestTimeout("laptop-a"),
      apply: false,
    });
    await expect(port.start(request())).rejects.toBeInstanceOf(PortUnreachableError);
    const newsBefore = methodNames(fake, "laptop-a").filter(
      (method) => method === "session.new",
    ).length;
    expect(newsBefore).toBe(1);
    const bound = fake.sessions("laptop-a");
    expect(bound).toHaveLength(1);
    expect(bound[0]?.metadata?.[MOC_METADATA.requestId]).toBe("req-1");
    fake.onNew("laptop-a", () => ({}));
    await expect(port.start(request())).rejects.toMatchObject({ code: "start-unconfirmed" });
    const newsDuringReplay = methodNames(fake, "laptop-a").filter(
      (method) => method === "session.new",
    ).length;
    expect(newsDuringReplay).toBe(1);
    const handle = await port.start(request());
    expect(handle.sessionId).toBe("fake-2");
  } finally {
    await teardown(fake, port);
  }
});

test("an unreachable unbind is retried on replay (A7)", async () => {
  const { fake, port } = setup();
  try {
    fake.onNew(
      "laptop-a",
      () => ({ prompt_delivered: false }) as Partial<import("@pohunek/sdk").SessionNewResult>,
    );
    fake.failNext("laptop-a", "session.set_metadata", {
      error: fakeErrors.requestTimeout("laptop-a"),
      apply: false,
    });
    await expect(port.start(request())).rejects.toBeInstanceOf(PortUnreachableError);
    const bound = fake.sessions("laptop-a");
    expect(bound).toHaveLength(1);
    expect(bound[0]?.metadata?.[MOC_METADATA.requestId]).toBe("req-1");
    fake.onNew("laptop-a", () => ({}));
    await expect(port.start(request())).rejects.toMatchObject({ code: "start-unconfirmed" });
    const handle = await port.start(request());
    expect(handle.sessionId).toBe("fake-2");
    expect(fake.sessions("laptop-a")[0]?.metadata?.[MOC_METADATA.start]).toBe("void");
  } finally {
    await teardown(fake, port);
  }
});

test("a refused unbind keeps the provisional path (A8)", async () => {
  const { fake, port } = setup();
  try {
    fake.onNew(
      "laptop-a",
      () => ({ prompt_delivered: false }) as Partial<import("@pohunek/sdk").SessionNewResult>,
    );
    fake.failNext("laptop-a", "session.stop", { errCode: "bad_request", apply: false });
    const error = await port.start(request()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PohunekAdapterError);
    expect((error as PohunekAdapterError).code).toBe("void-incomplete");
    expect(fake.sessions("laptop-a")).toHaveLength(1);
    expect(fake.sessions("laptop-a")[0]?.metadata?.[MOC_METADATA.requestId]).toBe("req-1");
  } finally {
    await teardown(fake, port);
  }
});

test("a refused session.new leaves no binding (A9)", async () => {
  const { fake, port } = setup();
  try {
    fake.failNext("laptop-a", "session.new", { errCode: "bad_request", apply: true });
    const error = await port.start(request()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PortRejectedError);
    expect((error as PortRejectedError).code).toBe("bad-request");
    const bound = fake.sessions("laptop-a");
    expect(bound).toHaveLength(1);
    expect(bound[0]?.metadata?.[MOC_METADATA.start]).toBe("void");
    expect(bound[0]?.metadata?.[MOC_METADATA.requestId]).toBeUndefined();
  } finally {
    await teardown(fake, port);
  }
});

test("branch-diverged from session.new has no cleanup (A9, P2)", async () => {
  const { fake, port } = setup();
  try {
    fake.failNext("laptop-a", "session.new", { errCode: "branch_diverged", apply: true });
    const error = await port.start(request()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PortRejectedError);
    expect((error as PortRejectedError).code).toBe("branch-diverged");
    expect(fake.sessions("laptop-a")).toHaveLength(1);
    expect(fake.sessions("laptop-a")[0]?.metadata?.[MOC_METADATA.start]).toBe("pending");
  } finally {
    await teardown(fake, port);
  }
});

test("each S5 failure leaves the session stopped and unbound, and a replay creates a new session", async () => {
  const overrides: ReadonlyArray<{
    readonly name: string;
    readonly reply: (params: SessionNewParams) => Partial<import("@pohunek/sdk").SessionNewResult>;
    readonly code: string;
  }> = [
    {
      name: "branch-mismatch",
      reply: () => ({ branch: "moc/other" }) as Partial<import("@pohunek/sdk").SessionNewResult>,
      code: "branch-mismatch",
    },
    {
      name: "no-worktree",
      reply: () => ({ worktree_path: "" }) as Partial<import("@pohunek/sdk").SessionNewResult>,
      code: "no-worktree",
    },
    {
      name: "prompt-not-acknowledged",
      reply: () => ({ applied_input: false }) as Partial<import("@pohunek/sdk").SessionNewResult>,
      code: "prompt-not-acknowledged",
    },
    {
      name: "base-branch-fallback",
      reply: (params) =>
        ({
          ...(params.branch_source === "remote"
            ? { worktree_source: { ref: `origin/${String(params.branch)}`, commit: "abc" } }
            : {}),
          warnings: [{ kind: "base_branch_fallback", message: "fell back", detail: "" }],
        }) as Partial<import("@pohunek/sdk").SessionNewResult>,
      code: "base-branch-fallback",
    },
    {
      name: "fetch-failed",
      reply: () =>
        ({
          warnings: [{ kind: "fetch", message: "fetch failed", detail: "" }],
        }) as Partial<import("@pohunek/sdk").SessionNewResult>,
      code: "fetch-failed",
    },
    {
      name: "start-unconfirmed replay",
      reply: () => ({}) as Partial<import("@pohunek/sdk").SessionNewResult>,
      code: "start-unconfirmed",
    },
  ];
  for (const { name, reply, code } of overrides) {
    const { fake, log, port } = setup();
    try {
      if (name === "start-unconfirmed replay") {
        continue;
      }
      fake.onNew("laptop-a", reply);
      const error = await port
        .start(request({ resume: name === "fetch-failed" ? false : request().resume }))
        .catch((cause: unknown) => cause);
      expect(error, name).toBeInstanceOf(PortRejectedError);
      expect((error as PortRejectedError).code, name).toBe(code);
      const sessions = fake.sessions("laptop-a");
      expect(sessions, name).toHaveLength(1);
      expect(sessions[0]?.state, name).toBe("stopped");
      expect(sessions[0]?.metadata?.[MOC_METADATA.start], name).toBe("void");
      expect(sessions[0]?.metadata?.[MOC_METADATA.requestId], name).toBeUndefined();
      expect(eventsOf(log), name).toContain("adapter-start-void");
      fake.onNew("laptop-a", () => ({}));
      const handle: SessionHandle = await port.start(request());
      expect(handle.sessionId, name).toBe("fake-2");
    } finally {
      await teardown(fake, port);
    }
  }
});

test("resume-only S5 failures void and a replay creates a new session", async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly reply: (params: SessionNewParams) => Partial<import("@pohunek/sdk").SessionNewResult>;
    readonly code: string;
  }> = [
    {
      name: "branch-source-ignored",
      reply: () =>
        ({ worktree_source: undefined }) as Partial<import("@pohunek/sdk").SessionNewResult>,
      code: "branch-source-ignored",
    },
    {
      name: "branch-ahead-of-remote",
      reply: (params) =>
        ({
          worktree_source: { ref: `origin/${String(params.branch)}`, commit: "abc" },
          warnings: [{ kind: "branch_ahead_of_remote", message: "ahead", detail: "" }],
        }) as Partial<import("@pohunek/sdk").SessionNewResult>,
      code: "branch-ahead-of-remote",
    },
  ];
  for (const { name, reply, code } of cases) {
    const { fake, port } = setup();
    try {
      fake.onNew("laptop-a", reply);
      const error = await port.start(request({ resume: true })).catch((cause: unknown) => cause);
      expect(error, name).toBeInstanceOf(PortRejectedError);
      expect((error as PortRejectedError).code, name).toBe(code);
      expect(fake.sessions("laptop-a")[0]?.state, name).toBe("stopped");
      fake.onNew("laptop-a", () => ({}));
      const handle: SessionHandle = await port.start(request({ resume: true }));
      expect(handle.sessionId, name).toBe("fake-2");
    } finally {
      await teardown(fake, port);
    }
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

test("a marked live session is stopped and finished (WC2)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.setSession("laptop-a", handle.sessionId, {
      metadata: {
        [MOC_METADATA.outcome]: "finished",
        [MOC_METADATA.outcomeDetail]: "turn completed",
      },
    });
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId, "cursor-2"));
    const second = await port.wait(ref, 1000, "cursor-1");
    expect(second).toMatchObject({ state: "finished", detail: "turn completed" });
    expect(fake.sessions("laptop-a")[0]?.state).toBe("running");
  } finally {
    await teardown(fake, port);
  }
});

test("a restart after stop keeps finished (WC3)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId));
    await port.wait({ sessionId: handle.sessionId, hostAlias: "laptop-a" }, 1000, null);
    const secondLog: AdapterLogEvent[] = [];
    const second = createPohunekPort(CONFIG, {
      connector: fake.connector,
      log: (event) => {
        secondLog.push(event);
      },
    });
    try {
      fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId, "cursor-2"));
      const result = await second.wait(
        { sessionId: handle.sessionId, hostAlias: "laptop-a" },
        1000,
        "cursor-1",
      );
      expect(result).toMatchObject({ state: "finished", detail: "turn completed" });
      void secondLog;
    } finally {
      await second.close();
    }
  } finally {
    await teardown(fake, port);
  }
});

test("LOST-2 on wait_turn gives lost session missing", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.failNext("laptop-a", "session.wait_turn", { errCode: "session_not_found", apply: false });
    const result = await port.wait(ref, 1000, null);
    expect(result).toEqual({
      state: "lost",
      sessionId: handle.sessionId,
      cursor: "",
      usage: null,
      detail: "session missing",
    });
  } finally {
    await teardown(fake, port);
  }
});

test("LOST-2 on inspect gives lost session missing", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.failNext("laptop-a", "session.inspect", { errCode: "session_not_found", apply: false });
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId));
    const result = await port.wait(ref, 1000, null);
    expect(result).toMatchObject({ state: "lost", detail: "session missing" });
  } finally {
    await teardown(fake, port);
  }
});

test("LOST-3 on a lost runtime gives lost runtime lost", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.setSession("laptop-a", handle.sessionId, {
      runtime: { state: "lost", runtime_generation: "1" },
    });
    fake.queueWaitTurn("laptop-a", {
      reason: "timeout",
      cursor: "cursor-1",
      progress: [{ session_id: handle.sessionId, state: "running", output_advanced: false }],
    });
    const result = await port.wait(ref, 1000, null);
    expect(result).toMatchObject({ state: "lost", detail: "runtime lost" });
    expect(fake.sessions("laptop-a")[0]?.metadata?.[MOC_METADATA.outcome]).toBe("lost");
  } finally {
    await teardown(fake, port);
  }
});

test("after a terminal, changing the fake state does not change the result (P3)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId));
    const first = await port.wait(ref, 1000, null);
    fake.setSession("laptop-a", handle.sessionId, { state: "failed" });
    const second = await port.wait(ref, 1000, "cursor-1");
    expect(second).toEqual(first);
  } finally {
    await teardown(fake, port);
  }
});

test("wait rejects a bad timeout with RangeError (W0)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    await expect(port.wait(ref, 0, null)).rejects.toBeInstanceOf(RangeError);
  } finally {
    await teardown(fake, port);
  }
});

test("wait rejects a progress mismatch (W2)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    fake.queueWaitTurn("laptop-a", {
      reason: "event",
      event: { session_id: "fake-9", kind: "turn_completed", at: "2026-10-27T00:00:00Z" },
      cursor: "cursor-1",
      progress: [{ session_id: handle.sessionId, state: "running", output_advanced: true }],
    });
    await expect(
      port.wait({ sessionId: handle.sessionId, hostAlias: "laptop-a" }, 1000, null),
    ).rejects.toMatchObject({ code: "progress-mismatch" });
  } finally {
    await teardown(fake, port);
  }
});

test("cancel on a live session returns cancelled session stopped", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    const result = await port.cancel(ref, "operator");
    expect(result).toMatchObject({
      state: "cancelled",
      sessionId: handle.sessionId,
      detail: "session stopped",
    });
  } finally {
    await teardown(fake, port);
  }
});

test("cancel on a finished session returns finished (P4)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.setSession("laptop-a", handle.sessionId, { state: "done", exit_code: 0 });
    const result = await port.cancel(ref, "operator");
    expect(result).toMatchObject({ state: "finished", detail: "exited 0" });
  } finally {
    await teardown(fake, port);
  }
});

test("cancel with stop outcome unknown gives PortUnreachableError", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    fake.failNext("laptop-a", "session.stop", {
      error: fakeErrors.stopOutcomeUnknown("laptop-a"),
      apply: false,
    });
    await expect(
      port.cancel({ sessionId: handle.sessionId, hostAlias: "laptop-a" }, "stall"),
    ).rejects.toBeInstanceOf(PortUnreachableError);
  } finally {
    await teardown(fake, port);
  }
});

test("cancel on a missing session gives lost session missing (X1)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.failNext("laptop-a", "session.stop", { errCode: "session_not_found", apply: false });
    const result = await port.cancel(ref, "stall");
    expect(result).toMatchObject({ state: "lost", detail: "session missing" });
  } finally {
    await teardown(fake, port);
  }
});

test("a racing wait and cancel return one terminal (J1)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId));
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId, "cursor-2"));
    const waiting = port.wait(ref, 1000, null);
    const cancelling = port.cancel(ref, "operator");
    const [waited, cancelled] = await Promise.all([waiting, cancelling]);
    expect(waited).toEqual(cancelled);
    expect(waited).toMatchObject({ sessionId: handle.sessionId });
    expect(["cancelled", "finished"]).toContain(waited.state);
    const stops = fake.calls("laptop-a").filter((call) => call.method === "session.stop");
    expect(stops.length).toBeGreaterThanOrEqual(1);
  } finally {
    await teardown(fake, port);
  }
});

test("two waits on one turn agree (J2)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId));
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId, "cursor-2"));
    const [first, second] = await Promise.all([
      port.wait(ref, 1000, null),
      port.wait(ref, 1000, null),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ state: "finished", detail: "turn completed" });
    const stops = fake.calls("laptop-a").filter((call) => call.method === "session.stop");
    expect(stops.length).toBeLessThanOrEqual(2);
    expect(fake.sessions("laptop-a")[0]?.metadata?.[MOC_METADATA.outcome]).toBe("finished");
  } finally {
    await teardown(fake, port);
  }
});

test("two cancels agree (J3)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    const [first, second] = await Promise.all([
      port.cancel(ref, "operator"),
      port.cancel(ref, "operator"),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ state: "cancelled", detail: "session stopped" });
  } finally {
    await teardown(fake, port);
  }
});

test("cancel after a terminal wait calls nothing (J4, P4)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.queueWaitTurn("laptop-a", finishedTurn(handle.sessionId));
    const waited = await port.wait(ref, 1000, null);
    const stopsBefore = fake
      .calls("laptop-a")
      .filter((call) => call.method === "session.stop").length;
    const cancelled = await port.cancel(ref, "operator");
    expect(cancelled).toEqual(waited);
    const stopsAfter = fake
      .calls("laptop-a")
      .filter((call) => call.method === "session.stop").length;
    expect(stopsAfter).toBe(stopsBefore);
  } finally {
    await teardown(fake, port);
  }
});

test("a hostUnreachable route gives alias plus code and drops the connection", async () => {
  const { fake, port } = setup();
  let dropped = 0;
  const dropping = {
    ...fake.connector,
    drop: async (alias: string): Promise<void> => {
      dropped += 1;
      await fake.connector.drop(alias);
    },
  };
  const droppingLog: AdapterLogEvent[] = [];
  const droppingPort = createPohunekPort(CONFIG, {
    connector: dropping,
    log: (event) => {
      droppingLog.push(event);
    },
  });
  try {
    fake.setUnreachable("laptop-a", true);
    const error = await droppingPort.start(request()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PortUnreachableError);
    expect((error as PortUnreachableError).message).toBe("laptop-a: host_unreachable");
    expect((error as Error).message).not.toContain("peer.example-route");
    expect(dropped).toBe(1);
    expect(droppingLog.map((entry) => entry.event)).toContain("adapter-connection-dropped");
  } finally {
    await droppingPort.close();
    await teardown(fake, port);
  }
});

test("diff maps the daemon reply (3.8)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    fake.setDiff("laptop-a", handle.sessionId, {
      diff: "diff --git a\n",
      base: "origin/main",
      truncated: true,
    });
    const result = await port.diff(
      { sessionId: handle.sessionId, hostAlias: "laptop-a" },
      "origin/main",
    );
    expect(result).toEqual({
      sessionId: handle.sessionId,
      base: "origin/main",
      unifiedDiff: "diff --git a\n",
      truncated: true,
    });
  } finally {
    await teardown(fake, port);
  }
});

test("diff on a missing session gives session-not-found (3.8)", async () => {
  const { fake, port } = setup();
  try {
    const handle = await port.start(request());
    const ref = { sessionId: handle.sessionId, hostAlias: "laptop-a" };
    fake.failNext("laptop-a", "session.diff", { errCode: "session_not_found", apply: false });
    await expect(port.diff(ref, "origin/main")).rejects.toMatchObject({
      code: "session-not-found",
    });
  } finally {
    await teardown(fake, port);
  }
});

test("after close, start throws closed and a second close returns at once", async () => {
  const { fake, port } = setup();
  try {
    await port.close();
    await port.close();
    const error = await port.start(request()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PohunekAdapterError);
    expect((error as PohunekAdapterError).code).toBe("closed");
    await expect(
      port.wait({ sessionId: "fake-1", hostAlias: "laptop-a" }, 1000, null),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      port.diff({ sessionId: "fake-1", hostAlias: "laptop-a" }, "origin/main"),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      port.cancel({ sessionId: "fake-1", hostAlias: "laptop-a" }, "operator"),
    ).rejects.toMatchObject({ code: "closed" });
  } finally {
    await fake.connector.close();
  }
});

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

function finishedTurn(id: string): SessionWaitTurnResult {
  return {
    reason: "event",
    event: {
      session_id: id,
      kind: "turn_completed",
      at: "2026-10-27T00:00:00Z",
    },
    cursor: "cursor-1",
    progress: [{ session_id: id, state: "running", output_advanced: true }],
  };
}

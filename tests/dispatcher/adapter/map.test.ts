// Map tests (design section 6.2): one row per S3 lookup case, S5
// acceptance predicate, wait table row and error-mapping group. Fixtures
// are SDK-shaped literals typed through the adapter signatures, so this
// file never names the SDK package.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createFakeDaemon, fakeErrors } from "../../../src/dispatcher/adapter/fake-daemon.js";
import type { FakeDaemon } from "../../../src/dispatcher/adapter/fake-daemon.js";
import {
  MOC_METADATA,
  acceptanceFailure,
  hostPreflightFailure,
  isSessionNotFound,
  kebabCode,
  lookupDecision,
  portErrorOf,
  requestDigestOf,
  sessionNewParams,
  waitDecision,
} from "../../../src/dispatcher/adapter/map.js";
import {
  PortRejectedError,
  PortUnreachableError,
  type StartRequest,
} from "../../../src/dispatcher/port.js";

type WaitArg = Parameters<typeof waitDecision>[1];
type InfoArg = Parameters<typeof waitDecision>[2];
type InspectInfo = Extract<InfoArg, { state: string }>;
type LocalClient = Awaited<ReturnType<FakeDaemon["connector"]["client"]>>;

interface MiniChannel {
  send(line: string): Promise<void>;
  readonly lines: AsyncIterable<string>;
  close(): Promise<void>;
}

// A minimal Transport-shaped stub answering the version probe and one err
// reply. Structured like the SDK seam, defined locally so the test file
// imports only from the adapter.
function localErrTransport(code: string): {
  control(): Promise<MiniChannel>;
  raw(): Promise<never>;
} {
  const queue: string[] = [];
  const wakeups: (() => void)[] = [];
  const push = (line: string): void => {
    queue.push(line);
    for (const wake of wakeups.splice(0)) {
      wake();
    }
  };
  const channel: MiniChannel = {
    async send(line: string): Promise<void> {
      const request = JSON.parse(line) as { id: string; method: string };
      if (request.method === "daemon.health") {
        push(
          JSON.stringify({
            v: 4,
            id: request.id,
            ok: { status: "ok", daemon_version: "test", protocol_version: 4 },
          }),
        );
      } else {
        push(
          JSON.stringify({
            v: 4,
            id: request.id,
            err: { class: "daemon", code, msg: `test refused: ${code}` },
          }),
        );
      }
    },
    get lines(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<string> {
          return {
            async next(): Promise<IteratorResult<string>> {
              for (;;) {
                const next = queue.shift();
                if (next !== undefined) {
                  return { value: next, done: false };
                }
                await new Promise<void>((resolve) => {
                  wakeups.push(resolve);
                });
              }
            },
          };
        },
      };
    },
    async close(): Promise<void> {},
  };
  return {
    control(): Promise<MiniChannel> {
      return Promise.resolve(channel);
    },
    raw(): Promise<never> {
      throw new Error("no raw transport");
    },
  };
}

const CONFIG = {
  agentProfile: "moc-worker",
  project: "means-of-compute",
  cols: 200,
  rows: 50,
  inputAckTimeoutMs: 8000,
  connectTimeoutMs: 5000,
  cancelWaitTimeoutMs: 30000,
  hostRoutesFileEnv: "MOC_HOST_ROUTES_FILE",
} as const;

function request(overrides: Partial<StartRequest> = {}): StartRequest {
  return {
    requestId: "item-7:0",
    workItemId: "item-7",
    repo: "example/demo",
    hostAlias: "laptop-a",
    branch: "moc/item-7",
    baseRef: "origin/main",
    resume: false,
    model: { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" },
    brief: "Do item seven.",
    ...overrides,
  };
}

const DIGEST_FIELDS = [
  "requestId",
  "workItemId",
  "repo",
  "hostAlias",
  "branch",
  "baseRef",
  "resume",
  "provider",
  "model",
  "brief",
] as const;

function alterField(req: StartRequest, field: (typeof DIGEST_FIELDS)[number]): StartRequest {
  switch (field) {
    case "requestId":
      return { ...req, requestId: `${req.requestId}-x` };
    case "workItemId":
      return { ...req, workItemId: `${req.workItemId}-x` };
    case "repo":
      return { ...req, repo: `${req.repo}-x` };
    case "hostAlias":
      return { ...req, hostAlias: "laptop-b" };
    case "branch":
      return { ...req, branch: `${req.branch}-x` };
    case "baseRef":
      return { ...req, baseRef: "origin/other" };
    case "resume":
      return { ...req, resume: !req.resume };
    case "provider":
      return { ...req, model: { ...req.model, providerId: "other-provider" } };
    case "model":
      return { ...req, model: { ...req.model, model: "other/model" } };
    case "brief":
      return { ...req, brief: `${req.brief} More.` };
  }
}

test("equal requests give equal digests", () => {
  expect(requestDigestOf(request())).toBe(requestDigestOf(request()));
});

for (const field of DIGEST_FIELDS) {
  test(`digest changes when ${field} changes`, () => {
    expect(requestDigestOf(alterField(request(), field))).not.toBe(requestDigestOf(request()));
  });
}

test("digest covers the brief content, not its object identity", () => {
  const brief = `Do item seven.${" ".repeat(0)}`;
  expect(requestDigestOf(request({ brief }))).toBe(requestDigestOf(request()));
});

test("the preimage digest matches an independent sha256 computation", () => {
  const req = request();
  const briefHash = createHash("sha256").update(req.brief, "utf8").digest("hex");
  const expected = createHash("sha256")
    .update(
      JSON.stringify([
        "moc-request-v1",
        req.requestId,
        req.workItemId,
        req.repo,
        req.hostAlias,
        req.branch,
        req.baseRef,
        req.resume,
        req.model.providerId,
        req.model.model,
        briefHash,
      ]),
      "utf8",
    )
    .digest("hex");
  expect(requestDigestOf(req)).toBe(expected);
});

test("resume params send branch_source remote without base_branch", () => {
  const params = sessionNewParams(request({ resume: true }), CONFIG, "digest-1");
  expect(params.branch_source).toBe("remote");
  expect(params).not.toHaveProperty("base_branch");
  expect(params).not.toHaveProperty("on_diverged");
});

test("new params send the base branch without the origin prefix", () => {
  const params = sessionNewParams(request(), CONFIG, "digest-1");
  expect(params.base_branch).toBe("main");
  expect(params).not.toHaveProperty("branch_source");
});

test("input is the only params field holding the brief", () => {
  const params = sessionNewParams(request({ brief: "uniquely worded brief text" }), CONFIG, "d");
  expect(params.input).toContain("uniquely worded brief text");
  const rest = JSON.stringify({ ...params, input: undefined });
  expect(rest).not.toContain("uniquely worded brief text");
});

test("new-session metadata holds exactly the three binding keys", () => {
  const params = sessionNewParams(request(), CONFIG, "digest-9");
  expect(params.metadata).toEqual({
    [MOC_METADATA.requestId]: "item-7:0",
    [MOC_METADATA.requestDigest]: "digest-9",
    [MOC_METADATA.start]: "pending",
  });
});

function capabilities(
  overrides: Record<string, unknown> = {},
): Parameters<typeof hostPreflightFailure>[0] {
  return {
    daemon_version: "0.37.0",
    protocol_version: 4,
    supported_agents: ["moc-worker"],
    runtimes: [{ agent: "moc-worker", available: true }],
    git_available: true,
    worktree_supported: true,
    terminal_read_supported: true,
    output_read_supported: true,
    session_wait_supported: true,
    session_wait_turn_supported: true,
    session_new_branch_source_supported: true,
    session_new_input_ack_supported: true,
    ...overrides,
  } as Parameters<typeof hostPreflightFailure>[0];
}

test("healthy capabilities pass the preflight", () => {
  expect(hostPreflightFailure(capabilities(), CONFIG)).toBeNull();
});

const PREFLIGHT_CASES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["worktree_supported", { worktree_supported: false }],
  ["git_available", { git_available: false }],
  ["session_wait_turn_supported", { session_wait_turn_supported: false }],
  ["session_new_branch_source_supported", { session_new_branch_source_supported: false }],
  ["session_new_input_ack_supported", { session_new_input_ack_supported: false }],
  ["supported_agents", { supported_agents: ["other-agent"] }],
  ["agent_runtime", { runtimes: [{ agent: "moc-worker", available: false }] }],
];

for (const [name, patch] of PREFLIGHT_CASES) {
  test(`preflight names ${name} when it alone fails`, () => {
    expect(hostPreflightFailure(capabilities(patch), CONFIG)).toBe(
      name as ReturnType<typeof hostPreflightFailure>,
    );
  });
}

function session(
  overrides: Record<string, unknown> = {},
): Parameters<typeof lookupDecision>[0][number] {
  return {
    id: "fake-1",
    capabilities: { resume: true, fork: true },
    agent: "moc-worker",
    agent_base: "builtin",
    cwd: "/tmp/work",
    pid: 1,
    cols: 200,
    rows: 50,
    state: "running",
    state_source: "process",
    created_at: "2026-10-27T00:00:00Z",
    updated_at: "2026-10-27T00:00:00Z",
    metadata: {
      [MOC_METADATA.requestDigest]: "digest-1",
      [MOC_METADATA.start]: "accepted",
    },
    ...overrides,
  } as Parameters<typeof lookupDecision>[0][number];
}

test("lookup with no binding creates", () => {
  expect(lookupDecision([], "digest-1")).toEqual({ kind: "create" });
});

test("lookup with an accepted binding returns it", () => {
  const found = session();
  expect(lookupDecision([found], "digest-1")).toEqual({ kind: "return", session: found });
});

test("lookup with a pending binding voids it", () => {
  const found = session({
    metadata: { [MOC_METADATA.requestDigest]: "digest-1", [MOC_METADATA.start]: "pending" },
  });
  expect(lookupDecision([found], "digest-1")).toEqual({ kind: "void", session: found });
});

test("lookup with a digest mismatch rejects with request-conflict", () => {
  expect(lookupDecision([session()], "other-digest")).toEqual({
    kind: "reject",
    code: "request-conflict",
  });
});

test("lookup with two bindings rejects with request-duplicated", () => {
  expect(lookupDecision([session(), session({ id: "fake-2" })], "digest-1")).toEqual({
    kind: "reject",
    code: "request-duplicated",
  });
});

function newResult(
  overrides: Record<string, unknown> = {},
): Parameters<typeof acceptanceFailure>[1] {
  return {
    id: "fake-1",
    capabilities: { resume: true, fork: true },
    agent: "moc-worker",
    agent_base: "builtin",
    cwd: "/tmp/work",
    pid: 1,
    cols: 200,
    rows: 50,
    state: "running",
    state_source: "process",
    created_at: "2026-10-27T00:00:00Z",
    updated_at: "2026-10-27T00:00:00Z",
    branch: "moc/item-7",
    worktree_path: "/fake/laptop-a/1",
    applied_input: true,
    prompt_delivered: true,
    warnings: [],
    ...overrides,
  } as Parameters<typeof acceptanceFailure>[1];
}

test("acceptance passes on the happy path", () => {
  expect(acceptanceFailure(request(), newResult())).toBeNull();
});

const ACCEPTANCE_CASES: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
  ["branch", { branch: "moc/other" }, "branch-mismatch"],
  ["worktree", { worktree_path: "" }, "no-worktree"],
  ["ack", { prompt_delivered: false }, "prompt-not-acknowledged"],
  ["ack applied", { applied_input: false }, "prompt-not-acknowledged"],
  [
    "base fallback",
    { warnings: [{ kind: "base_branch_fallback", message: "fell back" }] },
    "base-branch-fallback",
  ],
  ["fetch", { warnings: [{ kind: "fetch", message: "fetch failed" }] }, "fetch-failed"],
];

for (const [name, patch, code] of ACCEPTANCE_CASES) {
  test(`acceptance rejects a ${name} problem with ${code}`, () => {
    expect(acceptanceFailure(request(), newResult(patch))).toBe(code);
  });
}

test("acceptance applies resume-only checks in order", () => {
  const req = request({ resume: true });
  expect(acceptanceFailure(req, newResult({ worktree_source: undefined }))).toBe(
    "branch-source-ignored",
  );
  expect(
    acceptanceFailure(
      req,
      newResult({
        worktree_source: { ref: "origin/moc/item-7", commit: "" },
      }),
    ),
  ).toBe("branch-source-ignored");
  expect(
    acceptanceFailure(
      req,
      newResult({
        worktree_source: { ref: "refs/heads/other", commit: "abc" },
      }),
    ),
  ).toBe("branch-ahead-of-remote");
  expect(
    acceptanceFailure(
      req,
      newResult({
        worktree_source: { ref: "origin/moc/item-7", commit: "abc" },
        warnings: [{ kind: "branch_ahead_of_remote", message: "ahead" }],
      }),
    ),
  ).toBe("branch-ahead-of-remote");
  expect(
    acceptanceFailure(
      req,
      newResult({ worktree_source: { ref: "origin/moc/item-7", commit: "abc" } }),
    ),
  ).toBeNull();
});

test("acceptance ignores resume-only checks for a fresh start", () => {
  expect(acceptanceFailure(request(), newResult({ worktree_source: undefined }))).toBeNull();
});

function waitReply(overrides: Record<string, unknown> = {}): WaitArg {
  return {
    reason: "timeout",
    cursor: "cursor-1",
    progress: [],
    ...overrides,
  } as WaitArg;
}

function runningInfo(overrides: Record<string, unknown> = {}): InfoArg {
  return {
    ...session({ state: "running", metadata: {} }),
    ...overrides,
  } as unknown as InfoArg;
}

test("R1 keeps a marked outcome and stops a live session", () => {
  const info = runningInfo({
    metadata: {
      [MOC_METADATA.outcome]: "finished",
      [MOC_METADATA.outcomeDetail]: "turn completed",
    },
  });
  expect(waitDecision("fake-1", waitReply(), info)).toEqual({
    kind: "terminal",
    state: "finished",
    detail: "turn completed",
    mark: false,
    stop: true,
  });
});

test("R1 ignores an unknown detail", () => {
  const info = runningInfo({
    metadata: { [MOC_METADATA.outcome]: "finished", [MOC_METADATA.outcomeDetail]: "mystery" },
  });
  const decision = waitDecision("fake-1", waitReply({ progress: [] }), info);
  expect(decision).toEqual({ kind: "running", state: "running" });
});

test("R2 maps done with exit 0 to finished", () => {
  const info = runningInfo({ state: "done", exit_code: 0 });
  expect(waitDecision("fake-1", waitReply(), info)).toEqual({
    kind: "terminal",
    state: "finished",
    detail: "exited 0",
    mark: false,
    stop: false,
  });
});

test("R3 maps a nonzero exit to failed with the code", () => {
  const info = runningInfo({ state: "done", exit_code: 3 });
  expect(waitDecision("fake-1", waitReply(), info)).toEqual({
    kind: "terminal",
    state: "failed",
    detail: "exited 3",
    mark: false,
    stop: false,
  });
});

test("R3 maps a missing exit code to failed without a code", () => {
  const info = runningInfo({ state: "done" });
  expect(waitDecision("fake-1", waitReply(), info)).toEqual({
    kind: "terminal",
    state: "failed",
    detail: "exited none",
    mark: false,
    stop: false,
  });
});

test("R4 maps a failed session", () => {
  expect(
    waitDecision("fake-1", waitReply(), runningInfo({ state: "failed" }) as InspectInfo),
  ).toEqual({
    kind: "terminal",
    state: "failed",
    detail: "session failed",
    mark: false,
    stop: false,
  });
});

test("R5 maps a stopped session", () => {
  expect(
    waitDecision("fake-1", waitReply(), runningInfo({ state: "stopped" }) as InspectInfo),
  ).toEqual({
    kind: "terminal",
    state: "cancelled",
    detail: "session stopped",
    mark: false,
    stop: false,
  });
});

function turnEvent(kind: string): WaitArg {
  return waitReply({
    reason: "event",
    event: { session_id: "fake-1", kind, at: "2026-10-27T00:00:00Z" },
    progress: [{ session_id: "fake-1", state: "running", output_advanced: true }],
  });
}

test("R6 wins over a lost runtime on a completed turn", () => {
  const info = runningInfo({ runtime: { state: "lost", runtime_generation: "1" } });
  expect(waitDecision("fake-1", turnEvent("turn_completed"), info)).toEqual({
    kind: "terminal",
    state: "finished",
    detail: "turn completed",
    mark: true,
    stop: true,
  });
});

test("R7 maps blocked and approval events to failed", () => {
  for (const kind of ["agent_blocked", "approval_required"] as const) {
    expect(waitDecision("fake-1", turnEvent(kind), runningInfo())).toEqual({
      kind: "terminal",
      state: "failed",
      detail: kind,
      mark: true,
      stop: true,
    });
  }
});

test("R8 maps a lost runtime without a turn event", () => {
  for (const state of ["lost", "conflict", "incompatible"] as const) {
    const info = runningInfo({ runtime: { state, runtime_generation: "1" } });
    expect(waitDecision("fake-1", waitReply(), info)).toEqual({
      kind: "terminal",
      state: "lost",
      detail: `runtime ${state}`,
      mark: true,
      stop: true,
    });
  }
});

test("R9 maps an idle turn event to finished", () => {
  const reply = waitReply({
    progress: [
      {
        session_id: "fake-1",
        state: "running",
        activity: "idle",
        turn_started_at: "2026-10-27T00:00:00Z",
        output_advanced: true,
      },
    ],
  });
  expect(waitDecision("fake-1", reply, runningInfo())).toEqual({
    kind: "terminal",
    state: "finished",
    detail: "idle after turn",
    mark: true,
    stop: true,
  });
});

test("R9 without turn_started_at stays non-terminal", () => {
  const reply = waitReply({
    progress: [{ session_id: "fake-1", state: "running", activity: "idle", output_advanced: true }],
  });
  expect(waitDecision("fake-1", reply, runningInfo())).toEqual({
    kind: "running",
    state: "running",
  });
});

test("R10 maps a blocked wait to failed", () => {
  const reply = waitReply({
    progress: [
      { session_id: "fake-1", state: "running", activity: "blocked", output_advanced: false },
    ],
  });
  expect(waitDecision("fake-1", reply, runningInfo())).toEqual({
    kind: "terminal",
    state: "failed",
    detail: "agent blocked",
    mark: true,
    stop: true,
  });
});

test("R11 keeps a plain timeout non-terminal with the cursor", () => {
  expect(waitDecision("fake-1", waitReply(), runningInfo())).toEqual({
    kind: "running",
    state: "running",
  });
});

test("R11 maps an exited event on a live session to running", () => {
  expect(waitDecision("fake-1", turnEvent("exited"), runningInfo())).toEqual({
    kind: "running",
    state: "running",
  });
});

test("R11 maps cursor_reset to running", () => {
  expect(waitDecision("fake-1", waitReply({ reason: "cursor_reset" }), runningInfo())).toEqual({
    kind: "running",
    state: "running",
  });
});

test("R11 reports the starting state while the session starts", () => {
  expect(waitDecision("fake-1", waitReply(), runningInfo({ state: "starting" }))).toEqual({
    kind: "running",
    state: "starting",
  });
});

// Error mapping runs against real ClientError instances built by the
// fake daemon's factories, which are the SDK's public static factories.
// The err-reply rows decode through a real Client over the fake Transport
// seam; that client answers on the "remote" host, so the kind is
// remoteProtocol with the daemon code intact.

test("kebab maps daemon codes and guards unknown text", () => {
  expect(kebabCode("branch_diverged")).toBe("branch-diverged");
  expect(kebabCode("session_not_found")).toBe("session-not-found");
  expect(kebabCode("Weird Code")).toBe("daemon-error");
});

test("a non-client error maps to null", () => {
  expect(portErrorOf(new Error("boom"), "laptop-a")).toBeNull();
});

test("unreachable kinds map to PortUnreachableError with alias and code", () => {
  const unreachable = [
    fakeErrors.hostUnreachable("peer-x"),
    fakeErrors.requestTimeout("laptop-a"),
    fakeErrors.stopOutcomeUnknown("laptop-a"),
  ];
  for (const error of unreachable) {
    const mapped = portErrorOf(error, "laptop-a");
    expect(mapped).toBeInstanceOf(PortUnreachableError);
  }
  const host = portErrorOf(fakeErrors.hostUnreachable("peer-x"), "laptop-a");
  expect(host?.message).toContain("laptop-a");
  expect(host?.message).not.toContain("peer-x");
});

test("a rejected err reply decodes as remoteProtocol and maps its code", async () => {
  const fake = createFakeDaemon(["laptop-a"], "moc-worker");
  try {
    const client = await fake.connector.client("laptop-a");
    fake.failNext("laptop-a", "session.inspect", { errCode: "branch_diverged", apply: false });
    let caught: unknown;
    try {
      await client.call("session.inspect", "fake-9");
    } catch (error) {
      caught = error;
    }
    const mapped = portErrorOf(caught, "laptop-a");
    expect(mapped).toBeInstanceOf(PortRejectedError);
    expect((mapped as PortRejectedError).code).toBe("branch-diverged");
  } finally {
    await fake.connector.close();
  }
});

test("a local err reply decodes as protocol and maps its code", async () => {
  // A local client (no remote host) decodes an err reply with kind
  // protocol. The class comes from the remote client's constructor, so the
  // test file still imports only from the adapter.
  const fake = createFakeDaemon(["laptop-a"], "moc-worker");
  try {
    const remote = await fake.connector.client("laptop-a");
    const ctor = remote.constructor as unknown as {
      connectTransport(transport: unknown, opts?: unknown): Promise<LocalClient>;
    };
    const local = await ctor.connectTransport(localErrTransport("bad_request"));
    let caught: unknown;
    try {
      await local.call("session.inspect", "fake-9");
    } catch (error) {
      caught = error;
    } finally {
      await local.close();
    }
    const mapped = portErrorOf(caught, "laptop-a");
    expect(mapped).toBeInstanceOf(PortRejectedError);
    expect((mapped as PortRejectedError).code).toBe("bad-request");
  } finally {
    await fake.connector.close();
  }
});

test("versionMismatch maps to rejected", () => {
  const mapped = portErrorOf(fakeErrors.versionMismatch(), "laptop-a");
  expect(mapped).toBeInstanceOf(PortRejectedError);
  expect((mapped as PortRejectedError).code).toBe("version-mismatch");
});

test("resumeOutcomeUnknown maps to null", () => {
  expect(portErrorOf(fakeErrors.resumeOutcomeUnknown("laptop-a"), "laptop-a")).toBeNull();
});

test("isSessionNotFound only matches the not-found code", () => {
  expect(isSessionNotFound(new Error("boom"))).toBe(false);
});

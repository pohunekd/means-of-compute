// Memory port tests: P1 idempotent start, P3/P4 sticky terminal state, and
// the D2 diff of a finished session. Deterministic only, no network.
import { expect, test } from "bun:test";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { StartRequest } from "../../src/dispatcher/port.js";
import { PortRejectedError, PortUnreachableError } from "../../src/dispatcher/port.js";

function request(overrides: Partial<StartRequest> = {}): StartRequest {
  return {
    requestId: "demo-item:0",
    workItemId: "demo-item",
    repo: "example/demo",
    hostAlias: "laptop-a",
    branch: "moc/demo-item",
    baseRef: "origin/main",
    resume: false,
    model: { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" },
    brief: "Do the demo item.",
    ...overrides,
  };
}

test("P1: the same request twice gives one session and the same id", async () => {
  const control = createMemoryPort();
  const req = request();
  const first = await control.port.start(req);
  const second = await control.port.start(req);
  expect(second.sessionId).toBe(first.sessionId);
  expect(control.sessions()).toHaveLength(1);
  await control.port.close();
});

test("P1c: a rejected start leaves no binding", async () => {
  const control = createMemoryPort();
  control.pushCommit("main", "m1");
  control.pushCommit("moc/x", "b1");
  // A non-resume start moves the local tip of moc/x to m1, so a resume
  // start then sees a diverged branch and rejects before binding.
  const setup = await control.port.start(
    request({ requestId: "setup:0", workItemId: "setup", branch: "moc/x" }),
  );
  expect(setup.sessionId.length).toBeGreaterThan(0);
  let rejected: unknown;
  try {
    await control.port.start(
      request({ requestId: "x:1", workItemId: "x", branch: "moc/x", resume: true }),
    );
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(PortRejectedError);
  expect((rejected as PortRejectedError).code).toBe("branch-diverged");
  const retry = await control.port.start(request({ requestId: "x:1", workItemId: "x" }));
  expect(retry.requestId).toBe("x:1");
  await control.port.close();
});

test("P7: handles echo the request and carry a worktree", async () => {
  const control = createMemoryPort();
  const plain = request();
  const fresh = await control.port.start(plain);
  expect(fresh.requestId).toBe(plain.requestId);
  expect(fresh.hostAlias).toBe(plain.hostAlias);
  expect(fresh.branch).toBe(plain.branch);
  expect(fresh.sessionId.length).toBeGreaterThan(0);
  expect(fresh.worktree.length).toBeGreaterThan(0);
  const resume = request({ requestId: "demo-item:1", workItemId: "demo-item", resume: true });
  const resumed = await control.port.start(resume);
  expect(resumed.requestId).toBe("demo-item:1");
  expect(resumed.hostAlias).toBe(resume.hostAlias);
  expect(resumed.branch).toBe(resume.branch);
  expect(resumed.worktree.length).toBeGreaterThan(0);
  await control.port.close();
});

test("P1: a changed host with the same requestId gives request-conflict", async () => {
  const control = createMemoryPort();
  await control.port.start(request());
  let error: unknown;
  try {
    await control.port.start(request({ hostAlias: "laptop-b" }));
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(PortRejectedError);
  expect((error as PortRejectedError).code).toBe("request-conflict");
  await control.port.close();
});

test("P3/P4: waits with different cursors and cancel stay deep-equal", async () => {
  const control = createMemoryPort();
  const handle = await control.port.start(request());
  control.complete(handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
  const ref = { sessionId: handle.sessionId, hostAlias: handle.hostAlias };
  const first = await control.port.wait(ref, 1000, null);
  const second = await control.port.wait(ref, 1000, "cursor-7");
  const cancelled = await control.port.cancel(ref, "stall");
  expect(second).toEqual(first);
  expect(cancelled).toEqual(first);
  expect(cancelled.state).toBe("finished");
  await control.port.close();
});

test("mutating the usage after complete leaves the stored result unchanged", async () => {
  const control = createMemoryPort();
  const handle = await control.port.start(request());
  const tokens = [
    {
      provider: "nvidia-build",
      model: "meta/muse-glimmer-30b",
      inputTokens: 10,
      outputTokens: 20,
      requests: 1,
      source: "provider-usage",
    },
  ];
  control.complete(handle.sessionId, { state: "finished", usage: { tokens }, detail: "exited 0" });
  const ref = { sessionId: handle.sessionId, hostAlias: handle.hostAlias };
  const first = await control.port.wait(ref, 1000, null);
  const frozen = structuredClone(first);
  tokens.push({
    provider: "nvidia-build",
    model: "meta/muse-glimmer-30b",
    inputTokens: 30,
    outputTokens: 40,
    requests: 2,
    source: "provider-usage",
  });
  if (first.state === "finished" && first.usage !== null) {
    // Deliberate write through a mutable view: proves the stored result
    // does not alias the objects handed to the caller.
    const headToken = first.usage.tokens[0] as { inputTokens: number | null } | undefined;
    if (headToken !== undefined) {
      headToken.inputTokens = 999;
    }
  }
  const second = await control.port.wait(ref, 1000, null);
  expect(second).toEqual(frozen);
  if (second.state === "finished") {
    expect(second.usage?.tokens).toHaveLength(1);
  }
  await control.port.close();
});

test("terminal result wins over unreachable host in wait and cancel", async () => {
  const control = createMemoryPort();
  const handle = await control.port.start(request());
  control.complete(handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
  control.setUnreachable("laptop-a", true);
  const ref = { sessionId: handle.sessionId, hostAlias: handle.hostAlias };
  const waited = await control.port.wait(ref, 1000, null);
  const cancelled = await control.port.cancel(ref, "stall");
  expect(waited).toEqual(cancelled);
  expect(waited.state).toBe("finished");
  control.setUnreachable("laptop-a", false);
  await control.port.close();
});

test("D2: diff of a finished session returns the pushed changes untruncated", async () => {
  const control = createMemoryPort();
  const handle = await control.port.start(request());
  control.pushCommit("moc/demo-item", "sha1");
  control.pushCommit("moc/demo-item", "sha2");
  control.complete(handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
  const result = await control.port.diff(
    { sessionId: handle.sessionId, hostAlias: handle.hostAlias },
    "origin/main",
  );
  expect(result.sessionId).toBe(handle.sessionId);
  expect(result.base).toBe("origin/main");
  expect(result.truncated).toBe(false);
  expect(result.unifiedDiff).toContain("\n+sha1\n");
  expect(result.unifiedDiff).toContain("\n+sha2\n");
  await control.port.close();
});

test("release with nothing bound returns []", async () => {
  const control = createMemoryPort();
  const other = await control.port.start(
    request({ requestId: "other:0", workItemId: "other", hostAlias: "laptop-b" }),
  );
  const result = await control.port.release({
    requestId: "demo-item:0",
    hostAlias: "laptop-a",
    sessionId: null,
  });
  expect(result).toEqual({ sessionIds: [] });
  expect(control.sessions()).toHaveLength(1);
  expect(control.sessions()[0]?.handle.sessionId).toBe(other.sessionId);
  // A known id on another host is not this host's session.
  const crossHost = await control.port.release({
    requestId: "demo-item:0",
    hostAlias: "laptop-a",
    sessionId: other.sessionId,
  });
  expect(crossHost).toEqual({ sessionIds: [] });
  expect(control.sessions()).toHaveLength(1);
  await control.port.close();
});

test("release stops and unbinds the bound session", async () => {
  const control = createMemoryPort();
  const req = request();
  const handle = await control.port.start(req);
  const result = await control.port.release({
    requestId: req.requestId,
    hostAlias: req.hostAlias,
    sessionId: null,
  });
  expect(result).toEqual({ sessionIds: ["mem-1"] });
  expect(control.sessions().map((entry) => entry.state)).toEqual(["cancelled"]);
  const again = await control.port.start(req);
  expect(again.sessionId).toBe("mem-2");
  expect(handle.sessionId).toBe("mem-1");
  await control.port.close();
});

test("release stops a known session that is no longer bound", async () => {
  const control = createMemoryPort();
  const handle = await control.port.start(request());
  await control.port.release({
    requestId: handle.requestId,
    hostAlias: handle.hostAlias,
    sessionId: null,
  });
  const result = await control.port.release({
    requestId: handle.requestId,
    hostAlias: handle.hostAlias,
    sessionId: "mem-1",
  });
  expect(result).toEqual({ sessionIds: ["mem-1"] });
  // The first release removed the binding, so the request starts fresh.
  const fresh = await control.port.start(request());
  expect(fresh.sessionId).toBe("mem-2");
  await control.port.close();
});

test("refused and unreachable release change nothing", async () => {
  const control = createMemoryPort();
  const req = request();
  await control.port.start(req);
  control.refuseRelease("laptop-a", "void-incomplete");
  let refused: unknown;
  try {
    await control.port.release({
      requestId: req.requestId,
      hostAlias: req.hostAlias,
      sessionId: null,
    });
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(PortRejectedError);
  expect((refused as PortRejectedError).code).toBe("void-incomplete");
  control.refuseRelease("laptop-a", null);
  control.setUnreachable("laptop-a", true);
  let unreachable: unknown;
  try {
    await control.port.release({
      requestId: req.requestId,
      hostAlias: req.hostAlias,
      sessionId: null,
    });
  } catch (error) {
    unreachable = error;
  }
  expect(unreachable).toBeInstanceOf(PortUnreachableError);
  control.setUnreachable("laptop-a", false);
  expect(control.sessions().map((entry) => entry.state)).toEqual(["starting"]);
  const bound = await control.port.start(req);
  expect(bound.sessionId).toBe("mem-1");
  await control.port.close();
});

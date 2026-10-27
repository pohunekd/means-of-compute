// Memory port tests: P1 idempotent start, P3/P4 sticky terminal state, and
// the D2 diff of a finished session. Deterministic only, no network.
import { expect, test } from "bun:test";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { StartRequest } from "../../src/dispatcher/port.js";
import { PortRejectedError } from "../../src/dispatcher/port.js";

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
    first.usage.tokens[0]!.inputTokens = 999;
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

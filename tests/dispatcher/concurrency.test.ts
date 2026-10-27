// Dispatcher concurrency: the item-keyed FIFO lock, the per-pass holds
// and the revision check keep concurrent watches, cancels and starts
// from losing each other's updates. Deterministic: memory port wrapped
// in the switch gate, in-process switch gate, temp ledger and registry.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import { readRegistry } from "../../src/dispatcher/registry.js";
import type { ModelSelection } from "../../src/dispatcher/port.js";
import { readLedger } from "../../src/ledger/read.js";
import { createSwitchGate, gatePort } from "./gated-port.js";
import { PortUnreachableError } from "../../src/dispatcher/port.js";

const MODEL: ModelSelection = { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" };

function dispatcherAt(registryPath: string, ledgerPath: string, ticks: { now: Date }) {
  const control = createMemoryPort();
  const waits = gatePort(control.port, new Set(["wait", "cancel"]));
  const gate = createSwitchGate();
  const config: DispatcherConfig = {
    baseBranch: "main",
    branchPrefix: "moc/",
    waitTimeoutMs: 1000,
    lostAfterUnreachable: 3,
    unreachableBackoffMs: 0,
    registryPath,
  };
  const dispatcher = createDispatcher({
    port: waits.port,
    budget: gate.gate,
    ledgerPath,
    config,
    // The clock advances 1 s per read: two runs that both finish the
    // session stamp different finishedAt values, so only the hold-B
    // terminal re-read keeps the second a replay (I1).
    now: () => {
      const current = ticks.now;
      ticks.now = new Date(current.getTime() + 1000);
      return current;
    },
    sleep: () => Promise.resolve(),
    log: () => undefined,
  });
  return { control, waits, gate, config, dispatcher };
}

function item(id: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo",
    title: `Demo item ${id}`,
    goal: "Exercise dispatcher concurrency",
    issue: 10,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
  };
}

function decision(workItemId: string, hostAlias: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId,
    chosenHostAlias: hostAlias,
    reason: "test decision",
    candidates: [{ hostAlias, score: 1, reason: "only host", excluded: false }],
  };
}

async function withHarness(
  body: (h: {
    readonly ledgerPath: string;
    readonly registryPath: string;
    readonly config: DispatcherConfig;
    readonly control: ReturnType<typeof createMemoryPort>;
    readonly dispatcher: ReturnType<typeof createDispatcher>;
    readonly dir: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-conc-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      registryPath,
    };
    const control = createMemoryPort();
    const gate = createSwitchGate();
    const dispatcher = createDispatcher({
      port: control.port,
      budget: gate.gate,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
    });
    await body({ ledgerPath, registryPath, config, control, dispatcher, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("concurrent watches on two completed sessions keep both terminals", async () => {
  await withHarness(async ({ control, dispatcher, ledgerPath, registryPath }) => {
    const first = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    const second = await dispatcher.start(
      item("item-b") as never,
      decision("item-b", "laptop-b") as never,
      MODEL,
      "Do the work.",
    );
    if (first.kind !== "started" || second.kind !== "started") {
      throw new Error("expected two started sessions");
    }
    control.complete(first.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    control.complete(second.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    const [outcomeA, outcomeB] = await Promise.all([
      dispatcher.watch(first.request.requestId),
      dispatcher.watch(second.request.requestId),
    ]);
    expect(outcomeA.result.state).toBe("finished");
    expect(outcomeB.result.state).toBe("finished");
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.terminal?.state).toBe("finished");
      expect(entry.terminal?.ledgerAppended).toBe(true);
    }
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(2);
  });
});

test("a start during a watch keeps both registry entries", async () => {
  await withHarness(async ({ control, dispatcher, registryPath }) => {
    const first = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (first.kind !== "started") {
      throw new Error("expected a started session");
    }
    control.complete(first.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    const [watched, second] = await Promise.all([
      dispatcher.watch(first.request.requestId),
      dispatcher.start(
        item("item-b") as never,
        decision("item-b", "laptop-b") as never,
        MODEL,
        "Do the work.",
      ),
    ]);
    expect(watched.result.state).toBe("finished");
    if (second.kind !== "started") {
      throw new Error("expected the second session to start");
    }
    const entries = await readRegistry(registryPath);
    expect(entries.map((entry) => entry.requestId).sort()).toEqual(["item-a:0", "item-b:0"]);
    expect(second.request.requestId).toBe("item-b:0");
    control.complete(second.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    const follow = await dispatcher.watch(second.request.requestId);
    expect(follow.result.state).toBe("finished");
  });
});

test("I1: two pending watches append once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-conc-same-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const waits = gatePort(control.port, new Set(["wait"]));
    const gate = createSwitchGate();
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      registryPath,
    };
    const ticks = { now: new Date("2026-10-27T10:00:00.000Z") };
    const dispatcher = createDispatcher({
      port: waits.port,
      budget: gate.gate,
      ledgerPath,
      config,
      // The clock advances 1 s per read: two watchers that both finished
      // the session would stamp different finishedAt values, so only the
      // hold-B terminal re-read keeps the second a replay.
      now: () => {
        const current = ticks.now;
        ticks.now = new Date(current.getTime() + 1000);
        return current;
      },
      sleep: () => Promise.resolve(),
      log: () => undefined,
    });
    const started = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const first = dispatcher.watch(started.request.requestId);
    const second = dispatcher.watch(started.request.requestId);
    const parkedA = await waits.next("wait");
    const parkedB = await waits.next("wait");
    control.complete(started.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    await parkedA.release();
    await parkedB.release();
    const [outcomeA, outcomeB] = await Promise.all([first, second]);
    expect(outcomeA.result.state).toBe("finished");
    expect(outcomeB.result.state).toBe("finished");
    const ledgers = [outcomeA.ledger, outcomeB.ledger].sort();
    expect(ledgers).toEqual(["appended", "unchanged"]);
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(waits.calls("wait")).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("I2: two watchers count one unreachable interval once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-i2-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const { control, waits, dispatcher } = dispatcherAt(registryPath, ledgerPath, {
      now: new Date("2026-10-27T10:00:00.000Z"),
    });
    const started = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const requestId = started.request.requestId;
    const first = dispatcher.watch(requestId);
    const second = dispatcher.watch(requestId);
    const parkedA = await waits.next("wait");
    const parkedB = await waits.next("wait");
    // The gate delivers the unreachable miss to each watcher: the memory
    // port itself stays reachable, so the later releases still run.
    parkedA.fail(new PortUnreachableError("host laptop-a unreachable"));
    parkedB.fail(new PortUnreachableError("host laptop-a unreachable"));
    // Both watchers miss the same interval and loop: each parks again.
    const parkedC = await waits.next("wait");
    const parkedD = await waits.next("wait");
    const entries = await readRegistry(registryPath);
    const entry = entries.find((candidate) => candidate.requestId === requestId);
    // Exactly one of the two misses was written: count 1, one revision
    // past the settled start.
    expect(entry?.unreachableCount).toBe(1);
    expect(entry?.revision).toBe(2);
    expect(entry?.terminal).toBeNull();
    control.complete(started.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    await parkedC.release();
    await parkedD.release();
    const [outcomeA, outcomeB] = await Promise.all([first, second]);
    expect(outcomeA.result.state).toBe("finished");
    expect(outcomeB.result.state).toBe("finished");
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("I3: cancel while a wait is pending ends the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-i3-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const { waits, dispatcher } = dispatcherAt(registryPath, ledgerPath, {
      now: new Date("2026-10-27T10:00:00.000Z"),
    });
    const started = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const requestId = started.request.requestId;
    const watched = dispatcher.watch(requestId);
    const parkedWait = await waits.next("wait");
    // The memory port settles cancelled at once, so releasing the parked
    // cancel runs it to completion while the watch stays parked.
    const cancelled = dispatcher.cancel(requestId, "user-returned");
    const parkedCancel = await waits.next("cancel");
    await parkedCancel.release();
    const cancelOutcome = await cancelled;
    expect(cancelOutcome.result.state).toBe("cancelled");
    expect(cancelOutcome.attempt).toBe("failure");
    expect(cancelOutcome.ledger).toBe("appended");
    await parkedWait.release();
    const watchOutcome = await watched;
    expect(watchOutcome.result.state).toBe("cancelled");
    expect(watchOutcome.ledger).toBe("unchanged");
    const entries = await readRegistry(registryPath);
    const entry = entries.find((candidate) => candidate.requestId === requestId);
    expect(entry?.cancelReason).toBe("user-returned");
    expect(entry?.terminal?.ledgerAppended).toBe(true);
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.session?.result).toBe("failure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("I5: a finish observed during cancel keeps finished", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-i5-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const { control, waits, dispatcher } = dispatcherAt(registryPath, ledgerPath, {
      now: new Date("2026-10-27T10:00:00.000Z"),
    });
    const started = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const requestId = started.request.requestId;
    const watched = dispatcher.watch(requestId);
    const cancelled = dispatcher.cancel(requestId, "operator");
    const parkedWait = await waits.next("wait");
    const parkedCancel = await waits.next("cancel");
    // The finish lands between C1 and C2: the watch finishes first, then
    // the cancel replays the sticky port result as finished.
    control.complete(started.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    await parkedWait.release();
    const watchOutcome = await watched;
    expect(watchOutcome.result.state).toBe("finished");
    expect(watchOutcome.attempt).toBe("success");
    expect(watchOutcome.ledger).toBe("appended");
    await parkedCancel.release();
    const cancelOutcome = await cancelled;
    expect(cancelOutcome.result.state).toBe("finished");
    expect(cancelOutcome.attempt).toBe("success");
    expect(cancelOutcome.ledger).toBe("unchanged");
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.session?.result).toBe("success");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("I6: the first cancel reason wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-i6-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const { waits, dispatcher } = dispatcherAt(registryPath, ledgerPath, {
      now: new Date("2026-10-27T10:00:00.000Z"),
    });
    const started = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const requestId = started.request.requestId;
    const first = dispatcher.cancel(requestId, "stall");
    const second = dispatcher.cancel(requestId, "operator");
    const parkedA = await waits.next("cancel");
    const parkedB = await waits.next("cancel");
    await parkedA.release();
    await parkedB.release();
    const [outcomeA, outcomeB] = await Promise.all([first, second]);
    expect(outcomeA.result.state).toBe("cancelled");
    expect(outcomeB.result.state).toBe("cancelled");
    // Both attempts map stalled: the first reason wins.
    expect(outcomeA.attempt).toBe("stalled");
    expect(outcomeB.attempt).toBe("stalled");
    const entries = await readRegistry(registryPath);
    expect(entries[0]?.cancelReason).toBe("stall");
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.session?.result).toBe("stalled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("I6b: a reason stored by a failed cancel survives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-i6b-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const { waits, dispatcher } = dispatcherAt(registryPath, ledgerPath, {
      now: new Date("2026-10-27T10:00:00.000Z"),
    });
    const started = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const requestId = started.request.requestId;
    // The unreachable cancel fails with the reason already stored by C1:
    // park the gated cancel, then deliver the miss without a port call.
    const failed = dispatcher.cancel(requestId, "stall");
    const parkedFailed = await waits.next("cancel");
    // The gate delivers the miss without calling the port: C1 already
    // stored the reason and the error propagates with no write.
    parkedFailed.fail(new PortUnreachableError("host laptop-a unreachable"));
    let failure: unknown;
    try {
      await failed;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PortUnreachableError);
    const second = dispatcher.cancel(requestId, "operator");
    const parkedSecond = await waits.next("cancel");
    await parkedSecond.release();
    const outcome = await second;
    expect(outcome.result.state).toBe("cancelled");
    expect(outcome.attempt).toBe("stalled");
    const entries = await readRegistry(registryPath);
    expect(entries[0]?.cancelReason).toBe("stall");
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.session?.result).toBe("stalled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("I7: a replayed start during a watch returns the stored session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-i7-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const { control, gate, waits, dispatcher } = dispatcherAt(registryPath, ledgerPath, {
      now: new Date("2026-10-27T10:00:00.000Z"),
    });
    const started = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const requestId = started.request.requestId;
    const watched = dispatcher.watch(requestId);
    const parkedWait = await waits.next("wait");
    // The gate refuses after its first call, so a gated replay would be
    // refused: the replay must return the stored handle with no new calls.
    gate.refuse("test refusal");
    const replayed = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    expect(gate.calls()).toBe(1);
    if (replayed.kind !== "started") {
      throw new Error("expected a replayed start");
    }
    expect(replayed.handle.sessionId).toBe(started.handle.sessionId);
    expect(replayed.request.requestId).toBe(requestId);
    control.complete(started.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    await parkedWait.release();
    const watchOutcome = await watched;
    expect(watchOutcome.result.state).toBe("finished");
    expect(watchOutcome.ledger).toBe("appended");
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("I9: two identical starts make one session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-i9-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const { control, gate, dispatcher } = dispatcherAt(registryPath, ledgerPath, {
      now: new Date("2026-10-27T10:00:00.000Z"),
    });
    const [outcomeA, outcomeB] = await Promise.all([
      dispatcher.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      ),
      dispatcher.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      ),
    ]);
    if (outcomeA.kind !== "started" || outcomeB.kind !== "started") {
      throw new Error("expected two started outcomes");
    }
    expect(outcomeA.handle.sessionId).toBe(outcomeB.handle.sessionId);
    expect(gate.calls()).toBe(1);
    expect(control.sessions()).toHaveLength(1);
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.requestId).toBe("item-a:0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("I9b: two dispatcher instances on one registry make one session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-i9b-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const gate = createSwitchGate();
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      registryPath,
    };
    const clock = () => new Date("2026-10-27T10:00:00.000Z");
    const makeDispatcher = () =>
      createDispatcher({
        port: control.port,
        budget: gate.gate,
        ledgerPath,
        config,
        now: clock,
        sleep: () => Promise.resolve(),
        log: () => undefined,
      });
    const a = makeDispatcher();
    const b = makeDispatcher();
    const [outcomeA, outcomeB] = await Promise.all([
      a.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      ),
      b.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      ),
    ]);
    if (outcomeA.kind !== "started" || outcomeB.kind !== "started") {
      throw new Error("expected two started outcomes");
    }
    expect(outcomeA.handle.sessionId).toBe(outcomeB.handle.sessionId);
    expect(gate.calls()).toBe(1);
    expect(control.sessions()).toHaveLength(1);
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.requestId).toBe("item-a:0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("I10: a second placement conflicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-i10-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    // Gate port.start too: parking first's start proves its hold owns
    // the item lock (provisional inserted), so the second start
    // deterministically queues behind it instead of racing the stat
    // calls that precede the lock. Without the gate, whichever call's
    // provider stat resolves first would win the lock.
    const starts = gatePort(control.port, new Set(["start", "wait", "cancel"]));
    const gate = createSwitchGate();
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      registryPath,
    };
    const dispatcher = createDispatcher({
      port: starts.port,
      budget: gate.gate,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
    });
    const first = dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    const parkedStart = await starts.next("start");
    const second = dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-b") as never,
      MODEL,
      "Do the work.",
    );
    await parkedStart.release();
    const [outcomeA, outcomeB] = await Promise.allSettled([first, second]);
    if (outcomeA.status !== "fulfilled" || outcomeA.value.kind !== "started") {
      throw new Error("expected the first start to win");
    }
    expect(outcomeB.status).toBe("rejected");
    if (outcomeB.status !== "rejected") {
      throw new Error("expected the second start to conflict");
    }
    expect(String(outcomeB.reason)).toContain("request-conflict");
    expect(control.sessions()).toHaveLength(1);
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hostAlias).toBe("laptop-a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("I11: start during the previous session's watch never returns the old session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-i11-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const { control, waits, dispatcher } = dispatcherAt(registryPath, ledgerPath, {
      now: new Date("2026-10-27T10:00:00.000Z"),
    });
    const started = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const requestId = started.request.requestId;
    const watched = dispatcher.watch(requestId);
    const parkedWait = await waits.next("wait");
    // The previous session is complete in the port but still non-terminal
    // in the registry: the next attempt must conflict, not replay :0.
    control.complete(started.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    let conflict: unknown;
    try {
      await dispatcher.start(
        item("item-a") as never,
        decision("item-a", "laptop-b") as never,
        MODEL,
        "Do the work.",
      );
    } catch (error) {
      conflict = error;
    }
    expect(String(conflict)).toContain("request-conflict");
    await parkedWait.release();
    const watchOutcome = await watched;
    expect(watchOutcome.result.state).toBe("finished");
    expect(watchOutcome.ledger).toBe("appended");
    // I12: with :0 terminal, the same start gives the next attempt.
    const next = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-b") as never,
      MODEL,
      "Do the work.",
    );
    if (next.kind !== "started") {
      throw new Error("expected the next attempt to start");
    }
    expect(next.request.requestId).toBe("item-a:1");
    expect(next.handle.hostAlias).toBe("laptop-b");
    const entries = await readRegistry(registryPath);
    expect(entries.map((entry) => entry.requestId).sort()).toEqual(["item-a:0", "item-a:1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

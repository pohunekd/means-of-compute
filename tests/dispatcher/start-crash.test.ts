// Crash-point tests for dispatcher start (section 2.2, rows K0-K7).
// Deterministic: memory port behind the switch gate, in-process switch
// gate, temp ledger and registry. File modes flip the registry directory
// read-only to fail a write at the chosen point.
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import {
  DispatchStateError,
  createDispatcher,
  type StartOutcome,
} from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import {
  PortRejectedError,
  PortUnreachableError,
  type ModelSelection,
  type SessionHandle,
  type StartRequest,
} from "../../src/dispatcher/port.js";
import { readRegistry } from "../../src/dispatcher/registry.js";
import { readLedger } from "../../src/ledger/read.js";
import { createSwitchGate, gatePort } from "./gated-port.js";

const MODEL: ModelSelection = { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" };

function item(id: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo",
    title: `Demo item ${id}`,
    goal: "Exercise the dispatcher start crash points",
    issue: 10,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: "moc/item-a",
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

interface CrashHarness {
  readonly dir: string;
  readonly ledgerPath: string;
  readonly registryPath: string;
  readonly control: ReturnType<typeof createMemoryPort>;
  readonly waits: ReturnType<typeof gatePort>;
  readonly gate: ReturnType<typeof createSwitchGate>;
  readonly config: DispatcherConfig;
  readonly dispatcher: ReturnType<typeof createDispatcher>;
}

async function withHarness(body: (h: CrashHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-crash-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const waits = gatePort(control.port, new Set(["start", "wait"]));
    const gate = createSwitchGate();
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      nonTerminalPauseMs: 0,
      registryPath,
    };
    const ticks = { now: new Date("2026-10-27T10:00:00.000Z") };
    const dispatcher = createDispatcher({
      port: waits.port,
      budget: gate.gate,
      config,
      ledgerPath,
      now: () => {
        const current = ticks.now;
        ticks.now = new Date(current.getTime() + 1000);
        return current;
      },
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    await body({ dir, ledgerPath, registryPath, control, waits, gate, config, dispatcher });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function startedOf(
  outcome: StartOutcome,
): asserts outcome is Extract<StartOutcome, { kind: "started" }> {
  if (outcome.kind !== "started") {
    throw new Error(`expected a started outcome, got ${outcome.kind}`);
  }
}

function gateUnused(): { admit(): Promise<{ admit: true; line: string }> } {
  return {
    admit() {
      return Promise.resolve({ admit: true as const, line: "admitted: test" });
    },
  };
}

test("K0: an unwritable registry stops start before port.start", async () => {
  await withHarness(async ({ control, dir, gate, ledgerPath, registryPath, waits, dispatcher }) => {
    await chmod(dir, 0o500);
    let error: unknown;
    try {
      await dispatcher.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (caught) {
      error = caught;
    } finally {
      await chmod(dir, 0o700);
    }
    expect(error).toBeDefined();
    expect(waits.calls("start")).toBe(0);
    // After the mode is restored, the gate refuses and nothing is written.
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(0);
    expect(contents.records).toHaveLength(0);
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(0);
    // Second half: the restored registry stays empty, so a refused gate
    // stops the replay before any port call or write.
    gate.refuse("test refusal");
    const refused = await dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    expect(refused.kind).toBe("refused");
    expect(control.sessions()).toHaveLength(0);
    const after = await readRegistry(registryPath);
    expect(after).toHaveLength(0);
  });
});

test("K1: a crash before port.start settles on replay", async () => {
  await withHarness(
    async ({ control, waits, gate, dispatcher, config, ledgerPath, registryPath }) => {
      const first = dispatcher.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      const parked = await waits.next("start");
      // The crash happens before port.start reaches the port: the caller
      // sees the injected error while no session exists in the port yet.
      parked.fail(new Error("injected"));
      let failure: unknown;
      try {
        await first;
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("injected");
      expect(control.sessions()).toHaveLength(0);
      // A fresh dispatcher on the same files and memory control: the gate
      // now refuses, but the provisional hit settles without a gate call.
      // The refusal above would stop a fresh placement, but the
      // provisional hit replays without touching the gate.
      gate.refuse("test refusal");
      const ticks = { now: new Date("2026-10-27T10:00:00.000Z") };
      const replayed = createDispatcher({
        port: control.port,
        budget: gate.gate,
        config,
        ledgerPath,
        now: () => ticks.now,
        sleep: () => Promise.resolve(),
        log: () => undefined,

        lostUsage: () => Promise.resolve(null),
      });
      // The refusal above would stop a fresh placement, but the
      // provisional hit replays without touching the gate.
      const outcome = await replayed.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      startedOf(outcome);
      expect(gate.calls()).toBe(1);
      expect(control.sessions()).toHaveLength(1);
      expect(outcome.request.requestId).toBe("item-a:0");
      // The replay itself created the session through port.start and
      // settled it onto the provisional entry.
      expect(control.sessions()[0]?.handle.sessionId).toBe(outcome.handle.sessionId);
      const entries = await readRegistry(registryPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sessionId).toBe(outcome.handle.sessionId);
    },
  );
});

test("K2: a crash after port.start keeps one session", async () => {
  await withHarness(async ({ control, ledgerPath, waits, dispatcher, registryPath }) => {
    const first = dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    const parked = await waits.next("start");
    const provisionalAt = await readRegistry(registryPath);
    const provisionalStartedAt = provisionalAt[0]?.startedAt;
    const released = parked.releaseThenFail(new Error("injected"));
    let failure: unknown;
    try {
      await first;
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("injected");
    await released;
    const second = dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    const parkedSecond = await waits.next("start");
    await parkedSecond.release();
    const outcome = await second;
    startedOf(outcome);
    // The same session, settled onto the provisional insert time.
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionId).toBe(outcome.handle.sessionId);
    expect(entries[0]?.startedAt).toBe(provisionalStartedAt);
    expect(waits.calls("start")).toBe(2);
    expect(control.sessions()).toHaveLength(1);
    // The replay returns the same session the first call created in the
    // port (P1): no second session, no new registry entry.
    const live = control.sessions()[0];
    if (live === undefined) {
      throw new Error("expected one live session in the port");
    }
    expect(outcome.handle.sessionId).toBe(live.handle.sessionId);
    control.complete(outcome.handle.sessionId, { state: "finished", usage: null, detail: "done" });
    const finished = dispatcher.watch(outcome.request.requestId);
    const parkedWatch = await waits.next("wait");
    await parkedWatch.release();
    const settled = await finished;
    expect(settled.result.state).toBe("finished");
    expect(settled.ledger).toBe("appended");
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.entryId).toBe(`item-a:${outcome.handle.sessionId}`);
  });
});

test("K4: an unreachable host at start ends lost after the threshold", async () => {
  await withHarness(async ({ control, ledgerPath, registryPath, config }) => {
    // The clock advances 30 s per read, so any clock read written into
    // the entry shows up as non-zero seconds on the lost terminal.
    const ticks = { now: new Date("2026-10-27T10:00:00.000Z") };
    const events: Array<Record<string, unknown>> = [];
    const plain = createDispatcher({
      port: control.port,
      budget: gateUnused(),
      config,
      ledgerPath,
      now: () => {
        const current = ticks.now;
        ticks.now = new Date(current.getTime() + 30_000);
        return current;
      },
      sleep: () => Promise.resolve(),
      log: (event) => {
        events.push({ ...event });
      },

      lostUsage: () => Promise.resolve(null),
    });
    control.setUnreachable("laptop-a", true);
    const attempts: Array<unknown> = [];
    for (let round = 0; round < 3; round += 1) {
      const pending = plain.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      try {
        attempts.push(await pending);
      } catch (error) {
        attempts.push(error);
      }
    }
    expect(attempts[0]).toBeInstanceOf(PortUnreachableError);
    expect(attempts[1]).toBeInstanceOf(PortUnreachableError);
    const lost = attempts[2];
    if (typeof lost !== "object" || lost === null || !("kind" in lost) || lost.kind !== "lost") {
      throw new Error("expected the third start to return lost");
    }
    // A lost-at-start outcome has no session id: the terminal result
    // reports null and the terminal event omits the sessionId key.
    const lostRequestId = (lost as unknown as { requestId: string }).requestId;
    const lostResult = await plain.watch(lostRequestId);
    expect(lostResult.result.state).toBe("lost");
    expect(lostResult.result.sessionId).toBeNull();
    const terminalEvents = events.filter((event) => event["event"] === "terminal");
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).not.toHaveProperty("sessionId");
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.terminal?.state).toBe("lost");
    expect(entries[0]?.terminal?.ledgerAppended).toBe(true);
    expect(entries[0]?.terminal?.seconds).toBe(0);
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.entryId).toBe("item-a:item-a:0");
    expect(contents.pending[0]?.session?.result).toBe("lost");
    expect(contents.pending[0]?.session?.seconds).toBe(0);
    // A later attempt on another host gets the next request id.
    control.setUnreachable("laptop-a", false);
    const last = plain.start(
      item("item-a") as never,
      decision("item-a", "laptop-b") as never,
      MODEL,
      "Do the work.",
    );
    const next = await last;
    startedOf(next);
    expect(next.request.requestId).toBe("item-a:1");
  });
});

test("K4b: two unreachable starts then a settle reset the count", async () => {
  await withHarness(async ({ control, ledgerPath, registryPath, config }) => {
    const plain = createDispatcher({
      port: control.port,
      budget: gateUnused(),
      config,
      ledgerPath,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    control.setUnreachable("laptop-a", true);
    for (let round = 0; round < 2; round += 1) {
      let error: unknown;
      try {
        await plain.start(
          item("item-a") as never,
          decision("item-a", "laptop-a") as never,
          MODEL,
          "Do the work.",
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PortUnreachableError);
    }
    control.setUnreachable("laptop-a", false);
    const outcome = await plain.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    startedOf(outcome);
    const settled = await readRegistry(registryPath);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.unreachableCount).toBe(0);
    // The waits run behind a gate with no timers: the first wait fails
    // with PortUnreachableError, and the second wait parks until the
    // test releases it. When the second wait reaches the port, the miss
    // write has landed, so the registry shows count 1.
    const gated = gatePort(control.port, new Set(["wait"]));
    const watcher = createDispatcher({
      port: gated.port,
      budget: gateUnused(),
      config,
      ledgerPath,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    const watching = watcher.watch(outcome.request.requestId);
    const parkedFirst = await gated.next("wait");
    parkedFirst.fail(new PortUnreachableError("host unreachable"));
    const parkedSecond = await gated.next("wait");
    const mid = await readRegistry(registryPath);
    expect(mid[0]?.unreachableCount).toBe(1);
    expect(mid[0]?.terminal).toBeNull();
    control.complete(outcome.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "done",
    });
    await parkedSecond.release();
    const finished = await watching;
    expect(finished.result.state).toBe("finished");
  });
});

test("K5: a rejected start removes its provisional entry", async () => {
  await withHarness(async ({ control, registryPath, config, ledgerPath }) => {
    control.pushCommit("main", "m1");
    control.pushCommit("moc/item-a", "b1");
    await control.port.start({
      requestId: "setup:0",
      workItemId: "setup",
      repo: "example/demo",
      hostAlias: "laptop-a",
      branch: "moc/item-a",
      baseRef: "origin/main",
      resume: false,
      model: MODEL,
      brief: "Setup the branch tip.",
    });
    let error: unknown;
    const rejecting = createDispatcher({
      port: control.port,
      budget: gateUnused(),
      config,
      ledgerPath,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    const pending = rejecting.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PortRejectedError);
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(0);
    // The same request id stays reusable: a fresh placement starts it.
    const fresh = rejecting.start(
      { ...item("item-a"), branch: null } as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    const next = await fresh;
    startedOf(next);
    expect(next.request.requestId).toBe("item-a:0");
  });
});

test("K6: an invalid handle keeps the provisional entry", async () => {
  await withHarness(async ({ control, gate, registryPath, config, ledgerPath }) => {
    const events: Array<Record<string, unknown>> = [];
    const logging = createDispatcher({
      port: {
        ...control.port,
        start(request: StartRequest): Promise<SessionHandle> {
          return control.port.start(request).then((handle) => ({ ...handle, worktree: "" }));
        },
      },
      budget: gate.gate,
      config,
      ledgerPath,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: (event) => {
        events.push({ ...event });
      },

      lostUsage: () => Promise.resolve(null),
    });
    let error: unknown;
    try {
      await logging.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("invalid-handle");
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionId).toBeNull();
    // The invalid handle surfaces as the thrown invalid-handle state
    // error: its code names the failure.
    expect((error as DispatchStateError).code).toBe("invalid-handle");
    // The failure is logged with the failed check as the detail.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error",
      event: "invalid-handle",
      requestId: "item-a:0",
      workItemId: "item-a",
      detail: "worktree",
    });
    // A replay with the same inputs reports the same stuck entry.
    let replayed: unknown;
    try {
      await logging.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (caught) {
      replayed = caught;
    }
    expect(String(replayed)).toContain("invalid-handle");
  });
});

test("K6b: a handle for the wrong host logs invalid-handle", async () => {
  await withHarness(async ({ control, gate, registryPath, config, ledgerPath }) => {
    const events: Array<Record<string, unknown>> = [];
    const misplaced = createDispatcher({
      port: {
        ...control.port,
        start(request: StartRequest): Promise<SessionHandle> {
          return control.port
            .start(request)
            .then((handle) => ({ ...handle, hostAlias: "laptop-b" }));
        },
      },
      budget: gate.gate,
      config,
      ledgerPath,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: (event) => {
        events.push({ ...event });
      },

      lostUsage: () => Promise.resolve(null),
    });
    let error: unknown;
    try {
      await misplaced.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as DispatchStateError).code).toBe("invalid-handle");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error",
      event: "invalid-handle",
      requestId: "item-a:0",
      workItemId: "item-a",
      detail: "host",
    });
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionId).toBeNull();
  });
});

test("K7: a port binding conflict keeps the provisional entry", async () => {
  await withHarness(async ({ control, gate, registryPath, config, ledgerPath }) => {
    const conflicting = createDispatcher({
      port: {
        ...control.port,
        start(): Promise<SessionHandle> {
          throw new PortRejectedError("request-conflict", "port holds a binding");
        },
      },
      budget: gate.gate,
      config,
      ledgerPath,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    let error: unknown;
    try {
      await conflicting.start(
        item("item-a") as never,
        decision("item-a", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DispatchStateError);
    expect((error as DispatchStateError).code).toBe("port-binding-conflict");
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionId).toBeNull();
  });
});

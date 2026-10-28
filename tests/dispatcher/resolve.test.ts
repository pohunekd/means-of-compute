// Dispatcher resolve: an operator ends a stuck or lost request without
// guessing. A provisional entry ends lost with one ledger line; a terminal
// entry is released with no second line; failures leave the entry deep-equal.
// Deterministic: memory port, temp registry and ledger, no timers.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher, DispatchStateError } from "../../src/dispatcher/dispatcher.js";
import { readRegistry } from "../../src/dispatcher/registry.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import { readLedger } from "../../src/ledger/read.js";
import type { PendingUsage } from "../../src/ledger/types.js";
import type {
  DispatcherPort,
  ModelSelection,
  PortUsage,
  StartRequest,
} from "../../src/dispatcher/port.js";
import { PortRejectedError, PortUnreachableError } from "../../src/dispatcher/port.js";
import { gatePort } from "./gated-port.js";
import type { GatedMethod } from "./gated-port.js";
import { LedgerDataError } from "../../src/ledger/errors.js";

const MODEL: ModelSelection = { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" };

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

function queuedItem(id: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo",
    title: "Demo item",
    goal: "Exercise resolve",
    issue: 53,
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

function decision(itemId: string, hostAlias: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId: itemId,
    chosenHostAlias: hostAlias,
    reason: "test decision",
    candidates: [{ hostAlias, score: 1, reason: "only host", excluded: false }],
  };
}

interface UsageCall {
  readonly requestId: string;
}

interface Harness {
  readonly ledgerPath: string;
  readonly config: DispatcherConfig;
  readonly control: ReturnType<typeof createMemoryPort>;
  readonly dispatcher: ReturnType<typeof createDispatcher>;
  readonly settleUsageCalls: UsageCall[];
  readonly dir: string;
  readonly clock: { now: Date };
}

interface HarnessOptions {
  readonly lostAfterUnreachable?: number;
  readonly failLostUsageOnce?: Error;
  readonly port?: DispatcherPort;
  readonly advanceClockInLostUsageMs?: number;
}

async function withHarness(
  options: HarnessOptions,
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-resolve-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: options.lostAfterUnreachable ?? 3,
      unreachableBackoffMs: 0,
      nonTerminalPauseMs: 0,
      registryPath: join(dir, "registry.json"),
    };
    const control = createMemoryPort();
    const clock = { now: new Date("2026-10-27T10:00:00.000Z") };
    const settleUsageCalls: UsageCall[] = [];
    let failLostUsage: Error | null = options.failLostUsageOnce ?? null;
    const dispatcher = createDispatcher({
      port: options.port ?? control.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => clock.now,
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: (requestId: string): Promise<PortUsage | null> => {
        settleUsageCalls.push({ requestId });
        if (failLostUsage !== null) {
          const error = failLostUsage;
          failLostUsage = null;
          return Promise.reject(error);
        }
        // The R1/R2 hook runs after finishLost reads observedAt and
        // before the marker is set, so advancing here gives a second
        // clock read another instant.
        const advanceMs = options.advanceClockInLostUsageMs ?? 0;
        if (advanceMs !== 0) {
          clock.now = new Date(clock.now.getTime() + advanceMs);
        }
        return Promise.resolve(null);
      },
    });
    await body({ ledgerPath, config, control, dispatcher, settleUsageCalls, dir, clock });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readPending(ledgerPath: string): Promise<readonly PendingUsage[]> {
  try {
    const contents = await readLedger("Test ledger", ledgerPath);
    return contents.pending;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function failUnreachableFirst(control: ReturnType<typeof createMemoryPort>): {
  port: DispatcherPort;
  calls: { start: number };
} {
  const calls = { start: 0 };
  const port: DispatcherPort = {
    ...control.port,
    start: (request: StartRequest) => {
      calls.start += 1;
      const handlePromise = control.port.start(request);
      if (calls.start === 1) {
        return handlePromise.then(() => {
          throw new PortUnreachableError("reply lost");
        });
      }
      return handlePromise;
    },
  };
  return { port, calls };
}

test("R1 a provisional with nothing bound ends lost with one line", async () => {
  await withHarness(
    { advanceClockInLostUsageMs: 1000 },
    async ({ control, dispatcher, ledgerPath, settleUsageCalls, clock }) => {
      control.setUnreachable("laptop-a", true);
      let startError: unknown = null;
      try {
        await dispatcher.start(
          queuedItem("demo-item") as never,
          decision("demo-item", "laptop-a") as never,
          MODEL,
          "Do the work.",
        );
      } catch (error: unknown) {
        startError = error;
      }
      expect(startError).toBeInstanceOf(PortUnreachableError);
      control.setUnreachable("laptop-a", false);
      const outcome = await dispatcher.resolve("demo-item:0");
      expect(outcome).toEqual({
        requestId: "demo-item:0",
        hostAlias: "laptop-a",
        outcome: "resolved",
        from: "provisional",
        state: "lost",
        stopped: [],
        ledger: "appended",
      });
      const entries = await readRegistry(join(ledgerPath, "..", "registry.json"));
      expect(entries).toHaveLength(1);
      const stored = entries[0];
      if (stored?.terminal === null || stored?.terminal === undefined) {
        throw new Error("expected a lost terminal");
      }
      expect(stored.terminal.observedAt).toBe("2026-10-27T10:00:00.000Z");
      expect(stored.resolvedAt).toBe(stored.terminal.observedAt);
      expect(clock.now.toISOString()).toBe("2026-10-27T10:00:01.000Z");
      expect(entries[0]).toEqual({
        requestId: "demo-item:0",
        workItemId: "demo-item",
        repo: "example/demo",
        hostAlias: "laptop-a",
        branch: "moc/demo-item",
        baseRef: "origin/main",
        resume: false,
        model: MODEL,
        briefSha256: expect.any(String) as string,
        sessionId: null,
        worktree: null,
        baseCommit: null,
        startedAt: "2026-10-27T10:00:00.000Z",
        cursor: null,
        unreachableCount: 1,
        lastSeenState: "starting",
        lastSeenAt: "2026-10-27T10:00:00.000Z",
        cancelReason: null,
        terminal: {
          state: "lost",
          observedAt: "2026-10-27T10:00:00.000Z",
          seconds: 0,
          usage: null,
          usageValid: true,
          detail: "operator resolved",
          ledgerAppended: true,
        },
        resolvedAt: "2026-10-27T10:00:00.000Z",
        revision: 3,
      });
      const lines = await readPending(ledgerPath);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        entryId: "demo-item:demo-item:0",
        kind: "session",
        workItemId: "demo-item",
        finishedAt: "2026-10-27T10:00:00.000Z",
        startModel: MODEL.model,
        tokens: [
          {
            provider: MODEL.providerId,
            model: MODEL.model,
            inputTokens: null,
            outputTokens: null,
            requests: null,
            source: "usage-unreported",
          },
        ],
        session: {
          hostAlias: "laptop-a",
          seconds: 0,
          source: "dispatcher-clock",
          result: "lost",
        },
      });
      expect(settleUsageCalls).toEqual([{ requestId: "demo-item:0" }]);
    },
  );
});

test("R2 a provisional with a live bound session is stopped, then one line", async () => {
  const control = createMemoryPort();
  const { port } = failUnreachableFirst(control);
  await withHarness(
    { port, advanceClockInLostUsageMs: 1000 },
    async ({ dispatcher, ledgerPath, settleUsageCalls, dir, clock }) => {
      let startError: unknown = null;
      try {
        await dispatcher.start(
          queuedItem("demo-item") as never,
          decision("demo-item", "laptop-a") as never,
          MODEL,
          "Do the work.",
        );
      } catch (error: unknown) {
        startError = error;
      }
      expect(startError).toBeInstanceOf(PortUnreachableError);
      const registryBefore = await readRegistry(join(dir, "registry.json"));
      expect(registryBefore).toHaveLength(1);
      const outcome = await dispatcher.resolve("demo-item:0");
      expect(outcome).toEqual({
        requestId: "demo-item:0",
        hostAlias: "laptop-a",
        outcome: "resolved",
        from: "provisional",
        state: "lost",
        stopped: ["mem-1"],
        ledger: "appended",
      });
      const sessions = control.sessions();
      expect(sessions.map((entry) => entry.handle.sessionId)).toEqual(["mem-1"]);
      expect(sessions.map((entry) => entry.state)).toEqual(["cancelled"]);
      const registryAfter = await readRegistry(join(dir, "registry.json"));
      expect(registryAfter).toHaveLength(1);
      const resolvedEntry = registryAfter[0];
      if (resolvedEntry?.terminal === null || resolvedEntry?.terminal === undefined) {
        throw new Error("expected a lost terminal after resolve");
      }
      expect(resolvedEntry.terminal.state).toBe("lost");
      expect(resolvedEntry.terminal.detail).toBe("operator resolved");
      expect(resolvedEntry.terminal.ledgerAppended).toBe(true);
      expect(resolvedEntry.terminal.observedAt).toBe("2026-10-27T10:00:00.000Z");
      expect(resolvedEntry.resolvedAt).toBe(resolvedEntry.terminal.observedAt);
      expect(clock.now.toISOString()).toBe("2026-10-27T10:00:01.000Z");
      const lines = await readPending(ledgerPath);
      expect(lines).toHaveLength(1);
      expect((lines[0] as { entryId: string }).entryId).toBe("demo-item:demo-item:0");
      expect((lines[0] as { session: { result: string } }).session.result).toBe("lost");
      expect(settleUsageCalls).toEqual([{ requestId: "demo-item:0" }]);
      const retry = await dispatcher.start(
        queuedItem("demo-item") as never,
        decision("demo-item", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      expect(retry.kind).toBe("started");
      if (retry.kind !== "started") {
        throw new Error("expected a started session");
      }
      expect(retry.request.requestId).toBe("demo-item:1");
    },
  );
});

test("R3 a watch-path lost is stopped with no second line", async () => {
  await withHarness({}, async ({ control, dispatcher, ledgerPath, settleUsageCalls, clock }) => {
    const started = await dispatcher.start(
      queuedItem("demo-item") as never,
      decision("demo-item", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    control.setUnreachable("laptop-a", true);
    clock.now = new Date("2026-10-27T10:05:00.000Z");
    const lost = await dispatcher.watch("demo-item:0");
    expect(lost.result.state).toBe("lost");
    expect(lost.ledger).toBe("appended");
    control.setUnreachable("laptop-a", false);
    const before = await readRegistry(join(ledgerPath, "..", "registry.json"));
    const linesBefore = await readPending(ledgerPath);
    const outcome = await dispatcher.resolve("demo-item:0");
    expect(outcome).toEqual({
      requestId: "demo-item:0",
      hostAlias: "laptop-a",
      outcome: "resolved",
      from: "terminal",
      state: "lost",
      stopped: ["mem-1"],
      ledger: "none",
    });
    const linesAfter = await readPending(ledgerPath);
    expect(linesAfter).toEqual(linesBefore);
    const after = await readRegistry(join(ledgerPath, "..", "registry.json"));
    expect(after).toHaveLength(1);
    const beforeEntry = before[0];
    const afterEntry = after[0];
    if (
      beforeEntry?.terminal === null ||
      beforeEntry?.terminal === undefined ||
      afterEntry?.terminal === undefined
    ) {
      throw new Error("expected terminals before and after resolve");
    }
    expect(afterEntry.terminal).toEqual(beforeEntry.terminal);
    expect(afterEntry.resolvedAt).toBe("2026-10-27T10:05:00.000Z");
    expect(afterEntry.revision).toBe(beforeEntry.revision + 1);
    expect(settleUsageCalls).toEqual([{ requestId: "demo-item:0" }]);
  });
});

test("R4 a start-path lost releases its bound session", async () => {
  const control = createMemoryPort();
  const { port } = failUnreachableFirst(control);
  await withHarness(
    { lostAfterUnreachable: 1, port },
    async ({ dispatcher, ledgerPath, settleUsageCalls }) => {
      const started = await dispatcher.start(
        queuedItem("demo-item") as never,
        decision("demo-item", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      expect(started.kind).toBe("lost");
      const outcome = await dispatcher.resolve("demo-item:0");
      expect(outcome).toEqual({
        requestId: "demo-item:0",
        hostAlias: "laptop-a",
        outcome: "resolved",
        from: "terminal",
        state: "lost",
        stopped: ["mem-1"],
        ledger: "none",
      });
      const lines = await readPending(ledgerPath);
      expect(lines).toHaveLength(1);
      expect(settleUsageCalls).toHaveLength(1);
    },
  );
});

test("R5 void-incomplete keeps the entry, then resolves", async () => {
  const control = createMemoryPort();
  const { port } = failUnreachableFirst(control);
  await withHarness({ port }, async ({ dispatcher, ledgerPath, settleUsageCalls, dir }) => {
    let startError: unknown = null;
    try {
      await dispatcher.start(
        queuedItem("demo-item") as never,
        decision("demo-item", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (error: unknown) {
      startError = error;
    }
    expect(startError).toBeInstanceOf(PortUnreachableError);
    control.refuseRelease("laptop-a", "void-incomplete");
    const before = await readRegistry(join(dir, "registry.json"));
    let code = "";
    try {
      await dispatcher.resolve("demo-item:0");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PortRejectedError);
      code = (error as PortRejectedError).code;
    }
    expect(code).toBe("void-incomplete");
    const kept = await readRegistry(join(dir, "registry.json"));
    expect(kept).toEqual(before);
    expect(await readPending(ledgerPath)).toEqual([]);
    expect(settleUsageCalls).toEqual([]);
    control.refuseRelease("laptop-a", null);
    const outcome = await dispatcher.resolve("demo-item:0");
    expect(outcome.outcome).toBe("resolved");
    if (outcome.outcome !== "resolved") {
      throw new Error("expected a resolved outcome");
    }
    expect(outcome.from).toBe("provisional");
    expect(outcome.stopped).toEqual(["mem-1"]);
  });
});

test("R6 an unreachable host keeps the entry", async () => {
  await withHarness({}, async ({ control, dispatcher, ledgerPath, settleUsageCalls, dir }) => {
    control.setUnreachable("laptop-a", true);
    let startError: unknown = null;
    try {
      await dispatcher.start(
        queuedItem("demo-item") as never,
        decision("demo-item", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (error: unknown) {
      startError = error;
    }
    expect(startError).toBeInstanceOf(PortUnreachableError);
    const before = await readRegistry(join(dir, "registry.json"));
    let thrown: unknown = null;
    try {
      await dispatcher.resolve("demo-item:0");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PortUnreachableError);
    expect(await readRegistry(join(dir, "registry.json"))).toEqual(before);
    expect(await readPending(ledgerPath)).toEqual([]);
    expect(settleUsageCalls).toEqual([]);
  });
});

test("R7 a settled active entry is refused", async () => {
  await withGatedHarness(new Set(["release"]), async ({ control, gate, dispatcher, dir }) => {
    const started = await dispatcher.start(
      queuedItem("demo-item") as never,
      decision("demo-item", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const before = await readRegistry(join(dir, "registry.json"));
    let thrown: unknown = null;
    try {
      await dispatcher.resolve("demo-item:0");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DispatchStateError);
    expect((thrown as DispatchStateError).code).toBe("request-active");
    expect(await readRegistry(join(dir, "registry.json"))).toEqual(before);
    expect(gate.calls("release")).toBe(0);
    expect(control.sessions()).toHaveLength(1);
  });
});

test("R8 a meter failure after release writes nothing", async () => {
  const control = createMemoryPort();
  const { port } = failUnreachableFirst(control);
  await withHarness(
    { port, failLostUsageOnce: new Error("meter down") },
    async ({ dispatcher, ledgerPath, dir }) => {
      let startError: unknown = null;
      try {
        await dispatcher.start(
          queuedItem("demo-item") as never,
          decision("demo-item", "laptop-a") as never,
          MODEL,
          "Do the work.",
        );
      } catch (error: unknown) {
        startError = error;
      }
      expect(startError).toBeInstanceOf(PortUnreachableError);
      const before = await readRegistry(join(dir, "registry.json"));
      let message = "";
      try {
        await dispatcher.resolve("demo-item:0");
      } catch (error: unknown) {
        message = (error as Error).message;
      }
      expect(message).toBe("meter down");
      expect(await readRegistry(join(dir, "registry.json"))).toEqual(before);
      expect(await readPending(ledgerPath)).toEqual([]);
      expect(control.sessions().map((entry) => entry.state)).toEqual(["cancelled"]);
      const outcome = await dispatcher.resolve("demo-item:0");
      expect(outcome.outcome).toBe("resolved");
      if (outcome.outcome !== "resolved") {
        throw new Error("expected a resolved outcome");
      }
      expect(outcome.stopped).toEqual([]);
      expect(outcome.ledger).toBe("appended");
      expect(await readPending(ledgerPath)).toHaveLength(1);
    },
  );
});

test("R9 a lost entry with its line unappended is completed first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-resolve-r9-"));
  try {
    const ledgerDir = join(dir, "ledger-dir");
    await mkdir(ledgerDir, { recursive: true });
    const blockedPath = join(ledgerDir, "ledger.jsonl");
    await writeFile(blockedPath, "", "utf8");
    await chmod(blockedPath, 0o444);
    await chmod(ledgerDir, 0o555);
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      nonTerminalPauseMs: 0,
      registryPath: join(dir, "registry.json"),
    };
    const control = createMemoryPort();
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath: blockedPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const started = await dispatcher.start(
      queuedItem("demo-item") as never,
      decision("demo-item", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    control.setUnreachable("laptop-a", true);
    let firstError: unknown = null;
    try {
      await dispatcher.watch("demo-item:0");
    } catch (error: unknown) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(LedgerDataError);
    expect((firstError as LedgerDataError).message).toMatch(/cannot open lock \(EACCES\)$/);
    await chmod(ledgerDir, 0o755);
    await chmod(blockedPath, 0o644);
    const stored = await readRegistry(join(dir, "registry.json"));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.terminal?.state).toBe("lost");
    expect(stored[0]?.terminal?.ledgerAppended).toBe(false);
    control.setUnreachable("laptop-a", false);
    const outcome = await dispatcher.resolve("demo-item:0");
    expect(outcome.outcome).toBe("resolved");
    if (outcome.outcome !== "resolved") {
      throw new Error("expected a resolved outcome");
    }
    expect(outcome.from).toBe("terminal");
    expect(outcome.ledger).toBe("appended");
    expect(await readPending(blockedPath)).toHaveLength(1);
  } finally {
    await chmod(join(dir, "ledger-dir"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function resolveOnce(
  flow: "provisional-empty" | "provisional-bound" | "terminal",
  control: ReturnType<typeof createMemoryPort>,
  dispatcher: ReturnType<typeof createDispatcher>,
): Promise<void> {
  if (flow === "provisional-empty") {
    control.setUnreachable("laptop-a", true);
    let startError: unknown = null;
    try {
      await dispatcher.start(
        queuedItem("demo-item") as never,
        decision("demo-item", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (error: unknown) {
      startError = error;
    }
    expect(startError).toBeInstanceOf(PortUnreachableError);
    control.setUnreachable("laptop-a", false);
  } else if (flow === "provisional-bound") {
    // Reached only through the unreachable-first wrapper built by the
    // caller: the port creates the session, then the reply is dropped,
    // so the dispatcher keeps a provisional with a bound session.
    let startError: unknown = null;
    try {
      await dispatcher.start(
        queuedItem("demo-item") as never,
        decision("demo-item", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (error: unknown) {
      startError = error;
    }
    expect(startError).toBeInstanceOf(PortUnreachableError);
  } else {
    const started = await dispatcher.start(
      queuedItem("demo-item") as never,
      decision("demo-item", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    control.setUnreachable("laptop-a", true);
    const lost = await dispatcher.watch("demo-item:0");
    expect(lost.result.state).toBe("lost");
    control.setUnreachable("laptop-a", false);
  }
  const first = await dispatcher.resolve("demo-item:0");
  expect(first.outcome).toBe("resolved");
}

test.each(["provisional-empty", "provisional-bound", "terminal"] as const)(
  "R10 a second run is a no-op (after %s)",
  async (flow) => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-resolve-r10-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      const registryPath = join(dir, "registry.json");
      const config: DispatcherConfig = {
        baseBranch: "main",
        branchPrefix: "moc/",
        waitTimeoutMs: 1000,
        lostAfterUnreachable: 3,
        unreachableBackoffMs: 0,
        nonTerminalPauseMs: 0,
        registryPath,
      };
      const clock = { now: new Date("2026-10-27T10:00:00.000Z") };
      const makeDispatcher = (port: DispatcherPort): ReturnType<typeof createDispatcher> =>
        createDispatcher({
          port,
          budget: GATE,
          ledgerPath,
          config,
          now: () => clock.now,
          sleep: () => Promise.resolve(),
          log: () => undefined,
          settleUsage: () => Promise.resolve(null),
        });
      const control = createMemoryPort();
      const starter =
        flow === "provisional-bound" ? makeDispatcher(failUnreachableFirst(control).port) : null;
      const dispatcher = starter ?? makeDispatcher(control.port);
      await resolveOnce(flow, control, dispatcher);
      const registryBefore = await readFile(registryPath, "utf8");
      const ledgerBefore = await readFile(ledgerPath, "utf8").catch(() => "");
      const gate = gatePort(control.port, new Set(["release"]));
      const gatedDispatcher = makeDispatcher(gate.port);
      // The host stays unreachable: Q1 never touches the port, so the
      // second run is a no-op even with no host to talk to.
      control.setUnreachable("laptop-a", true);
      const second = await gatedDispatcher.resolve("demo-item:0");
      control.setUnreachable("laptop-a", false);
      expect(second.outcome).toBe("already-resolved");
      if (second.outcome !== "already-resolved") {
        throw new Error("expected already-resolved");
      }
      expect(second.ledger).toBe("none");
      expect(gate.calls("release")).toBe(0);
      expect(await readFile(registryPath, "utf8")).toBe(registryBefore);
      expect(await readFile(ledgerPath, "utf8").catch(() => "")).toBe(ledgerBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("R11 a run after a crash before the append completes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-resolve-r11-"));
  try {
    const ledgerDir = join(dir, "ledger-dir");
    await mkdir(ledgerDir, { recursive: true });
    const ledgerPath = join(ledgerDir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      nonTerminalPauseMs: 0,
      registryPath,
    };
    const control = createMemoryPort();
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    control.setUnreachable("laptop-a", true);
    let startError: unknown = null;
    try {
      await dispatcher.start(
        queuedItem("demo-item") as never,
        decision("demo-item", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (error: unknown) {
      startError = error;
    }
    expect(startError).toBeInstanceOf(PortUnreachableError);
    control.setUnreachable("laptop-a", false);
    await chmod(ledgerDir, 0o555);
    let firstError: unknown = null;
    try {
      await dispatcher.resolve("demo-item:0");
    } catch (error: unknown) {
      firstError = error;
    } finally {
      await chmod(ledgerDir, 0o755);
    }
    expect(firstError).toBeInstanceOf(LedgerDataError);
    expect((firstError as LedgerDataError).message).toMatch(/cannot open lock \(EACCES\)$/);
    const second = await dispatcher.resolve("demo-item:0");
    expect(second.outcome).toBe("already-resolved");
    if (second.outcome !== "already-resolved") {
      throw new Error("expected already-resolved");
    }
    expect(second.ledger).toBe("appended");
    const entries = await readRegistry(registryPath);
    expect(entries[0]?.terminal?.ledgerAppended).toBe(true);
    expect(await readPending(ledgerPath)).toHaveLength(1);
  } finally {
    await chmod(join(dir, "ledger-dir"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

interface GatedHarness {
  readonly ledgerPath: string;
  readonly registryPath: string;
  readonly control: ReturnType<typeof createMemoryPort>;
  readonly gate: ReturnType<typeof gatePort>;
  readonly dispatcher: ReturnType<typeof createDispatcher>;
  readonly clock: { now: Date };
  readonly dir: string;
}

// Yields event-loop turns while the racing operation stays quiet at the
// gate. The parked predecessor still holds the item lock, so a correct
// run exhausts the budget without a single gated call and the count
// assertion after it is deterministic; a run where the lock does not hold
// the racer back trips the count early and fails that assertion. Every
// turn yields immediately: no wall-clock wait.
async function settleWhileQuiet(
  gate: ReturnType<typeof gatePort>,
  method: GatedMethod,
  before: number,
): Promise<void> {
  for (let i = 0; i < 1000 && gate.calls(method) === before; i += 1) {
    await Bun.sleep(0);
  }
}

async function withGatedHarness(
  gated: ReadonlySet<"release" | "start" | "cancel">,
  body: (h: GatedHarness) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-resolve-j-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      nonTerminalPauseMs: 0,
      registryPath,
    };
    const control = createMemoryPort();
    const clock = { now: new Date("2026-10-27T10:00:00.000Z") };
    const gate = gatePort(control.port, new Set(gated));
    const dispatcher = createDispatcher({
      port: gate.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => clock.now,
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    await body({ ledgerPath, registryPath, control, gate, dispatcher, clock, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("J1 a start replay waits while resolve holds the lock across release", async () => {
  await withGatedHarness(
    new Set(["release", "start"]),
    async ({ gate, dispatcher, ledgerPath }) => {
      // The parked start runs the inner port (the session is bound), then
      // the reply is dropped: the dispatcher keeps a provisional with a
      // bound session, so resolve parks in port.release.
      const setupStart = dispatcher.start(
        queuedItem("demo-item") as never,
        decision("demo-item", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      const parkedSetupStart = await gate.next("start");
      await parkedSetupStart.releaseThenFail(new PortUnreachableError("host laptop-a unreachable"));
      let startError: unknown = null;
      try {
        await setupStart;
      } catch (error: unknown) {
        startError = error;
      }
      expect(startError).toBeInstanceOf(PortUnreachableError);
      const resolvePromise = dispatcher.resolve("demo-item:0");
      const parkedRelease = await gate.next("release");
      const startsBefore = gate.calls("start");
      const replayPromise = dispatcher.start(
        queuedItem("demo-item") as never,
        decision("demo-item", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      await settleWhileQuiet(gate, "start", startsBefore);
      // The replay is parked on the item lock: no port.start runs while
      // the release call is parked.
      expect(gate.calls("start")).toBe(startsBefore);
      await parkedRelease.release();
      const parkedStart = await gate.next("start");
      await parkedStart.release();
      const resolved = await resolvePromise;
      expect(resolved.outcome).toBe("resolved");
      if (resolved.outcome !== "resolved") {
        throw new Error("expected a resolved outcome");
      }
      expect(resolved.from).toBe("provisional");
      const replayed = await replayPromise;
      expect(replayed.kind).toBe("started");
      if (replayed.kind !== "started") {
        throw new Error("expected a started replay");
      }
      expect(replayed.request.requestId).toBe("demo-item:1");
      const pending = await readPending(ledgerPath);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.entryId).toBe("demo-item:demo-item:0");
    },
  );
});

test("J2 resolve waits while a start holds the lock across port.start", async () => {
  await withGatedHarness(new Set(["release", "start"]), async ({ gate, dispatcher }) => {
    const startPromise = dispatcher.start(
      queuedItem("demo-item") as never,
      decision("demo-item", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    const parkedStart = await gate.next("start");
    const resolvePromise = dispatcher.resolve("demo-item:0");
    await settleWhileQuiet(gate, "release", 0);
    // Resolve is parked on the item lock: no release runs while the
    // start call is parked.
    expect(gate.calls("release")).toBe(0);
    await parkedStart.release();
    const started = await startPromise;
    expect(started.kind).toBe("started");
    let resolveError: unknown = null;
    try {
      await resolvePromise;
    } catch (error: unknown) {
      resolveError = error;
    }
    expect(resolveError).toBeInstanceOf(DispatchStateError);
    expect((resolveError as DispatchStateError).code).toBe("request-active");
  });
});

test("J3 two racing resolves give one resolved and one already-resolved", async () => {
  await withGatedHarness(
    new Set(["release", "start"]),
    async ({ gate, dispatcher, ledgerPath }) => {
      const setupStart = dispatcher.start(
        queuedItem("demo-item") as never,
        decision("demo-item", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      const parkedSetupStart = await gate.next("start");
      await parkedSetupStart.releaseThenFail(new PortUnreachableError("host laptop-a unreachable"));
      let startError: unknown = null;
      try {
        await setupStart;
      } catch (error: unknown) {
        startError = error;
      }
      expect(startError).toBeInstanceOf(PortUnreachableError);
      const firstPromise = dispatcher.resolve("demo-item:0");
      const parkedFirst = await gate.next("release");
      const secondPromise = dispatcher.resolve("demo-item:0");
      await settleWhileQuiet(gate, "release", 1);
      // The second resolve waits on the item lock; only one release runs.
      expect(gate.calls("release")).toBe(1);
      await parkedFirst.release();
      const first = await firstPromise;
      const second = await secondPromise;
      expect(first.outcome).toBe("resolved");
      expect(second.outcome).toBe("already-resolved");
      expect(await readPending(ledgerPath)).toHaveLength(1);
    },
  );
});

test("J4 watch before and after resolve returns the same result", async () => {
  await withGatedHarness(new Set([]), async ({ control, dispatcher }) => {
    const started = await dispatcher.start(
      queuedItem("demo-item") as never,
      decision("demo-item", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    control.complete(started.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    const first = await dispatcher.watch("demo-item:0");
    expect(first.result.state).toBe("finished");
    expect(first.ledger).toBe("appended");
    const before = await dispatcher.watch("demo-item:0");
    expect(before.result).toEqual(first.result);
    expect(before.ledger).toBe("unchanged");
    const resolved = await dispatcher.resolve("demo-item:0");
    expect(resolved.outcome).toBe("resolved");
    if (resolved.outcome !== "resolved") {
      throw new Error("expected a resolved outcome");
    }
    expect(resolved.from).toBe("terminal");
    const after = await dispatcher.watch("demo-item:0");
    expect(after.result).toEqual(before.result);
    expect(after.ledger).toBe("unchanged");
  });
});

test("J5 resolve of a settled active entry leaves cancel unaffected", async () => {
  await withGatedHarness(new Set(["cancel"]), async ({ gate, dispatcher, dir }) => {
    const started = await dispatcher.start(
      queuedItem("demo-item") as never,
      decision("demo-item", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const cancelPromise = dispatcher.cancel("demo-item:0", "operator");
    const parkedCancel = await gate.next("cancel");
    const before = await readRegistry(join(dir, "registry.json"));
    let resolveError: unknown = null;
    try {
      await dispatcher.resolve("demo-item:0");
    } catch (error: unknown) {
      resolveError = error;
    }
    expect(resolveError).toBeInstanceOf(DispatchStateError);
    expect((resolveError as DispatchStateError).code).toBe("request-active");
    expect(await readRegistry(join(dir, "registry.json"))).toEqual(before);
    await parkedCancel.release();
    const cancelled = await cancelPromise;
    expect(cancelled.result.state).toBe("cancelled");
    expect(cancelled.attempt).toBe("failure");
  });
});

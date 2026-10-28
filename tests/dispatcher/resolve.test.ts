// Dispatcher resolve: an operator ends a stuck or lost request without
// guessing. A provisional entry ends lost with one ledger line; a terminal
// entry is released with no second line; failures leave the entry deep-equal.
// Deterministic: memory port, temp registry and ledger, no timers.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  readonly lostUsageCalls: UsageCall[];
  readonly dir: string;
  readonly clock: { now: Date };
}

interface HarnessOptions {
  readonly lostAfterUnreachable?: number;
  readonly failLostUsageOnce?: Error;
  readonly port?: DispatcherPort;
}

async function withHarness(options: HarnessOptions, body: (h: Harness) => Promise<void>): Promise<void> {
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
    const lostUsageCalls: UsageCall[] = [];
    let failLostUsage: Error | null = options.failLostUsageOnce ?? null;
    const dispatcher = createDispatcher({
      port: options.port ?? control.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => clock.now,
      sleep: () => Promise.resolve(),
      log: () => undefined,
      lostUsage: (requestId: string): Promise<PortUsage | null> => {
        lostUsageCalls.push({ requestId });
        if (failLostUsage !== null) {
          const error = failLostUsage;
          failLostUsage = null;
          return Promise.reject(error);
        }
        return Promise.resolve(null);
      },
    });
    await body({ ledgerPath, config, control, dispatcher, lostUsageCalls, dir, clock });
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

function failUnreachableFirst(
  control: ReturnType<typeof createMemoryPort>,
): { port: DispatcherPort; calls: { start: number } } {
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
  await withHarness({}, async ({ control, dispatcher, ledgerPath, lostUsageCalls }) => {
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
    expect(lostUsageCalls).toEqual([{ requestId: "demo-item:0" }]);
  });
});

test("R2 a provisional with a live bound session is stopped, then one line", async () => {
  const control = createMemoryPort();
  const { port } = failUnreachableFirst(control);
  await withHarness({ port }, async ({ dispatcher, ledgerPath, lostUsageCalls, dir }) => {
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
    const lines = await readPending(ledgerPath);
    expect(lines).toHaveLength(1);
    expect((lines[0] as { entryId: string }).entryId).toBe("demo-item:demo-item:0");
    expect((lines[0] as { session: { result: string } }).session.result).toBe("lost");
    expect(lostUsageCalls).toEqual([{ requestId: "demo-item:0" }]);
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
  });
});

test("R3 a watch-path lost is stopped with no second line", async () => {
  await withHarness(
    {},
    async ({ control, dispatcher, ledgerPath, lostUsageCalls, clock }) => {
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
      if (beforeEntry?.terminal === null || beforeEntry?.terminal === undefined) {
        throw new Error("expected a terminal before resolve");
      }
      expect(afterEntry?.terminal).toEqual(beforeEntry?.terminal);
      expect(afterEntry?.resolvedAt).toBe("2026-10-27T10:05:00.000Z");
      expect(afterEntry?.revision).toBe((beforeEntry?.revision ?? 0) + 1);
      expect(lostUsageCalls).toEqual([{ requestId: "demo-item:0" }]);
    },
  );
});

test("R4 a start-path lost releases its bound session", async () => {
  const control = createMemoryPort();
  const { port } = failUnreachableFirst(control);
  await withHarness(
    { lostAfterUnreachable: 1, port },
    async ({ dispatcher, ledgerPath, lostUsageCalls }) => {
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
      expect(lostUsageCalls).toHaveLength(1);
    },
  );
});

test("R5 void-incomplete keeps the entry, then resolves", async () => {
  const control = createMemoryPort();
  const { port } = failUnreachableFirst(control);
  await withHarness({ port }, async ({ dispatcher, ledgerPath, lostUsageCalls, dir }) => {
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
    expect(lostUsageCalls).toEqual([]);
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
  await withHarness({}, async ({ control, dispatcher, ledgerPath, lostUsageCalls, dir }) => {
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
    expect(lostUsageCalls).toEqual([]);
  });
});

test("R7 a settled active entry is refused", async () => {
  const { gatePort } = await import("./gated-port.js");
  await withHarness({}, async ({ control, dispatcher, dir, ledgerPath }) => {
    const started = await dispatcher.start(
      queuedItem("demo-item") as never,
      decision("demo-item", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const gate = gatePort(control.port, new Set(["release"]));
    const clock = { now: new Date("2026-10-27T10:00:00.000Z") };
    const gated = createDispatcher({
      port: gate.port,
      budget: GATE,
      ledgerPath,
      config: {
        baseBranch: "main",
        branchPrefix: "moc/",
        waitTimeoutMs: 1000,
        lostAfterUnreachable: 3,
        unreachableBackoffMs: 0,
        nonTerminalPauseMs: 0,
        registryPath: join(dir, "registry.json"),
      },
      now: () => clock.now,
      sleep: () => Promise.resolve(),
      log: () => undefined,
      lostUsage: () => Promise.resolve(null),
    });
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
      lostUsage: () => Promise.resolve(null),
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
    expect(firstError).toBeDefined();
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

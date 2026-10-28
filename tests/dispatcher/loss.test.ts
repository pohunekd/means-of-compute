// Dispatcher loss and recovery: a lost host is reported as lost, a retry
// on the same branch resumes, the unreachable threshold is exact, and a
// failed appendPending replays exactly once.
// Deterministic: memory port, in-process gate, temp ledger and registry.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeUsage } from "../../src/ledger/store.js";
import { readLedger } from "../../src/ledger/read.js";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { ModelSelection, SessionRef } from "../../src/dispatcher/port.js";
import { PortUnreachableError } from "../../src/dispatcher/port.js";

const MODEL: ModelSelection = { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" };

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

function queuedItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id: "demo-item",
    repo: "example/demo",
    title: "Demo item",
    goal: "Exercise loss and recovery",
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
    ...overrides,
  };
}

function decision(hostAlias: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId: "demo-item",
    chosenHostAlias: hostAlias,
    reason: "test decision",
    candidates: [{ hostAlias, score: 1, reason: "only host", excluded: false }],
  };
}

interface Harness {
  readonly ledgerPath: string;
  readonly config: DispatcherConfig;
  readonly control: ReturnType<typeof createMemoryPort>;
  readonly dispatcher: ReturnType<typeof createDispatcher>;
  readonly clock: { now: Date };
  readonly dir: string;
}

async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-loss-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      registryPath: join(dir, "registry.json"),
    };
    const control = createMemoryPort();
    const clock = { now: new Date("2026-10-27T10:00:00.000Z") };
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => clock.now,
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    await body({ ledgerPath, config, control, dispatcher, clock, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("host lost: watch gives lost with requestId demo-item:0", async () => {
  await withHarness(async ({ control, dispatcher, ledgerPath }) => {
    const started = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    expect(started.request.requestId).toBe("demo-item:0");
    control.pushCommit("moc/demo-item", "sha1");
    control.loseHost("laptop-a");
    const outcome = await dispatcher.watch(started.request.requestId);
    expect(outcome.result.state).toBe("lost");
    expect(outcome.attempt).toBe("lost");
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.session?.result).toBe("lost");
    expect(contents.pending[0]?.entryId).toContain("demo-item");
  });
});

test("resume: retry on the same branch resumes from origin/moc/demo-item", async () => {
  await withHarness(async ({ control, dispatcher }) => {
    const first = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (first.kind !== "started") {
      throw new Error("expected a started session");
    }
    control.pushCommit("moc/demo-item", "sha1");
    control.loseHost("laptop-a");
    await dispatcher.watch(first.request.requestId);
    const retry = await dispatcher.start(
      queuedItem({ branch: "moc/demo-item" }) as never,
      decision("laptop-b") as never,
      MODEL,
      "Do the work.",
    );
    if (retry.kind !== "started") {
      throw new Error("expected a resumed session");
    }
    expect(retry.request.requestId).toBe("demo-item:1");
    expect(retry.request.resume).toBe(true);
    expect(retry.request.baseRef).toBe("origin/moc/demo-item");
    expect(retry.handle.baseCommit).toBe("sha1");
  });
});

test("unreachable: miss, miss, running, miss recovers as finished", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-unreach-seq-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      registryPath: join(dir, "registry.json"),
    };
    const control = createMemoryPort();
    let calls = 0;
    const flaky = {
      ...control.port,
      wait(
        ref: SessionRef,
        timeoutMs: number,
        cursor: string | null,
      ): ReturnType<typeof control.port.wait> {
        calls += 1;
        if (calls <= 2 || calls === 4) {
          return Promise.reject(new PortUnreachableError("host unreachable"));
        }
        if (calls === 3) {
          return Promise.resolve({ state: "running" as const, sessionId: ref.sessionId, cursor });
        }
        return control.port.wait(ref, timeoutMs, cursor);
      },
    };
    const dispatcher = createDispatcher({
      port: flaky,
      budget: GATE,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    const started = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
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
    const outcome = await dispatcher.watch(started.request.requestId);
    expect(outcome.result.state).toBe("finished");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unreachable: two misses recover, the third is lost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-unreach-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      registryPath: join(dir, "registry.json"),
    };
    const control = createMemoryPort();
    let calls = 0;
    const flaky = {
      ...control.port,
      wait(
        ref: SessionRef,
        timeoutMs: number,
        cursor: string | null,
      ): ReturnType<typeof control.port.wait> {
        calls += 1;
        if (calls <= 2) {
          return Promise.reject(new PortUnreachableError("host unreachable"));
        }
        return control.port.wait(ref, timeoutMs, cursor);
      },
    };
    const dispatcher = createDispatcher({
      port: flaky,
      budget: GATE,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    const started = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
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
    const outcome = await dispatcher.watch(started.request.requestId);
    expect(outcome.result.state).toBe("finished");

    const control2 = createMemoryPort();
    const alwaysLost = {
      ...control2.port,
      wait(): ReturnType<typeof control2.port.wait> {
        return Promise.reject(new PortUnreachableError("host unreachable"));
      },
    };
    // The start (insert and settle reads) sees 10:00:00 and every later
    // read sees 10:00:30: a finishLost that reset lastSeenAt to the
    // observation time would stamp 10:00:30 with seconds 30 instead of 0.
    const clock2 = { reads: 0 };
    const dispatcher2 = createDispatcher({
      port: alwaysLost,
      budget: GATE,
      ledgerPath: join(dir, "ledger2.jsonl"),
      config: { ...config, registryPath: join(dir, "registry2.json") },
      now: () => {
        clock2.reads += 1;
        return clock2.reads <= 2
          ? new Date("2026-10-27T10:00:00.000Z")
          : new Date("2026-10-27T10:00:30.000Z");
      },
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    const started2 = await dispatcher2.start(
      queuedItem() as never,
      decision("laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started2.kind !== "started") {
      throw new Error("expected a started session");
    }
    const lost = await dispatcher2.watch(started2.request.requestId);
    expect(lost.result.state).toBe("lost");
    if (lost.result.state === "lost") {
      expect(lost.result.detail).toBe("unreachable 3 times");
    }
    // A synthesized lost keeps the last observation and stores the
    // final unreachable count: setup observed nothing after the
    // 10:00:00 start, and the third miss ends the session.
    const { readRegistry } = await import("../../src/dispatcher/registry.js");
    const entries = await readRegistry(join(dir, "registry2.json"));
    const entry = entries.find((candidate) => candidate.requestId === started2.request.requestId);
    expect(entry?.lastSeenAt).toBe("2026-10-27T10:00:00.000Z");
    expect(entry?.unreachableCount).toBe(3);
    expect(entry?.terminal?.seconds).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch replay after a failed appendPending writes exactly one pending entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-replay-"));
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
      queuedItem() as never,
      decision("laptop-a") as never,
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
    let firstError: unknown;
    try {
      await dispatcher.watch(started.request.requestId);
    } catch (err) {
      firstError = err;
    }
    expect(firstError).toBeDefined();
    await chmod(ledgerDir, 0o755);
    await chmod(blockedPath, 0o644);
    const outcome = await dispatcher.watch(started.request.requestId);
    expect(outcome.result.state).toBe("finished");
    const contents = await readLedger("Test ledger", blockedPath);
    expect(contents.pending).toHaveLength(1);
    const again = await dispatcher.watch(started.request.requestId);
    expect(again.ledger).toBe("unchanged");
    const contents2 = await readLedger("Test ledger", blockedPath);
    expect(contents2.pending).toHaveLength(1);
  } finally {
    await chmod(join(dir, "ledger-dir"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("replay after a crash between append and write returns unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-replay-crash-"));
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
    const clock = { now: new Date("2026-10-27T10:01:00.000Z") };
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => clock.now,
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    const started = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
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
    const outcome = await dispatcher.watch(started.request.requestId);
    expect(outcome.result.state).toBe("finished");
    // Crash between appendPending and the second registry write: the
    // pending line stays while the entry claims ledgerAppended false.
    // The revision bump keeps the manual clear valid: without it the
    // replay would hit the stale-revision check below.
    const { readRegistry } = await import("../../src/dispatcher/registry.js");
    const entries = await readRegistry(registryPath);
    const entry = entries.find((candidate) => candidate.requestId === started.request.requestId);
    if (entry === undefined || entry.terminal === null) {
      throw new Error("expected a terminal entry");
    }
    const cleared = {
      ...entry,
      revision: entry.revision + 1,
      terminal: { ...entry.terminal, ledgerAppended: false },
    };
    // Crash between appendPending and the second registry write: the
    // pending line stays while the entry claims ledgerAppended false.
    // A direct file rewrite keeps the cleared revision without tripping
    // the stale-revision check below.
    const { writeFile } = await import("node:fs/promises");
    const document = {
      sessions: entries.map((candidate) =>
        candidate.requestId === cleared.requestId ? cleared : candidate,
      ),
    };
    await writeFile(registryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    clock.now = new Date("2026-10-27T10:09:00.000Z");
    // Crash between appendPending and the second registry write: the
    // pending line stays while the entry claims ledgerAppended false.
    // The terminal content differs only by the flag, so the append is
    // an identical rewrite of the same row and the flag flips back.
    const replayed = await dispatcher.watch(started.request.requestId);
    // The stored finishedAt wins over the clock: the pending line is the
    // same entry, so the replay reports unchanged and flips the flag
    // back without a duplicate row.
    expect(replayed.ledger).toBe("unchanged");
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.finishedAt).toBe(entry.terminal.observedAt);
    // The flag moves back to true on the next revision; the observed
    // content is unchanged.
    const stored = await readRegistry(registryPath);
    const storedEntry = stored.find(
      (candidate) => candidate.requestId === started.request.requestId,
    );
    expect(storedEntry?.terminal?.ledgerAppended).toBe(true);
    expect(storedEntry?.terminal?.observedAt).toBe(entry.terminal.observedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a start on an unappended terminal asks for watch first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-unappended-"));
  try {
    const ledgerDir = join(dir, "ledger-dir");
    await mkdir(ledgerDir, { recursive: true });
    const ledgerPath = join(ledgerDir, "ledger.jsonl");
    await writeFile(ledgerPath, "", "utf8");
    await chmod(ledgerPath, 0o444);
    await chmod(ledgerDir, 0o555);
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
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,

      lostUsage: () => Promise.resolve(null),
    });
    const started = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
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
    let firstError: unknown;
    try {
      await dispatcher.watch(started.request.requestId);
    } catch (err) {
      firstError = err;
    }
    expect(firstError).toBeDefined();
    // The terminal hit cannot start another attempt: watch must
    // append the pending line first.
    let startError: unknown;
    try {
      await dispatcher.start(
        queuedItem() as never,
        decision("laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (err) {
      startError = err;
    }
    const { DispatchStateError } = await import("../../src/dispatcher/dispatcher.js");
    expect(startError).toBeInstanceOf(DispatchStateError);
    expect((startError as { code: string }).code).toBe("request-unappended");
    expect((startError as { requestId: string }).requestId).toBe("demo-item:0");
    await chmod(ledgerDir, 0o755);
    await chmod(ledgerPath, 0o644);
    const outcome = await dispatcher.watch(started.request.requestId);
    expect(outcome.ledger).toBe("appended");
    const next = await dispatcher.start(
      queuedItem({ branch: "moc/demo-item" }) as never,
      decision("laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (next.kind !== "started") {
      throw new Error("expected the next attempt to start");
    }
    expect(next.request.requestId).toBe("demo-item:1");
  } finally {
    await chmod(join(dir, "ledger-dir"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a terminal hit whose ledger line is missing throws request-ledger-mismatch", async () => {
  await withHarness(async ({ control, dispatcher, ledgerPath, dir }) => {
    const started = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
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
    const outcome = await dispatcher.watch(started.request.requestId);
    expect(outcome.ledger).toBe("appended");
    // Drop the ledger line while the registry keeps the appended
    // terminal: the data guard must refuse to hand back a session
    // the ledger cannot account for.
    await writeFile(ledgerPath, "", "utf8");
    let startError: unknown;
    try {
      await dispatcher.start(
        queuedItem() as never,
        decision("laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (err) {
      startError = err;
    }
    const { DispatchStateError } = await import("../../src/dispatcher/dispatcher.js");
    expect(startError).toBeInstanceOf(DispatchStateError);
    expect((startError as { code: string }).code).toBe("request-ledger-mismatch");
    expect((startError as { requestId: string }).requestId).toBe("demo-item:0");
    expect(dir.length).toBeGreaterThan(0);
  });
});

test("no replay after finalize: watch returns unchanged and skips the ledger", async () => {
  await withHarness(async ({ control, dispatcher, ledgerPath }) => {
    const started = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    control.complete(started.handle.sessionId, {
      state: "finished",
      usage: {
        tokens: [
          {
            provider: "nvidia-build",
            model: "meta/muse-glimmer-30b",
            inputTokens: 10,
            outputTokens: 20,
            requests: 1,
            source: "metering-proxy",
          },
        ],
      },
      detail: "exited 0",
    });
    const outcome = await dispatcher.watch(started.request.requestId);
    expect(outcome.result.state).toBe("finished");
    expect(outcome.ledger).toBe("appended");
    await finalizeUsage(ledgerPath, {
      workItemId: "demo-item",
      result: "success",
      retries: 0,
      humanInterventions: 0,
    });
    const watchOnlyPort = { ...control.port };
    expect(typeof watchOnlyPort.wait).toBe("function");
    const again = await dispatcher.watch(started.request.requestId);
    expect(again.ledger).toBe("unchanged");
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(0);
    expect(contents.records).toHaveLength(1);
  });
});

test("lost calls lostUsage before the registry write", async () => {
  // The hook reads the registry inside itself through a fresh instance:
  // the terminal is still null while the hook runs, so the meter
  // settles before the first registry write.
  const dir = await mkdtemp(join(tmpdir(), "dispatch-lost-hook-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      registryPath: join(dir, "registry.json"),
    };
    const control = createMemoryPort();
    const { readRegistry } = await import("../../src/dispatcher/registry.js");
    let terminalAtHook: unknown = "not-called";
    let revisionAtHook = -1;
    let hookRequestId = "";
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      lostUsage: async (requestId: string) => {
        hookRequestId = requestId;
        const entries = await readRegistry(join(dir, "registry.json"));
        const seen = entries.find((e) => e.requestId === requestId);
        terminalAtHook = seen?.terminal ?? null;
        revisionAtHook = seen?.revision ?? -1;
        return null;
      },
    });
    const started = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    expect(hookRequestId).toBe("");
    control.setUnreachable("laptop-a", true);
    const outcome = await dispatcher.watch(started.request.requestId);
    expect(outcome.result.state).toBe("lost");
    expect(hookRequestId).toBe(started.request.requestId);
    // The first registry write of the terminal bumps the revision by
    // one from the last persisted value, so a hook that runs before it
    // still sees the old revision with no terminal.
    expect(terminalAtHook).toBeNull();
    expect(revisionAtHook).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a provisional lost calls lostUsage with its requestId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-lost-prov-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 1,
      unreachableBackoffMs: 0,
      registryPath: join(dir, "registry.json"),
    };
    const control = createMemoryPort();
    control.setUnreachable("laptop-a", true);
    const seen: string[] = [];
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      lostUsage: (requestId: string) => {
        seen.push(requestId);
        return Promise.resolve(null);
      },
    });
    const outcome = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (outcome.kind !== "lost") {
      throw new Error("expected a lost start");
    }
    expect(seen).toEqual(["demo-item:0"]);
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.entryId).toBe("demo-item:demo-item:0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid lost usage is stored as null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-lost-invalid-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 1,
      unreachableBackoffMs: 0,
      registryPath: join(dir, "registry.json"),
    };
    const control = createMemoryPort();
    control.setUnreachable("laptop-a", true);
    const events: Array<Record<string, unknown>> = [];
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
      lostUsage: () => Promise.resolve({ tokens: [] }),
    });
    const outcome = await dispatcher.start(
      queuedItem() as never,
      decision("laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    if (outcome.kind !== "lost") {
      throw new Error("expected a lost start");
    }
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.tokens).toEqual([
      {
        provider: "nvidia-build",
        model: "meta/muse-glimmer-30b",
        inputTokens: null,
        outputTokens: null,
        requests: null,
        source: "usage-invalid",
      },
    ]);
    expect(events.filter((e) => e["event"] === "usage-invalid")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

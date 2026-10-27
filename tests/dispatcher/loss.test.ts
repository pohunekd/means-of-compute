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
    const dispatcher2 = createDispatcher({
      port: alwaysLost,
      budget: GATE,
      ledgerPath: join(dir, "ledger2.jsonl"),
      config: { ...config, registryPath: join(dir, "registry2.json") },
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
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

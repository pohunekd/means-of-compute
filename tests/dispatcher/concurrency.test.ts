// Dispatcher concurrency: the keyed registry writes and the per-request
// lock keep concurrent operations from losing each other's updates.
// Deterministic: memory port, in-process gate, temp ledger and registry.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import { readRegistry } from "../../src/dispatcher/registry.js";
import type { ModelSelection } from "../../src/dispatcher/port.js";
import { readLedger } from "../../src/ledger/read.js";

const MODEL: ModelSelection = { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" };

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

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
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
    });
    await body({ ledgerPath, registryPath, config, control, dispatcher });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("concurrent watches on two completed sessions keep both terminals", async () => {
  await withHarness(async ({ control, dispatcher, ledgerPath, registryPath }) => {
    const first = await dispatcher.start(item("item-a") as never, decision("item-a", "laptop-a") as never, MODEL, "Do the work.");
    const second = await dispatcher.start(item("item-b") as never, decision("item-b", "laptop-b") as never, MODEL, "Do the work.");
    if (first.kind !== "started" || second.kind !== "started") {
      throw new Error("expected two started sessions");
    }
    control.complete(first.handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
    control.complete(second.handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
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
    const first = await dispatcher.start(item("item-a") as never, decision("item-a", "laptop-a") as never, MODEL, "Do the work.");
    if (first.kind !== "started") {
      throw new Error("expected a started session");
    }
    control.complete(first.handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
    const [watched, second] = await Promise.all([
      dispatcher.watch(first.request.requestId),
      dispatcher.start(item("item-b") as never, decision("item-b", "laptop-b") as never, MODEL, "Do the work."),
    ]);
    expect(watched.result.state).toBe("finished");
    if (second.kind !== "started") {
      throw new Error("expected the second session to start");
    }
    const entries = await readRegistry(registryPath);
    expect(entries.map((entry) => entry.requestId).sort()).toEqual(["item-a:0", "item-b:0"]);
    expect(second.request.requestId).toBe("item-b:0");
    control.complete(second.handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
    const follow = await dispatcher.watch(second.request.requestId);
    expect(follow.result.state).toBe("finished");
  });
});

test("two concurrent watches on one completed session append exactly once", async () => {
  await withHarness(async ({ control, dispatcher, ledgerPath }) => {
    const started = await dispatcher.start(item("item-a") as never, decision("item-a", "laptop-a") as never, MODEL, "Do the work.");
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    control.complete(started.handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
    const [first, second] = await Promise.all([
      dispatcher.watch(started.request.requestId),
      dispatcher.watch(started.request.requestId),
    ]);
    expect(first.result.state).toBe("finished");
    expect(second.result.state).toBe("finished");
    const ledgers = [first.ledger, second.ledger].sort();
    expect(ledgers).toEqual(["appended", "unchanged"]);
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
  });
});

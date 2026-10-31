import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher, DispatchStateError } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { ModelSelection, StartRequest } from "../../src/dispatcher/port.js";
import { readRegistry } from "../../src/dispatcher/registry.js";

const MODEL: ModelSelection = { providerId: "meta-api", model: "muse-spark-1.3-contributor" };

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
    goal: "Exercise worktree uniqueness",
    issue: 20,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: {
      preferredModel: "muse-spark-1.3-contributor",
      attempts: 0,
      fallbackUsed: false,
    },
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

function configOf(registryPath: string, lostAfterUnreachable = 3): DispatcherConfig {
  return {
    baseBranch: "main",
    branchPrefix: "moc/",
    waitTimeoutMs: 1000,
    lostAfterUnreachable,
    unreachableBackoffMs: 0,
    nonTerminalPauseMs: 0,
    registryPath,
  };
}

test("worktree is refused when held by a live session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-worktree-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const events: Array<Record<string, unknown>> = [];
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
      settleUsage: () => Promise.resolve(null),
    });

    const first = await dispatcher.start(
      item("wt-a") as never,
      decision("wt-a", "host-a") as never,
      MODEL,
      "Do the work.",
    );
    if (first.kind !== "started") {
      throw new Error(`expected the first start, got ${first.kind}`);
    }
    const wtAHandle = first.handle;

    const wrapperPort = {
      ...control.port,
      start: async (request: StartRequest) => {
        const handle = await control.port.start(request);
        // Force the handle to use the worktree held by wt-a
        return { ...handle, worktree: wtAHandle.worktree };
      },
    };

    const dispatcher2 = createDispatcher({
      port: wrapperPort,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date("2026-10-27T10:01:00.000Z"),
      sleep: () => Promise.resolve(),
      log: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
      settleUsage: () => Promise.resolve(null),
    });

    let error: unknown;
    try {
      await dispatcher2.start(
        item("wt-b") as never,
        decision("wt-b", "host-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(DispatchStateError);
    const dsError = error as DispatchStateError;
    expect(dsError.code).toBe("invalid-handle");

    const invalidEvent = events.find(
      (e) => e.event === "invalid-handle" && e.requestId === "wt-b:0",
    );
    expect(invalidEvent).toBeDefined();
    expect(invalidEvent?.detail).toBe("worktree-unique");

    const reg = await readRegistry(registryPath);
    const matching = reg.filter((e) => e.sessionId !== null && e.worktree === wtAHandle.worktree);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.requestId).toBe("wt-a:0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

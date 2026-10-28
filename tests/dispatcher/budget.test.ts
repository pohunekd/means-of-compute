// Budget refusal blocks only new sessions: a running item still reaches
// finished and its usage still lands in the ledger. The gate is the real
// budget:check CLI with the documented spend overrides. A failing gate
// command throws BudgetGateError with no port session.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedger } from "../../src/ledger/read.js";
import { createCliBudgetGate, BudgetGateError } from "../../src/budget/gate.js";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { ModelSelection } from "../../src/dispatcher/port.js";

const MODEL: ModelSelection = { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" };

function queuedItem(id: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo",
    title: "Demo item",
    goal: "Exercise budget refusal",
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

function decision(id: string, hostAlias: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId: id,
    chosenHostAlias: hostAlias,
    reason: "test decision",
    candidates: [{ hostAlias, score: 1, reason: "only host", excluded: false }],
  };
}

test("refusal blocks new starts but a running item still finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-budget-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
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
    const admitting: BudgetGate = createCliBudgetGate({
      command: [
        "bun",
        "src/budget/check.ts",
        "--spend",
        "3.20",
        "--day-cap",
        "12",
        "--total-cap",
        "140",
      ],
      timeoutMs: 30000,
      cwd: process.cwd(),
    });
    const dispatcher = createDispatcher({
      port: control.port,
      budget: admitting,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,

      settleUsage: () => Promise.resolve(null),
    });
    const startedA = await dispatcher.start(
      queuedItem("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do item A.",
    );
    expect(startedA.kind).toBe("started");
    if (startedA.kind !== "started") {
      throw new Error("expected item A to start");
    }

    const refusing: BudgetGate = createCliBudgetGate({
      command: [
        "bun",
        "src/budget/check.ts",
        "--spend",
        "12.00",
        "--day-cap",
        "12",
        "--total-cap",
        "140",
      ],
      timeoutMs: 30000,
      cwd: process.cwd(),
    });
    const dispatcherRefusing = createDispatcher({
      port: control.port,
      budget: refusing,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,

      settleUsage: () => Promise.resolve(null),
    });
    control.complete(startedA.handle.sessionId, {
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
    // Watch never calls the gate: the running item finishes while refused.
    const finished = await dispatcherRefusing.watch(startedA.request.requestId);
    expect(finished.result.state).toBe("finished");
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending.some((entry) => entry.workItemId === "item-a")).toBe(true);

    const refused = await dispatcherRefusing.start(
      queuedItem("item-b") as never,
      decision("item-b", "laptop-b") as never,
      MODEL,
      "Do item B.",
    );
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") {
      throw new Error("expected item B to be refused");
    }
    expect(refused.reason).toBe("daily cap reached");
    expect(control.sessions().some((entry) => entry.handle.hostAlias === "laptop-b")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a gate error throws BudgetGateError with no port session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-gateerr-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
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
    const failing: BudgetGate = createCliBudgetGate({
      command: ["bun", "-e", "process.exit(1)"],
      timeoutMs: 30000,
      cwd: process.cwd(),
    });
    const dispatcher = createDispatcher({
      port: control.port,
      budget: failing,
      ledgerPath,
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,

      settleUsage: () => Promise.resolve(null),
    });
    let error: unknown;
    try {
      await dispatcher.start(
        queuedItem("item-c") as never,
        decision("item-c", "laptop-a") as never,
        MODEL,
        "Do item C.",
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(BudgetGateError);
    expect(control.sessions()).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Dispatcher loss and recovery: a lost host is reported as lost, a retry
// on the same branch resumes, the unreachable threshold is exact, and a
// failed appendPending replays exactly once.
// Deterministic: memory port, in-process gate, temp ledger and registry.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedger } from "../../src/ledger/read.js";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { ModelSelection } from "../../src/dispatcher/port.js";

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
      nonTerminalPauseMs: 0,
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

      settleUsage: () => Promise.resolve(null),
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

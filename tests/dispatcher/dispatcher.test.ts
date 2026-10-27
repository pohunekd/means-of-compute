// Dispatcher start preconditions and unknown-usage pending entries.
// Deterministic: memory port, in-process gate stub, temp ledger and
// registry. Each precondition case names the predicate it guards, so
// removing that check fails the case.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { ModelSelection } from "../../src/dispatcher/port.js";
import { readLedger } from "../../src/ledger/read.js";

const CONFIG: DispatcherConfig = {
  baseBranch: "main",
  branchPrefix: "moc/",
  waitTimeoutMs: 1000,
  lostAfterUnreachable: 3,
  unreachableBackoffMs: 0,
  registryPath: "",
};

const MODEL: ModelSelection = { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" };

function queuedItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id: "demo-item",
    repo: "example/demo",
    title: "Demo item",
    goal: "Exercise the dispatcher preconditions",
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

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId: "demo-item",
    chosenHostAlias: "laptop-a",
    reason: "test decision",
    candidates: [{ hostAlias: "laptop-a", score: 1, reason: "only host", excluded: false }],
    ...overrides,
  };
}

const ADMIT_GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

interface DispatcherHarness {
  readonly config: DispatcherConfig;
  readonly ledgerPath: string;
}

async function withHarness(body: (harness: DispatcherHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-pre-"));
  const config: DispatcherConfig = { ...CONFIG, registryPath: join(dir, "registry.json") };
  const ledgerPath = join(dir, "ledger.jsonl");
  try {
    await body({ config, ledgerPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function testDispatcher(ledgerPath: string): ReturnType<typeof createDispatcher> {
  const control = createMemoryPort();
  return createDispatcher({
    port: control.port,
    budget: ADMIT_GATE,
    ledgerPath,
    config: { ...CONFIG, registryPath: join(tmpdir(), "unused-registry.json") },
    now: () => new Date("2026-10-27T10:00:00.000Z"),
    sleep: () => Promise.resolve(),
    log: () => undefined,
  });
}

test("precondition 2.1.2: a decision for another item throws", async () => {
  await withHarness(async ({ ledgerPath }) => {
    const dispatcher = testDispatcher(ledgerPath);
    let error: unknown;
    try {
      await dispatcher.start(
        queuedItem() as never,
        decision({ workItemId: "other-item" }) as never,
        MODEL,
        "brief",
      );
    } catch (err) {
      error = err;
    }
    expect((error as Error).message).toContain("work-item-match");
  });
});

test("precondition 2.1.3: a decision without a chosen host throws", async () => {
  const dispatcher = testDispatcher(join(tmpdir(), "unused-ledger.jsonl"));
  let error: unknown;
  try {
    await dispatcher.start(
      queuedItem() as never,
      decision({ chosenHostAlias: null }) as never,
      MODEL,
      "brief",
    );
  } catch (err) {
    error = err;
  }
  expect((error as Error).message).toContain("host-chosen");
});

test("precondition 2.1.4: a non-queued item throws", async () => {
  const dispatcher = testDispatcher(join(tmpdir(), "unused-ledger.jsonl"));
  let error: unknown;
  try {
    await dispatcher.start(
      queuedItem({ status: "running" }) as never,
      decision() as never,
      MODEL,
      "brief",
    );
  } catch (err) {
    error = err;
  }
  expect((error as Error).message).toContain("item-queued");
});

test("precondition 2.1.5: a missing provider descriptor throws", async () => {
  const dispatcher = testDispatcher(join(tmpdir(), "unused-ledger.jsonl"));
  let error: unknown;
  try {
    await dispatcher.start(
      queuedItem() as never,
      decision() as never,
      { providerId: "no-such-provider", model: "x" },
      "brief",
    );
  } catch (err) {
    error = err;
  }
  expect((error as Error).message).toContain("model-provider");
});

test("unknown usage becomes an unknown-requests pending token, never zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-usage-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const dispatcher = createDispatcher({
      port: control.port,
      budget: ADMIT_GATE,
      ledgerPath,
      config: { ...CONFIG, registryPath },
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
    });
    const started = await dispatcher.start(
      queuedItem() as never,
      decision() as never,
      MODEL,
      "Do the work.",
    );
    if (started.kind !== "started") {
      throw new Error("expected a started session");
    }
    const request = started.request;
    control.complete(started.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    const outcome = await dispatcher.watch(request.requestId);
    expect(outcome.result.state).toBe("finished");
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    const pending = contents.pending[0];
    if (pending === undefined) {
      throw new Error("expected one pending entry");
    }
    expect(pending.tokens).toHaveLength(1);
    expect(pending.tokens[0]?.requests).toBeNull();
    expect(pending.tokens[0]?.source).toBe("usage-unreported");
    expect(pending.session?.result).toBe("success");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

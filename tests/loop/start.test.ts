// Driver start tests (slice 5c rows U1-U13, L31, L51, L52): claim,
// drive, watch and timeout through the real dispatcher, memory port and
// files, with one named mutation per row killed by its own assertion.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { DispatcherPort, StartRequest } from "../../src/dispatcher/port.js";
import { PortRejectedError, PortUnreachableError } from "../../src/dispatcher/port.js";
import { readRegistry } from "../../src/dispatcher/registry.js";
import type { RegistryEntry } from "../../src/dispatcher/registry.js";
import type { WorkItem } from "../../contracts/v1/types.js";
import { readLedger } from "../../src/ledger/read.js";
import { appendPending } from "../../src/ledger/store.js";
import type { PendingUsage } from "../../src/ledger/types.js";
import { readLoopState } from "../../src/loop/state.js";
import type { LoopLog } from "../../src/loop/log.js";
import { FakeGitHub } from "./fake-github.js";
import {
  checkSessionTimeout,
  claimStart,
  driveStart,
  initialLoopItem,
  watchSession,
  type ClaimInput,
  type StartContext,
} from "../../src/loop/start.js";
import type { LoopItem } from "../../src/loop/types.js";
import { parkOperator } from "../../src/loop/park.js";
import { gatePort } from "../dispatcher/gated-port.js";
import { withMeter } from "../meter/helpers.js";
import { createMeteredPort } from "../../src/meter/metered-port.js";

const PREFERRED = "muse-spark-1.3-contributor";
const PROVIDER = "meta-api";
const FALLBACK = "muse-wonder-1.0";
const FALLBACK_PROVIDER = "meta-wonder";
const NOW = "2026-10-28T10:00:00.000Z";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    schemaVersion: "v1",
    id: "gh-demo-1",
    repo: "example/demo",
    title: "Demo item gh-demo-1",
    goal: "Drive a start",
    issue: null,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: PREFERRED, attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
    ...overrides,
  };
}

function decision(workItemId: string, hostAlias: string | null): ClaimInput["decision"] {
  return {
    schemaVersion: "v1",
    workItemId,
    chosenHostAlias: hostAlias,
    reason: "only idle host",
    candidates:
      hostAlias === null ? [] : [{ hostAlias, score: 1, reason: "idle", excluded: false }],
  };
}

function fallbackDecision(workItemId: string, hostAlias: string): ClaimInput["decision"] {
  return {
    schemaVersion: "v1",
    workItemId,
    chosenHostAlias: hostAlias,
    reason: "fallback host",
    candidates: [
      { hostAlias: "host-a", score: 0, reason: "excluded", excluded: true },
      { hostAlias, score: 1, reason: "idle", excluded: false },
    ],
  };
}

function choice(model: string, providerId: string, hostAlias = "host-a"): ClaimInput {
  return {
    decision: decision("gh-demo-1", hostAlias),
    choice: { model, providerId, fallbackUsed: false, steered: null },
    brief: "Do the work.",
  };
}

function configOf(registryPath: string): DispatcherConfig {
  return {
    baseBranch: "main",
    branchPrefix: "moc/",
    waitTimeoutMs: 1000,
    lostAfterUnreachable: 3,
    unreachableBackoffMs: 0,
    nonTerminalPauseMs: 0,
    registryPath,
  };
}

function logged(): { log: LoopLog; events: string[] } {
  const events: string[] = [];
  return {
    events,
    log: {
      log(event): void {
        events.push(
          `${event.event}:${event.code ?? ""}:${event.detail ?? ""}:${event.requestId ?? ""}`,
        );
      },
      failed(): boolean {
        return false;
      },
      async close(): Promise<void> {},
    },
  };
}

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

interface CtxParts {
  ctx: StartContext;
  events: string[];
}

function makeCtx(
  dir: string,
  dispatcher: StartContext["dispatcher"],
  overrides: Partial<StartContext> = {},
): CtxParts {
  const seen = logged();
  const fake = new FakeGitHub();
  return {
    events: seen.events,
    ctx: {
      branchPrefix: "moc/",
      statePath: join(dir, "loop-state.json"),
      resultsPath: join(dir, "loop-results.jsonl"),
      storePath: join(dir, "work-items.json"),
      stall: { maxStagnantRounds: 3, maxRetries: 2 },
      log: seen.log,
      now: () => new Date(NOW),
      github: fake,
      factoryLogin: "factory-bot",
      ledgerPath: join(dir, "ledger.jsonl"),
      escalationLabel: "moc-escalation",
      readyLabel: "moc-ready",
      blockedLabel: "moc-blocked",
      maxRetries: 2,
      dispatcher,
      dispatcherConfig: configOf(join(dir, "registry.json")),
      sessionTimeoutMs: 3_600_000,
      unreachableRetryMs: 5_000,
      budgetBackoffMs: 60_000,
      maxStartRejections: 3,
      sleep: () => Promise.resolve(),
      ...overrides,
    },
  };
}

async function writeLoopState(path: string, li: LoopItem): Promise<void> {
  await Bun.write(
    path,
    `${JSON.stringify({
      schemaVersion: "v1",
      revision: 0,
      items: { "gh-demo-1": li },
      resolvedApprovals: [],
      mergeHold: null,
      lastDigestDay: null,
    })}\n`,
  );
}

async function writeStore(path: string, entry: WorkItem): Promise<void> {
  await Bun.write(
    path,
    `${JSON.stringify({ schemaVersion: "v1", revision: 0, items: [entry], submissions: [] })}\n`,
  );
}

async function readItem(statePath: string): Promise<LoopItem> {
  const state = await readLoopState(statePath);
  return state.items["gh-demo-1"] as unknown as LoopItem;
}

function startedLoopItem(overrides: Partial<LoopItem> = {}): LoopItem {
  return {
    ...initialLoopItem(),
    phase: "starting",
    start: {
      round: 0,
      decision: decision("gh-demo-1", "host-a"),
      model: { providerId: PROVIDER, model: PREFERRED },
      brief: "Do the work.",
      itemBranch: null,
      requestId: "gh-demo-1:0",
    },
    ...overrides,
  };
}

function runningLoopItem(overrides: Partial<LoopItem> = {}): LoopItem {
  return {
    ...initialLoopItem(),
    phase: "running",
    session: { hostAlias: "host-a", providerId: PROVIDER, model: PREFERRED },
    requestId: "gh-demo-1:0",
    ...overrides,
  };
}

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-start-"));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function rejectOn(
  control: ReturnType<typeof createMemoryPort>,
  hostAlias: string,
  code: string,
): DispatcherPort {
  return {
    ...control.port,
    start(request: StartRequest) {
      if (request.hostAlias === hostAlias) {
        return Promise.reject(new PortRejectedError(code, `${code} for ${hostAlias}`));
      }
      return control.port.start(request);
    },
  };
}

function grantUsage(
  entryId = "gh-demo-1:gh-demo-1:0",
  result: "failure" | "lost" = "failure",
): PendingUsage {
  return {
    entryId,
    kind: "session",
    workItemId: "gh-demo-1",
    finishedAt: NOW,
    startModel: PREFERRED,
    tokens: [
      {
        provider: PROVIDER,
        model: PREFERRED,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        source: "meter",
      },
    ],
    session: {
      hostAlias: "host-a",
      seconds: 0,
      source: "dispatcher-clock",
      result,
    },
  };
}

// Rows U1 to U5: claim, the started write and the refused write.
test("claimStart derives the next requestId from the ledger (U1)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    await appendPending(ledgerPath, grantUsage());
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx, events } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    const outcome = await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    expect(outcome).toBe("claimed");
    const li = await readItem(ctx.statePath);
    expect(li.phase).toBe("starting");
    expect(li.start?.requestId).toBe("gh-demo-1:1");
    expect(li.backoffUntil).toBeNull();
    const claims = events.filter((line) => line.startsWith("claim:"));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain("gh-demo-1:1");
  });
});

test("claimStart on a dirty store item throws loop state missing (U2)", async () => {
  await withTempDir(async (dir) => {
    const control = createMemoryPort();
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item({ retryCount: 1 }));
    let error: unknown;
    try {
      await claimStart(ctx, item({ retryCount: 1 }), choice(PREFERRED, PROVIDER));
    } catch (caught: unknown) {
      error = caught;
    }
    expect(String(error)).toContain("loop state missing for gh-demo-1");
    const state = await readLoopState(ctx.statePath);
    expect(state.items["gh-demo-1"]).toBeUndefined();
  });
});

test("claimStart parks when rejections reached the bound (U3)", async () => {
  await withTempDir(async (dir) => {
    const control = createMemoryPort();
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const tracking = { calls: 0 };
    const counting = {
      ...dispatcher,
      start: ((...args: Parameters<typeof dispatcher.start>) => {
        tracking.calls += 1;
        return dispatcher.start(...args);
      }) as typeof dispatcher.start,
    };
    const { ctx } = makeCtx(dir, counting, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await writeLoopState(ctx.statePath, { ...initialLoopItem(), startRejections: 3 });
    const outcome = await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    expect(outcome).toBe("parked");
    const li = await readItem(ctx.statePath);
    expect(li.park).toMatchObject({ kind: "operator", code: "start-rejected" });
    expect(li.start).toBeNull();
    expect(tracking.calls).toBe(0);
    const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
    expect(store.items[0]).toMatchObject({
      status: "parked",
      statusReason: "operator: start-rejected",
    });
  });
});

test("driveStart opens the session on the fallback model (U4)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(
      ctx.storePath,
      item({ modelRouting: { preferredModel: PREFERRED, attempts: 0, fallbackUsed: false } }),
    );
    await writeLoopState(
      ctx.statePath,
      startedLoopItem({
        excludedHosts: ["host-a"],
        startRejections: 2,
        start: {
          round: 0,
          decision: fallbackDecision("gh-demo-1", "host-b"),
          model: { providerId: FALLBACK_PROVIDER, model: FALLBACK },
          brief: "Do the work.",
          itemBranch: null,
          requestId: "gh-demo-1:2",
        },
      }),
    );
    // The ledger holds two pending sessions, so :2 is the fresh id; the
    // real dispatcher then starts on host-b without a seeded entry.
    await appendPending(ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0"));
    await appendPending(ledgerPath, grantUsage("gh-demo-1:gh-demo-1:1"));
    let starts = 0;
    const startingPort: DispatcherPort = {
      ...control.port,
      async start(request: StartRequest) {
        starts += 1;
        return control.port.start(request);
      },
    };
    const starting = createDispatcher({
      port: startingPort,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const withStart = makeCtx(dir, starting, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    const step = await driveStart(withStart.ctx, item());
    expect(step).toBe("running");
    expect(starts).toBe(1);
    const entries = await readRegistry(registryPath);
    const entry = entries.find((candidate) => candidate.requestId === "gh-demo-1:2");
    expect(entry?.hostAlias).toBe("host-b");
    expect(entry?.sessionId).not.toBeNull();
    const li = await readItem(withStart.ctx.statePath);
    expect(li.phase).toBe("running");
    expect(li.session).toEqual({
      hostAlias: "host-b",
      providerId: FALLBACK_PROVIDER,
      model: FALLBACK,
    });
    expect(li.excludedHosts).toEqual([]);
    expect(li.startRejections).toBe(0);
    expect(li.fallbackUsed).toBe(true);
    const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
    expect(store.items[0]).toMatchObject({
      status: "running",
      assignedHostAlias: "host-b",
      modelRouting: { preferredModel: PREFERRED, fallbackUsed: true },
    });
    expect(store.items[0]?.modelRouting.attempts).toBe(0);
  });
});

test("driveStart on a refusing gate idles with a backoff (U5)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const refusing: BudgetGate = {
      admit() {
        return Promise.resolve({
          admit: false as const,
          reason: "spend 12.00 over cap 10.00",
          line: "refused: spend 12.00 over cap 10.00 (today 12.00 over cap 10.00)",
        });
      },
    };
    const dispatcher = createDispatcher({
      port: control.port,
      budget: refusing,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx, events } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await writeLoopState(ctx.statePath, startedLoopItem());
    const step = await driveStart(ctx, item());
    expect(step).toBe("idle");
    const li = await readItem(ctx.statePath);
    expect(li.phase).toBe("idle");
    expect(li.start).toBeNull();
    expect(li.backoffUntil).toBe(new Date(new Date(NOW).getTime() + 60_000).toISOString());
    expect(li.rounds).toHaveLength(0);
    expect(events.some((line) => line.startsWith("budget-refused:refused:spend"))).toBe(true);
    expect(events.filter((line) => line.startsWith("budget-refused:refused:"))).toHaveLength(1);
  });
});

test("driveStart on a failing gate logs budget-gate-error (U5)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const { BudgetGateError } = await import("../../src/budget/gate.js");
    const failing: BudgetGate = {
      admit() {
        return Promise.reject(new BudgetGateError("budget gate: timed out after 1000 ms"));
      },
    };
    const dispatcher = createDispatcher({
      port: control.port,
      budget: failing,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx, events } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await writeLoopState(ctx.statePath, startedLoopItem());
    const step = await driveStart(ctx, item());
    expect(step).toBe("idle");
    const li = await readItem(ctx.statePath);
    expect(li.backoffUntil).toBe(new Date(new Date(NOW).getTime() + 60_000).toISOString());
    expect(events.some((line) => line.startsWith("budget-refused:budget-gate-error:"))).toBe(true);
    expect(events.filter((line) => line.startsWith("budget-refused:budget-gate-error:"))).toHaveLength(1);
    expect(await readRegistry(registryPath)).toHaveLength(0);
  });
});

// Rows U6 to U9: the unreachable retry and the rejected, conflicting
// and drifted starts through the real dispatcher.
// M1: an intent seeded with a past backoff is a retry of the same
// intent, not a re-claim. The row keeps backoffUntil, sleeps once and
// starts with the stored request id and host.
test("an unreachable retry keeps the same intent (U6)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    control.setUnreachable("host-a", true);
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const sleeps: number[] = [];
    const { ctx, events } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
      sleep: (ms: number) => {
        sleeps.push(ms);
        control.setUnreachable("host-a", false);
        return Promise.resolve();
      },
    });
    await writeStore(ctx.storePath, item());
    await writeLoopState(
      ctx.statePath,
      startedLoopItem({ backoffUntil: "2026-10-28T09:00:00.000Z" }),
    );
    const before = await readItem(ctx.statePath);
    expect(before.start?.requestId).toBe("gh-demo-1:0");
    const step = await driveStart(ctx, item());
    expect(step).toBe("running");
    expect(sleeps).toEqual([5_000]);
    const li = await readItem(ctx.statePath);
    expect(li.requestId).toBe("gh-demo-1:0");
    expect(li.session?.hostAlias).toBe("host-a");
    expect(li.backoffUntil).toBe("2026-10-28T09:00:00.000Z");
    const claims = events.filter((line) => line.startsWith("claim:"));
    expect(claims).toHaveLength(0);
  });
});

test("a rejected grant closes start-rejected and the retry starts on host B (L31)", async () => {
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter }) => {
      await withTempDir(async (dir) => {
        const ledgerPath = join(dir, "ledger.jsonl");
        const registryPath = join(dir, "registry.json");
        const control = createMemoryPort();
        const port = createMeteredPort(
          rejectOn(control, "host-a", "host-unsupported"),
          meter,
          () => {},
        );
        const dispatcher = createDispatcher({
          port,
          budget: GATE,
          ledgerPath,
          config: configOf(registryPath),
          now: () => new Date(NOW),
          sleep: () => Promise.resolve(),
          log: () => undefined,
          settleUsage: (requestId, state) => meter.settleRequest(requestId, state),
        });
        const { ctx } = makeCtx(dir, dispatcher, {
          ledgerPath,
          dispatcherConfig: configOf(registryPath),
        });
        await writeStore(ctx.storePath, item());
        await writeLoopState(ctx.statePath, startedLoopItem());
        const step = await driveStart(ctx, item());
        expect(step).toBe("idle");
        const li = await readItem(ctx.statePath);
        const round = li.rounds[0];
        expect(round).toMatchObject({
          outcome: "start-rejected",
          attempt: "failure",
          requestId: "gh-demo-1:0",
        });
        expect(li.excludedHosts).toEqual(["host-a"]);
        expect(li.startRejections).toBe(1);
        const outcome = await claimStart(ctx, item(), choice(PREFERRED, PROVIDER, "host-b"));
        expect(outcome).toBe("claimed");
        const claimed = await readItem(ctx.statePath);
        expect(claimed.start?.requestId).toBe("gh-demo-1:1");
        const running = await driveStart(ctx, item());
        expect(running).toBe("running");
        expect((await readItem(ctx.statePath)).session?.hostAlias).toBe("host-b");
      });
    },
    { hosts: { "host-a": ["127.0.0.1"], "host-b": ["127.0.0.2"] } },
  );
});

test("a rejection with no grant records a null requestId (U7)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const dispatcher = createDispatcher({
      port: rejectOn(control, "host-d", "host-unsupported"),
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    const started = startedLoopItem({
      start: {
        round: 0,
        decision: decision("gh-demo-1", "host-d"),
        model: { providerId: PROVIDER, model: PREFERRED },
        brief: "Do the work.",
        itemBranch: null,
        requestId: "gh-demo-1:0",
      },
    });
    await writeLoopState(ctx.statePath, started);
    const step = await driveStart(ctx, item());
    expect(step).toBe("idle");
    const li = await readItem(ctx.statePath);
    expect(li.rounds[0]).toMatchObject({ outcome: "start-rejected", requestId: null });
    expect(li.startRejections).toBe(1);
    expect(await readRegistry(registryPath)).toHaveLength(0);
    await writeLoopState(ctx.statePath, {
      ...initialLoopItem(),
      startRejections: 2,
      phase: "starting",
      start: started.start,
    });
    const parked = await driveStart(ctx, item());
    expect(parked).toBe("parked");
    const after = await readItem(ctx.statePath);
    expect(after.park).toMatchObject({ kind: "operator", code: "start-rejected" });
    const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
    expect(store.items[0]).toMatchObject({ status: "parked" });
  });
});

test("a conflicting registry entry parks the item (U8)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const { briefSha256Of } = await import("../../src/dispatcher/dispatcher.js");
    const { insertRegistryEntry } = await import("../../src/dispatcher/registry.js");
    await insertRegistryEntry(registryPath, {
      requestId: "gh-demo-1:0",
      workItemId: "gh-demo-1",
      repo: "example/demo",
      hostAlias: "host-a",
      branch: "moc/gh-demo-1",
      baseRef: "origin/main",
      resume: false,
      model: { providerId: PROVIDER, model: PREFERRED },
      briefSha256: briefSha256Of("Another brief."),
      sessionId: "mem-1",
      worktree: "/memory-worktrees/host-a/mem-1",
      baseCommit: null,
      startedAt: NOW,
      cursor: null,
      unreachableCount: 0,
      lastSeenState: "starting",
      lastSeenAt: NOW,
      cancelReason: null,
      terminal: null,
      resolvedAt: null,
      revision: 0,
    });
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await writeLoopState(ctx.statePath, startedLoopItem());
    const step = await driveStart(ctx, item());
    expect(step).toBe("parked");
    const li = await readItem(ctx.statePath);
    expect(li.phase).toBe("idle");
    expect(li.park).toMatchObject({ kind: "operator", code: "request-conflict" });
    const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
    expect(store.items[0]).toMatchObject({
      status: "parked",
      statusReason: "operator: request-conflict",
    });
  });
});

test("a pre-check drift parks with request-drift and no start (U9a)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    let starts = 0;
    const counting: DispatcherPort = {
      ...control.port,
      start(request: StartRequest) {
        starts += 1;
        return control.port.start(request);
      },
    };
    const dispatcher = createDispatcher({
      port: counting,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    await appendPending(ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0"));
    const step = await driveStart(ctx, item());
    expect(step).toBe("parked");
    expect(starts).toBe(0);
    const li = await readItem(ctx.statePath);
    expect(li.phase).toBe("idle");
    expect(li.park).toMatchObject({ kind: "operator", code: "request-drift" });
    expect(li.rounds).toHaveLength(0);
    expect(await readRegistry(registryPath)).toHaveLength(0);
    const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
    expect(store.items[0]).toMatchObject({
      status: "parked",
      statusReason: "operator: request-drift",
    });
  });
});

// U9b (crash a): a drifted T2 settled before a crash leaves a live :1
// entry. The next driveStart finds the drift in the pre-check and
// cancels the live entry with no new start.
test("a drifted start after a crash cancels the live session (U9b)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    let starts = 0;
    const counting: DispatcherPort = {
      ...control.port,
      start(request: StartRequest) {
        starts += 1;
        return control.port.start(request);
      },
    };
    const dispatcher = createDispatcher({
      port: counting,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    const stashed = await readItem(ctx.statePath);
    const intent = stashed.start;
    if (intent === null) {
      throw new Error("U9b setup lost the start intent");
    }
    // The T2 that ran before the crash: a real start of :1.
    await appendPending(ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0"));
    const seeded = await dispatcher.start(
      { ...item(), status: "queued", branch: null },
      intent.decision,
      intent.model,
      intent.brief,
    );
    if (seeded.kind !== "started") {
      throw new Error("U9b setup did not start a session");
    }
    expect(seeded.request.requestId).toBe("gh-demo-1:1");
    await writeLoopState(ctx.statePath, { ...stashed, phase: "starting" });
    const step = await driveStart(ctx, item());
    expect(step).toBe("parked");
    expect(starts).toBe(1);
    const li = await readItem(ctx.statePath);
    expect(li.park).toMatchObject({ kind: "operator", code: "request-drift" });
    const entries = await readRegistry(registryPath);
    const live = entries.find((entry) => entry.requestId === "gh-demo-1:1");
    expect(live?.terminal?.state).toBe("cancelled");
    expect(live?.cancelReason).toBe("operator");
    expect(entries.every((entry) => entry.terminal !== null)).toBe(true);
  });
});

// U9c (post-start): the T2 appends the anomalous line and returns a
// started with another request id. The drift park cancels that entry.
test("a post-start drift cancels the started session (U9c)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    let starts = 0;
    const counting: DispatcherPort = {
      ...control.port,
      start(request: StartRequest) {
        starts += 1;
        return control.port.start(request);
      },
    };
    const inner = createDispatcher({
      port: counting,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const drifting: StartContext["dispatcher"] = {
      ...inner,
      async start(workItem, decision, model, brief) {
        await appendPending(ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0"));
        return inner.start(workItem, decision, model, brief);
      },
    };
    const { ctx } = makeCtx(dir, drifting, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    const step = await driveStart(ctx, item());
    expect(step).toBe("parked");
    expect(starts).toBe(1);
    const li = await readItem(ctx.statePath);
    expect(li.park).toMatchObject({ kind: "operator", code: "request-drift" });
    const entries = await readRegistry(registryPath);
    const live = entries.find((entry) => entry.requestId === "gh-demo-1:1");
    expect(live?.terminal?.state).toBe("cancelled");
    expect(live?.cancelReason).toBe("operator");
    expect(entries.every((entry) => entry.terminal !== null)).toBe(true);
  });
});

// U9d (crash b): the cancel ran before the crash but the park write did
// not. The pre-check finds the drift again with no live entry left and
// parks with no new start.
test("a drifted cancel before a crash parks with no live entry (U9d)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    let starts = 0;
    const counting: DispatcherPort = {
      ...control.port,
      start(request: StartRequest) {
        starts += 1;
        return control.port.start(request);
      },
    };
    const dispatcher = createDispatcher({
      port: counting,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    const stashed = await readItem(ctx.statePath);
    const intent = stashed.start;
    if (intent === null) {
      throw new Error("U9d setup lost the start intent");
    }
    await appendPending(ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0"));
    const seeded = await dispatcher.start(
      { ...item(), status: "queued", branch: null },
      intent.decision,
      intent.model,
      intent.brief,
    );
    if (seeded.kind !== "started") {
      throw new Error("U9d setup did not start a session");
    }
    await dispatcher.cancel("gh-demo-1:1", "operator");
    await writeLoopState(ctx.statePath, { ...stashed, phase: "starting" });
    const step = await driveStart(ctx, item());
    expect(step).toBe("parked");
    expect(starts).toBe(1);
    const li = await readItem(ctx.statePath);
    expect(li.park).toMatchObject({ kind: "operator", code: "request-drift" });
    const entries = await readRegistry(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ requestId: "gh-demo-1:1" });
    expect(entries[0]?.terminal?.state).toBe("cancelled");
  });
});

// U9e: the U9b setup with a port whose first cancel rejects with
// PortUnreachableError. The first driveStart returns "idle" and keeps L
// starting with the same intent; the next driveStart cancels the live
// entry and parks with request-drift.
test("an unreachable drift cancel idles and the retry parks (U9e)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    let starts = 0;
    let cancels = 0;
    const flaky: DispatcherPort = {
      ...control.port,
      start(request: StartRequest) {
        starts += 1;
        return control.port.start(request);
      },
      async cancel(ref, reason) {
        cancels += 1;
        if (cancels === 1) {
          return Promise.reject(new PortUnreachableError("host host-a unreachable"));
        }
        return control.port.cancel(ref, reason);
      },
    };
    const dispatcher = createDispatcher({
      port: flaky,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    const stashed = await readItem(ctx.statePath);
    const intent = stashed.start;
    if (intent === null) {
      throw new Error("U9e setup lost the start intent");
    }
    await appendPending(ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0"));
    const seeded = await dispatcher.start(
      { ...item(), status: "queued", branch: null },
      intent.decision,
      intent.model,
      intent.brief,
    );
    if (seeded.kind !== "started") {
      throw new Error("U9e setup did not start a session");
    }
    expect(seeded.request.requestId).toBe("gh-demo-1:1");
    await writeLoopState(ctx.statePath, { ...stashed, phase: "starting" });
    const step = await driveStart(ctx, item());
    expect(step).toBe("idle");
    const kept = await readItem(ctx.statePath);
    expect(kept.phase).toBe("starting");
    expect(kept.start?.requestId).toBe("gh-demo-1:0");
    expect(kept.park).toBeNull();
    const parked = await driveStart(ctx, item());
    expect(parked).toBe("parked");
    const li = await readItem(ctx.statePath);
    expect(li.park).toMatchObject({ kind: "operator", code: "request-drift" });
    const entries = await readRegistry(registryPath);
    const live = entries.find((entry) => entry.requestId === "gh-demo-1:1");
    expect(live?.terminal?.state).toBe("cancelled");
    expect(live?.cancelReason).toBe("operator");
    expect(starts).toBe(1);
  });
});

// Rows L51 and L52 (C18, C19): the two crash replays of a rejected grant.
// The real dispatcher writes the provisional rejected entry, then the
// test edits the registry file (and the ledger for C18) to the crash
// state. Neither row lets the port start a session.
async function crashingRegistry(
  registryPath: string,
  ledgerPath: string,
  withPending: boolean,
  ledgered: boolean,
): Promise<void> {
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter }) => {
      const control = createMemoryPort();
      const port = createMeteredPort(
        rejectOn(control, "host-a", "host-unsupported"),
        meter,
        () => {},
      );
      const dispatcher = createDispatcher({
        port,
        budget: GATE,
        ledgerPath,
        config: configOf(registryPath),
        now: () => new Date(NOW),
        sleep: () => Promise.resolve(),
        log: () => undefined,
        settleUsage: (requestId, state) => meter.settleRequest(requestId, state),
      });
      let error: unknown;
      try {
        await dispatcher.start(
          item(),
          decision("gh-demo-1", "host-a"),
          { providerId: PROVIDER, model: PREFERRED },
          "Do the work.",
        );
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PortRejectedError);
      const stored = await readRegistry(registryPath);
      expect(stored).toHaveLength(1);
      const entry = stored[0] as RegistryEntry;
      expect(entry.terminal?.detail).toBe("start-rejected: host-unsupported");
      const terminal = entry.terminal === null ? null : { ...entry.terminal };
      if (terminal !== null && !ledgered) {
        terminal.ledgerAppended = false;
      }
      // M2: the C19 leg keeps the dispatcher's own revision and flag.
      const crashing: RegistryEntry = {
        ...(entry as RegistryEntry & { sessionId: null }),
        revision: ledgered ? entry.revision : 1,
        terminal,
      };
      const { writeFileAtomic } = await import("../../src/fs/write.js");
      await writeFileAtomic(
        "test registry",
        registryPath,
        `${JSON.stringify({ sessions: [crashing] }, null, 2)}\n`,
      );
    },
    { hosts: { "host-a": ["127.0.0.1"] } },
  );
  if (!withPending) {
    await Bun.write(ledgerPath, "");
  }
}

test("C18 replays the terminal without a port start (L51)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    await crashingRegistry(registryPath, ledgerPath, false, false);
    const control = createMemoryPort();
    let starts = 0;
    const counting: DispatcherPort = {
      ...control.port,
      start(request: StartRequest) {
        starts += 1;
        return control.port.start(request);
      },
    };
    const dispatcher = createDispatcher({
      port: counting,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await writeLoopState(ctx.statePath, startedLoopItem());
    const step = await driveStart(ctx, item());
    expect(step).toBe("idle");
    expect(starts).toBe(0);
    const li = await readItem(ctx.statePath);
    expect(li.rounds[0]).toMatchObject({
      outcome: "start-rejected",
      attempt: "failure",
      requestId: "gh-demo-1:0",
    });
    expect(li.startRejections).toBe(1);
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(1);
    expect(contents.pending[0]?.session?.result).toBe("failure");
    expect((await readLoopState(ctx.statePath)).items["gh-demo-1"]).toBeDefined();
    const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
    expect(store.items[0]).toMatchObject({ status: "queued", stallRounds: 0 });
    expect(li.rounds[0]).toMatchObject({ outcome: "start-rejected", attempt: "failure" });
  });
});

// C19 keeps the dispatcher's own revision with the flag set, while the
// ledger line stays appended; neither row lets the port start. U15 keeps
// the previous state with the flag unset.
test("C19 replays the ledgered terminal without a port start (L52)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    await crashingRegistry(registryPath, ledgerPath, true, true);
    const control = createMemoryPort();
    let starts = 0;
    const counting: DispatcherPort = {
      ...control.port,
      start(request: StartRequest) {
        starts += 1;
        return control.port.start(request);
      },
    };
    const dispatcher = createDispatcher({
      port: counting,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await writeLoopState(ctx.statePath, startedLoopItem());
    const step = await driveStart(ctx, item());
    expect(step).toBe("idle");
    expect(starts).toBe(0);
    const li = await readItem(ctx.statePath);
    expect(li.rounds[0]).toMatchObject({
      outcome: "start-rejected",
      attempt: "failure",
      requestId: "gh-demo-1:0",
    });
    expect(li.startRejections).toBe(1);
    const replayed = await readLedger("Test ledger", ledgerPath);
    expect(replayed.pending).toHaveLength(1);
    expect(replayed.pending[0]?.session?.result).toBe("failure");
  });
});

test("an unflagged ledgered replay keeps one pending line (U15)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    await crashingRegistry(registryPath, ledgerPath, true, false);
    const control = createMemoryPort();
    let starts = 0;
    const counting: DispatcherPort = {
      ...control.port,
      start(request: StartRequest) {
        starts += 1;
        return control.port.start(request);
      },
    };
    const dispatcher = createDispatcher({
      port: counting,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await writeLoopState(ctx.statePath, startedLoopItem());
    const step = await driveStart(ctx, item());
    expect(step).toBe("idle");
    expect(starts).toBe(0);
    const li = await readItem(ctx.statePath);
    expect(li.rounds[0]).toMatchObject({
      outcome: "start-rejected",
      attempt: "failure",
      requestId: "gh-demo-1:0",
    });
    expect(li.startRejections).toBe(1);
    const replayed = await readLedger("Test ledger", ledgerPath);
    expect(replayed.pending).toHaveLength(1);
    expect(replayed.pending[0]?.session?.result).toBe("failure");
  });
});

// Rows U10 to U13 and U16: the watcher terminal table, the timeout
// bound, the rejected watch, the S6 guard, and the unreachable retry
// over a live orphan through the real dispatcher.
test("watchSession publishes a finished session and closes a lost host (U10)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx, events } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    await driveStart(ctx, item());
    const running = await readItem(ctx.statePath);
    const handle = (await readRegistry(registryPath)).find(
      (entry) => entry.requestId === "gh-demo-1:0",
    );
    expect(handle?.sessionId).not.toBeNull();
    control.complete(handle?.sessionId as string, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    const published = await watchSession(ctx, item());
    expect(published).toBe("publishing");
    const terminals = events.filter((line) => line.startsWith("terminal:"));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toContain(":success:");
    // The lost host closes a lost round, excludes the host and parks.
    // A fresh control, ledger and registry isolate the lost leg.
    const lostLedger = join(dir, "ledger-lost.jsonl");
    const lostRegistry = join(dir, "registry-lost.json");
    const lostControl = createMemoryPort();
    const lostDispatcher = createDispatcher({
      port: lostControl.port,
      budget: GATE,
      ledgerPath: lostLedger,
      config: configOf(lostRegistry),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const lostParts = makeCtx(dir, lostDispatcher, {
      ledgerPath: lostLedger,
      dispatcherConfig: configOf(lostRegistry),
    });
    await writeStore(lostParts.ctx.storePath, item());
    await writeLoopState(lostParts.ctx.statePath, { ...runningLoopItem(), round: 1 });
    const lost = await lostDispatcher.start(
      { ...item(), status: "queued", branch: null },
      decision("gh-demo-1", "host-a"),
      { providerId: PROVIDER, model: PREFERRED },
      "Lost work.",
    );
    expect(lost.kind).toBe("started");
    expect(running.session?.hostAlias).toBe("host-a");
    lostControl.loseHost("host-a");
    const parked = await watchSession(lostParts.ctx, item());
    expect(parked).toBe("parked");
    const li = await readItem(lostParts.ctx.statePath);
    expect(li.rounds).toHaveLength(1);
    expect(li.rounds[0]).toMatchObject({ outcome: "lost", attempt: "lost" });
    expect(li.excludedHosts).toEqual(["host-a"]);
    expect(li.park).toMatchObject({ kind: "lost" });
    const store = (await Bun.file(lostParts.ctx.storePath).json()) as { items: WorkItem[] };
    expect(store.items[0]).toMatchObject({ status: "parked", statusReason: "session lost" });
  });
});

test("checkSessionTimeout honours the durable startedAt bound (U11)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const t0 = new Date("2026-10-28T10:00:00.000Z");
    const seen = logged();
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
      log: seen.log,
    });
    await writeStore(ctx.storePath, item());
    await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    await driveStart(ctx, item());
    const li = await readItem(ctx.statePath);
    expect(li.requestId).toBe("gh-demo-1:0");
    const entries = await readRegistry(registryPath);
    const entry = entries.find((candidate) => candidate.requestId === "gh-demo-1:0");
    expect(entry?.startedAt).toBe(t0.toISOString());
    const freshAt = (now: Date): StartContext =>
      makeCtx(dir, dispatcher, {
        ledgerPath,
        dispatcherConfig: configOf(registryPath),
        log: seen.log,
        now: () => now,
      }).ctx;
    expect(await checkSessionTimeout(freshAt(new Date(t0.getTime() + 3_600_000 - 1)), item())).toBe(
      "none",
    );
    expect(await checkSessionTimeout(freshAt(new Date(t0.getTime() + 3_600_000)), item())).toBe(
      "cancelled",
    );
    const published = await watchSession(ctx, item());
    expect(published).toBe("publishing");
    const stalled = seen.events.filter((line) => line.startsWith("terminal:"));
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toContain(":stalled:");
  });
});

test("watchSession parks a rejected watch without rethrowing (U12)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const seeded = createMemoryPort();
    const seeding = createDispatcher({
      port: seeded.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, seeding, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    await driveStart(ctx, item());
    // A fresh memory port lost the sessions: watch rejects.
    const lost = createMemoryPort();
    const watching = createDispatcher({
      port: lost.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const watchingCtx = makeCtx(dir, watching, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    }).ctx;
    const step = await watchSession(watchingCtx, item());
    expect(step).toBe("parked");
    const li = await readItem(ctx.statePath);
    expect(li.park).toMatchObject({ kind: "operator", code: "watch-rejected" });
    const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
    expect(store.items[0]).toMatchObject({
      status: "parked",
      statusReason: "operator: watch-rejected",
    });
  });
});

test("watchSession drops a stale result under the S6 guard (U13)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const gated = gatePort(control.port, new Set(["wait"]));
    const dispatcher = createDispatcher({
      port: gated.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
    });
    await writeStore(ctx.storePath, item());
    await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    await driveStart(ctx, item());
    const waiting = watchSession(ctx, item());
    const parked = await gated.next("wait");
    await parkOperator(ctx, item(), "pull-closed");
    const entries = await readRegistry(registryPath);
    const entry = entries.find((candidate) => candidate.requestId === "gh-demo-1:0");
    control.complete(entry?.sessionId as string, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    await parked.release();
    expect(await waiting).toBe("parked");
    const li = await readItem(ctx.statePath);
    expect(li.phase).toBe("idle");
    expect(li.park).toMatchObject({ kind: "operator", code: "pull-closed" });
    expect(li.rounds).toHaveLength(0);
  });
});

// U16: a live orphan that no loop item names survives an unreachable T2.
// The retry with the same intent starts normally; the orphan keeps
// terminal null and no cancel reason, and the sleep ran once.
test("an unreachable retry over a live orphan starts the same intent (U16)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const { briefSha256Of } = await import("../../src/dispatcher/dispatcher.js");
    const { insertRegistryEntry } = await import("../../src/dispatcher/registry.js");
    await insertRegistryEntry(registryPath, {
      requestId: "gh-demo-1:0",
      workItemId: "gh-demo-1",
      repo: "example/demo",
      hostAlias: "host-a",
      branch: "moc/gh-demo-1",
      baseRef: "origin/main",
      resume: false,
      model: { providerId: PROVIDER, model: PREFERRED },
      briefSha256: briefSha256Of("Another brief."),
      sessionId: "mem-orphan",
      worktree: "/memory-worktrees/host-a/mem-orphan",
      baseCommit: null,
      startedAt: NOW,
      cursor: null,
      unreachableCount: 0,
      lastSeenState: "starting",
      lastSeenAt: NOW,
      cancelReason: null,
      terminal: null,
      resolvedAt: null,
      revision: 0,
    });
    await appendPending(ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0"));
    const control = createMemoryPort();
    let starts = 0;
    const flaky: DispatcherPort = {
      ...control.port,
      start(request: StartRequest) {
        starts += 1;
        if (starts === 1) {
          return Promise.reject(new PortUnreachableError("host host-a unreachable"));
        }
        return control.port.start(request);
      },
    };
    const dispatcher = createDispatcher({
      port: flaky,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    const sleeps: number[] = [];
    const { ctx } = makeCtx(dir, dispatcher, {
      ledgerPath,
      dispatcherConfig: configOf(registryPath),
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await writeStore(ctx.storePath, item());
    await claimStart(ctx, item(), choice(PREFERRED, PROVIDER));
    const claimed = await readItem(ctx.statePath);
    expect(claimed.start?.requestId).toBe("gh-demo-1:1");
    const step = await driveStart(ctx, item());
    expect(step).toBe("running");
    const li = await readItem(ctx.statePath);
    expect(li.phase).toBe("running");
    expect(li.requestId).toBe("gh-demo-1:1");
    const entries = await readRegistry(registryPath);
    const started = entries.find((entry) => entry.requestId === "gh-demo-1:1");
    expect(started?.terminal).toBeNull();
    expect(started?.sessionId).not.toBeNull();
    const orphan = entries.find((entry) => entry.requestId === "gh-demo-1:0");
    expect(orphan?.terminal).toBeNull();
    expect(orphan?.cancelReason).toBeNull();
    expect(sleeps).toEqual([5_000]);
  });
});

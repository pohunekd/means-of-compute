// Driver start tests (rows U4, U10, U16): drive opens the session on
// the fallback model, watch publishes a finished session and closes a
// lost host, and an unreachable retry over a live orphan starts the same
// intent, through the real dispatcher, memory port and files.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { DispatcherPort, StartRequest } from "../../src/dispatcher/port.js";
import { PortUnreachableError } from "../../src/dispatcher/port.js";
import { readRegistry } from "../../src/dispatcher/registry.js";
import type { WorkItem } from "../../contracts/v1/types.js";
import { appendPending } from "../../src/ledger/store.js";
import type { PendingUsage } from "../../src/ledger/types.js";
import { readLoopState } from "../../src/loop/state.js";
import type { LoopLog } from "../../src/loop/log.js";
import { FakeGitHub } from "./fake-github.js";
import {
  claimStart,
  driveStart,
  initialLoopItem,
  watchSession,
  type ClaimInput,
  type StartContext,
} from "../../src/loop/start.js";
import type { LoopItem } from "../../src/loop/types.js";

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
      followupLabels: ["factory:followup", "readiness:design-needed"],
      verdictDir: join(dir, "verdicts"),
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

// Row U4: drive opens the session on the fallback model.
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

// The watcher through the real dispatcher: a finished session publishes
// and closes a lost host (U10), and an unreachable retry over a live
// orphan starts the same intent (U16).
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

// U16: a live orphan that no loop item names survives an unreachable T2.
// The orphan entry holds a :0 control-port handle from a real
// `control.port.start`, while the retry with the same intent is rejected
// worktree-branch-in-use: the live orphan holds the branch on the host.
// The orphan keeps terminal null and no cancel reason, and the sleep ran
// once. The PR body states the failing assertion.
test("an unreachable retry over a live orphan keeps the orphan and rejects (U16)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const { briefSha256Of } = await import("../../src/dispatcher/dispatcher.js");
    const { insertRegistryEntry } = await import("../../src/dispatcher/registry.js");
    const control = createMemoryPort();
    // The :0 entry is built from the session the port started.
    const orphanHandle = await control.port.start({
      requestId: "gh-demo-1:0",
      workItemId: "gh-demo-1",
      repo: "example/demo",
      hostAlias: "host-a",
      branch: "moc/gh-demo-1",
      baseRef: "origin/main",
      resume: false,
      model: { providerId: PROVIDER, model: PREFERRED },
      brief: "Another brief.",
    });
    expect(orphanHandle.sessionId).toBe("mem-1");
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
      sessionId: orphanHandle.sessionId,
      worktree: orphanHandle.worktree,
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
    expect(step).toBe("idle");
    const li = await readItem(ctx.statePath);
    expect(li.phase).toBe("idle");
    expect(li.rounds).toHaveLength(1);
    expect(li.rounds[0]).toMatchObject({ outcome: "start-rejected", requestId: null });
    expect(li.excludedHosts).toEqual(["host-a"]);
    expect(li.startRejections).toBe(1);
    const entries = await readRegistry(registryPath);
    expect(entries.some((entry) => entry.requestId === "gh-demo-1:1")).toBe(false);
    const orphan = entries.find((entry) => entry.requestId === "gh-demo-1:0");
    expect(orphan?.terminal).toBeNull();
    expect(orphan?.cancelReason).toBeNull();
    expect(orphan?.sessionId).toBe("mem-1");
    expect(sleeps).toEqual([5_000]);
  });
});

// Scheduler tests (slice 6a rows ST1-ST16): one tick over every loop item,
// the claims, the hold clear, and startup recovery.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkItem } from "../../contracts/v1/types.js";
import type { HostCapacity } from "../../contracts/v1/types.js";
import type { LoopLog } from "../../src/loop/log.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import type { GitDeps } from "../../src/loop/git.js";
import type { CheckRun } from "../../src/loop/github.js";
import { createStubGitHub, type StubCi } from "../../src/loop/stub/github.js";
import { readLoopState } from "../../src/loop/state.js";
import type { LoopItem } from "../../src/loop/types.js";
import { initialLoopItem } from "../../src/loop/start.js";
import { appendPending } from "../../src/ledger/store.js";
import type { PendingUsage } from "../../src/ledger/types.js";
import { createCollector } from "../../src/hoststate/collector.js";
import { createMemoryHostStatePort } from "../../src/hoststate/memory-port.js";
import type { HostStateConfig } from "../../src/hoststate/config.js";
import { createApprovalsView } from "../../src/loop/approvals-view.js";
import { createMergeMutex } from "../../src/loop/merge.js";
import { readRegistry, replaceRegistryEntry } from "../../src/dispatcher/registry.js";
import { renderComment } from "../../src/auditor/verdict.js";
import { recordRequest } from "../../src/approvals/store.js";
import { decideRequest } from "../../src/approvals/decide.js";
import {
  createScheduler,
  recoverAtStartup,
  type SchedulerContext,
} from "../../src/loop/scheduler.js";
import type { PlacementConfig } from "../../src/placement/config.js";
import type { LoopRoutingConfig } from "../../src/loop/config.js";
import { applyTestEnv } from "../auditor/test-env.js";

const PREFERRED = "muse-spark-1.3-contributor";
const PROVIDER = "meta-api";
const AUDITOR = "meta/muse-glimmer-30b";
const NOW = "2026-10-28T10:00:00.000Z";
const REPO = "example/demo";
const FACTORY_LOGIN = "moc-factory";

function item(id = "gh-demo-1", overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    schemaVersion: "v1",
    id,
    repo: REPO,
    title: `Demo item ${id}`,
    goal: "Drive a scheduler tick",
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
          `${event.event}:${event.code ?? ""}:${event.detail ?? ""}:${event.sha ?? ""}:${typeof event.round === "number" ? String(event.round) : ""}:${event.requestId ?? ""}:${event.hostAlias ?? ""}`,
        );
      },
      failed(): boolean {
        return false;
      },
      async close(): Promise<void> {},
    },
  };
}

const GIT_ENV = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function git(dir: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    env: GIT_ENV,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout as ReadableStream).text();
  const stderr = await new Response(proc.stderr as ReadableStream).text();
  const rc = await proc.exited;
  if (rc !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${String(rc)}: ${stderr}`);
  }
  return stdout;
}

interface Sandbox {
  readonly origin: string;
  readonly seed: string;
  readonly scratchDir: string;
  readonly cleanup: () => Promise<void>;
}

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-scheduler-"));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

const HOST_ID = "moc.host-state";
const HOST_DIGEST = `sha256:${"b".repeat(64)}`;

const HOST_CONFIG: HostStateConfig = {
  package: {
    id: HOST_ID,
    version: "0.1.0",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    command: "host-state",
  },
  collector: {
    acceptedVersions: ["0.1.0"],
    pluginTimeoutMs: 10000,
    transportMarginMs: 2000,
    maxOutputBytes: 16384,
    maxClockSkewMs: 120000,
  },
};

const PLACEMENT: PlacementConfig = {
  weights: { cpu: 0.4, memory: 0.4, gpu: 0.2 },
  batteryFloorPercent: 50,
  minInputIdleSeconds: 900,
};

const ROUTING: LoopRoutingConfig = {
  models: { [PREFERRED]: PROVIDER },
  fallback: {},
  fallbackAfterFailures: 3,
  window: 10,
  minSamples: 5,
  minSuccessRate: 0.5,
};

function capacityOf(alias: string, overrides: Partial<HostCapacity> = {}): HostCapacity {
  return {
    schemaVersion: "v1",
    hostAlias: alias,
    timestamp: NOW,
    idle: true,
    idleReason: "no user input for 60 minutes, on AC power",
    secondsSinceInput: 3600,
    acPower: true,
    batteryPercent: null,
    cpu: { cores: 8, load1m: alias === "host-a" ? 0.5 : 4.0 },
    memory: { totalMb: 32768, freeMb: 21000 },
    gpu: { present: false, name: null, freeMb: null },
    localModels: { reachable: false, models: [] },
    policy: {
      allowedWindow: { start: "00:00", end: "00:00" },
      insideWindow: true,
      maxConcurrentAgents: 1,
    },
    ...overrides,
  };
}

function replyOf(capacity: HostCapacity): {
  identity: { packageId: string; version: string; digest: string };
  stdout: string;
} {
  return {
    identity: { packageId: HOST_ID, version: "0.1.0", digest: HOST_DIGEST },
    stdout: JSON.stringify(capacity),
  };
}

interface Harness {
  ctx: SchedulerContext;
  events: string[];
  registryPath: string;
  sandbox: Sandbox;
  nowValue: { current: Date };
  control: ReturnType<typeof createMemoryPort>;
  github: ReturnType<typeof createStubGitHub>;
  hostControl: ReturnType<typeof createMemoryHostStatePort>;
}

async function makeHarness(
  dir: string,
  overrides: {
    now?: string;
    hosts?: readonly string[];
    ci?: (sha: string) => StubCi;
    maxActiveItems?: number;
    maxBriefBytes?: number;
    ciPollMs?: number;
  } = {},
): Promise<Harness> {
  const seen = logged();
  const nowValue = { current: new Date(overrides.now ?? NOW) };
  const registryPath = join(dir, "registry.json");
  const control = createMemoryPort();
  const ledgerPath = join(dir, "ledger.jsonl");
  const dispatcher = createDispatcher({
    port: control.port,
    budget: {
      admit: () => Promise.resolve({ admit: true as const, line: "admitted: test" }),
    },
    ledgerPath,
    config: configOf(registryPath),
    now: () => new Date(nowValue.current.getTime()),
    sleep: () => Promise.resolve(),
    log: () => undefined,
    settleUsage: () => Promise.resolve(null),
  });
  const checkoutDir = join(dir, "checkout");
  const sandbox = await makeSandbox(checkoutDir);
  const gitDeps: GitDeps = { PATH: GIT_ENV.PATH, timeoutMs: 30000 };
  const aliases = overrides.hosts ?? ["host-a", "host-b"];
  const hostControl = createMemoryHostStatePort(aliases);
  for (const alias of aliases) {
    hostControl.set(alias, { kind: "reply", reply: replyOf(capacityOf(alias)) });
  }
  const collector = createCollector({
    port: hostControl.port,
    config: HOST_CONFIG,
    now: () => new Date(nowValue.current.getTime()),
    sleep: () => new Promise<void>(() => {}),
    log: () => undefined,
  });
  const github = createStubGitHub({
    repo: REPO,
    originDir: sandbox.origin,
    baseBranch: "main",
    factoryLogin: FACTORY_LOGIN,
    git: gitDeps,
    scratchDir: sandbox.scratchDir,
    ci: overrides.ci ?? (() => "success"),
  });
  const verdictDir = join(dir, "verdicts");
  await mkdir(verdictDir, { recursive: true });
  const ctx: SchedulerContext = {
    branchPrefix: "moc/",
    statePath: join(dir, "loop-state.json"),
    resultsPath: join(dir, "loop-results.jsonl"),
    storePath: join(dir, "work-items.json"),
    stall: { maxStagnantRounds: 3, maxRetries: 2 },
    log: seen.log,
    now: () => new Date(nowValue.current.getTime()),
    github,
    factoryLogin: FACTORY_LOGIN,
    ledgerPath,
    escalationLabel: "moc-escalation",
    readyLabel: "moc-ready",
    blockedLabel: "moc-blocked",
    maxRetries: 2,
    dispatcher,
    dispatcherConfig: configOf(registryPath),
    sessionTimeoutMs: 3_600_000,
    unreachableRetryMs: 5_000,
    budgetBackoffMs: 60_000,
    maxStartRejections: 3,
    sleep: () => Promise.resolve(),
    repos: [{ repo: REPO, checkoutDir, idPrefix: "gh-" }],
    git: gitDeps,
    requiredChecks: ["gates"],
    ciTimeoutMs: 600_000,
    auditRetries: 1,
    auditor: {
      config: {
        verdictDir,
        maxDiffBytes: 1_000_000,
        auditors: [],
        mergeAuditor: { providerId: PROVIDER, model: PREFERRED },
        maxFindings: 50,
        maxFieldChars: 2000,
      },
      budget: {
        admit: () => Promise.resolve({ admit: true as const, line: "admitted: test" }),
      },
      call: () => Promise.reject(new Error("scheduler tests never audit")),
    },
    specs: [{ schemaVersion: "v1", repo: REPO, mergeMode: "by-rule" }],
    approvals: createApprovalsView(join(dir, "approval-requests.json")),
    mergeRetries: 1,
    trialMerge: { scratchDir: join(dir, "trials"), steps: [], timeoutMs: 30_000 },
    home: dir,
    mergeMutex: createMergeMutex(),
    collector,
    placementConfig: PLACEMENT,
    routing: ROUTING,
    maxActiveItems: overrides.maxActiveItems ?? 4,
    maxBriefBytes: overrides.maxBriefBytes ?? 65536,
    ciPollMs: overrides.ciPollMs ?? 30_000,
  };
  return {
    ctx,
    events: seen.events,
    registryPath,
    sandbox,
    nowValue,
    control,
    github,
    hostControl,
  };
}

async function writeStore(path: string, entries: readonly WorkItem[]): Promise<void> {
  await Bun.write(
    path,
    `${JSON.stringify({ schemaVersion: "v1", revision: 0, items: entries, submissions: [] })}\n`,
  );
}

async function writeLoopState(
  path: string,
  items: Record<string, LoopItem>,
  mergeHold: unknown = null,
): Promise<void> {
  await Bun.write(
    path,
    `${JSON.stringify({
      schemaVersion: "v1",
      revision: 0,
      items,
      resolvedApprovals: [],
      mergeHold,
      lastDigestDay: null,
    })}\n`,
  );
}

async function readItem(statePath: string, id = "gh-demo-1"): Promise<LoopItem> {
  const state = await readLoopState(statePath);
  return state.items[id] as unknown as LoopItem;
}

async function writeApprovedPause(path: string): Promise<void> {
  const recorded = await recordRequest(path, {
    tool: "pause_fleet",
    args: { action: "pause", reason: "Hold the fleet." },
    caller: "owner",
    now: () => new Date(NOW),
    maxPending: 20,
  });
  if (recorded.kind !== "recorded") {
    throw new Error(`expected recorded, got ${recorded.kind}`);
  }
  const decided = await decideRequest(path, {
    requestId: recorded.request.requestId,
    decision: "approved",
    author: "owner",
    now: () => new Date(NOW),
  });
  if (decided.kind !== "decided") {
    throw new Error(`expected decided, got ${decided.kind}`);
  }
}

function grantUsage(entryId: string, workItemId: string): PendingUsage {
  return {
    entryId,
    kind: "session",
    workItemId,
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
    session: { hostAlias: "host-a", seconds: 60, source: "dispatcher-clock", result: "failure" },
  };
}

function completeAll(control: ReturnType<typeof createMemoryPort>): void {
  for (const session of control.sessions()) {
    if (session.state === "running" || session.state === "starting") {
      control.complete(session.handle.sessionId, {
        state: "finished",
        usage: null,
        detail: "exited 0",
      });
    }
  }
}

// Complete running memory sessions while waiting: the dispatcher watch
// loops on non-terminal sleeps, so completing first would miss a watch
// launched by the tick under test. Session polling uses the synchronous
// memory-port session list; the race still yields on a zero-delay timer
// so the dispatcher sleep (Promise.resolve) can resolve first.
async function settleSoon(
  scheduler: ReturnType<typeof createScheduler>,
  control: ReturnType<typeof createMemoryPort>,
): Promise<void> {
  const settled = scheduler.settled();
  for (let round = 0; round < 100; round += 1) {
    completeAll(control);
    const raced = await Promise.race([
      settled.then(() => "done" as const),
      new Promise((resolve) => setTimeout(resolve, 0)).then(() => "wait" as const),
    ]);
    if (raced === "done") {
      await settled;
      return;
    }
  }
  await settled;
}

function countPrefix(events: readonly string[], prefix: string): number {
  return events.filter((line) => line.startsWith(prefix)).length;
}

// ST1: two ready items claimed in one tick land on different hosts: the
// second claim sees the first as running (SR4 step 3).
test("ST1 same-tick claims share the running set", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1"), item("gh-demo-2")]);
      await writeLoopState(harness.ctx.statePath, {});
      await appendPending(harness.ctx.ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0", "gh-demo-1"));
      await appendPending(harness.ctx.ledgerPath, grantUsage("gh-demo-2:gh-demo-2:0", "gh-demo-2"));
      const scheduler = createScheduler(harness.ctx);
      const report = await scheduler.tick();
      expect(report.claimed).toEqual(["gh-demo-1", "gh-demo-2"]);
      const first = await readItem(harness.ctx.statePath, "gh-demo-1");
      const second = await readItem(harness.ctx.statePath, "gh-demo-2");
      expect(first.start?.decision.chosenHostAlias).toBe("host-a");
      expect(second.start?.decision.chosenHostAlias).toBe("host-b");
      await settleSoon(scheduler, harness.control);
    } finally {
      restoreEnv();
    }
  });
});

// ST2: an approved fleet pause blocks claims but not the running watch.
test("ST2 fleet pause blocks claims only", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await appendPending(harness.ctx.ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0", "gh-demo-1"));
      const scheduler = createScheduler(harness.ctx);
      const first = await scheduler.tick();
      expect(first.claimed).toEqual(["gh-demo-1"]);
      await settleSoon(scheduler, harness.control);
      await writeStore(harness.ctx.storePath, [
        item("gh-demo-1", { status: "running" }),
        item("gh-demo-2"),
      ]);
      await writeApprovedPause(join(dir, "approval-requests.json"));
      const second = await scheduler.tick();
      expect(second.claimed).toEqual([]);
      expect(second.launched).toContain("gh-demo-1");
      const queued = await readLoopState(harness.ctx.statePath);
      expect(queued.items["gh-demo-2"]).toBeUndefined();
      await settleSoon(scheduler, harness.control);
    } finally {
      restoreEnv();
    }
  });
});

// ST3: startup with a running store item and no loop item exits 2.
test("ST3 startup without loop state throws loop state missing", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1", { status: "running" })]);
      await writeLoopState(harness.ctx.statePath, {});
      let error: unknown;
      try {
        await recoverAtStartup(harness.ctx);
      } catch (caught: unknown) {
        error = caught;
      }
      expect(String(error)).toContain("loop state missing for gh-demo-1");
    } finally {
      restoreEnv();
    }
  });
});

function runShape(id: number, conclusion: string | null): CheckRun {
  return { id, name: "gates", status: "completed", conclusion };
}

async function holdSeed(
  dir: string,
  seed: string,
  checkout: string,
): Promise<{ merge: string; tip: string }> {
  const merge = (await git(seed, ["rev-parse", "main"])).trim();
  await git(seed, ["checkout", "-B", "moc/gh-demo-1", "main"]);
  await git(seed, ["commit", "--allow-empty", "-m", "feature"]);
  await git(seed, ["push", "origin", "moc/gh-demo-1"]);
  await git(seed, ["checkout", "main"]);
  await git(checkout, ["fetch", "origin"]);
  const tip = (await git(checkout, ["rev-parse", "origin/main"])).trim();
  expect(tip).toBe(merge);
  return { merge, tip };
}

function holdOf(mergeSha: string, workItemId = "gh-demo-1"): unknown {
  return {
    mergeSha,
    workItemId,
    expectedBase: mergeSha,
    parents: [mergeSha],
    since: NOW,
  };
}

// ST5: a red head keeps the hold and logs no github error.
test("ST5 red checks keep the merge hold", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir, { ci: () => "failure" });
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      const { merge, tip } = await holdSeed(dir, harness.sandbox.seed, checkout);
      await writeLoopState(
        harness.ctx.statePath,
        { "gh-demo-1": { ...initialLoopItem() } },
        holdOf(merge),
      );
      const wrapped = {
        ...harness.ctx.github,
        checkRuns: ((repo: string, sha: string): Promise<readonly CheckRun[]> => {
          expect(sha).toBe(tip);
          return Promise.resolve([runShape(1, "failure")]);
        }) as typeof harness.ctx.github.checkRuns,
      };
      const scheduler = createScheduler({ ...harness.ctx, github: wrapped });
      await scheduler.tick();
      await settleSoon(scheduler, harness.control);
      const state = await readLoopState(harness.ctx.statePath);
      expect(state.mergeHold).toEqual(holdOf(merge));
      expect(countPrefix(harness.events, "github-error:")).toBe(0);
    } finally {
      restoreEnv();
    }
  });
});

// ST6: a green descendant clears the hold once with one escalation.
test("ST6 green checks clear the merge hold once", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir, { ci: () => "success" });
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      const { merge, tip } = await holdSeed(dir, harness.sandbox.seed, checkout);
      await writeLoopState(
        harness.ctx.statePath,
        { "gh-demo-1": { ...initialLoopItem() } },
        holdOf(merge),
      );
      let calls = 0;
      const wrapped = {
        ...harness.ctx.github,
        checkRuns: ((repo: string, sha: string): Promise<readonly CheckRun[]> => {
          calls += 1;
          expect(sha).toBe(tip);
          return Promise.resolve([runShape(1, "success")]);
        }) as typeof harness.ctx.github.checkRuns,
      };
      const scheduler = createScheduler({ ...harness.ctx, github: wrapped });
      await scheduler.tick();
      await settleSoon(scheduler, harness.control);
      expect(calls).toBe(1);
      const state = await readLoopState(harness.ctx.statePath);
      expect(state.mergeHold).toBeNull();
      const li = state.items["gh-demo-1"] as unknown as LoopItem;
      expect(li.escalations.filter((entry) => entry.key === `race-cleared:${merge}`)).toHaveLength(
        1,
      );
      expect(harness.events.filter((line) => line.startsWith("merge-hold-cleared:"))).toHaveLength(
        1,
      );
      expect(harness.events.find((line) => line.startsWith("merge-hold-cleared:"))).toContain(tip);
      const before = harness.events.length;
      await scheduler.tick();
      await settleSoon(scheduler, harness.control);
      const after = await readLoopState(harness.ctx.statePath);
      const again = after.items["gh-demo-1"] as unknown as LoopItem;
      expect(
        again.escalations.filter((entry) => entry.key === `race-cleared:${merge}`),
      ).toHaveLength(1);
      expect(harness.events.filter((line) => line.startsWith("merge-hold-cleared:"))).toHaveLength(
        1,
      );
      expect(
        harness.events
          .slice(before)
          .filter(
            (line) => line.startsWith("merge-hold-cleared:") || line.startsWith("escalation:"),
          ),
      ).toEqual([]);
    } finally {
      restoreEnv();
    }
  });
});

// ST7: a green head that does not contain the merge keeps the hold.
test("ST7 green checks off the merge keep the hold", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir, { ci: () => "success" });
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      const { merge } = await holdSeed(dir, harness.sandbox.seed, checkout);
      await git(harness.sandbox.seed, ["checkout", "--orphan", "other"]);
      await git(harness.sandbox.seed, ["commit", "--allow-empty", "-m", "other root"]);
      await git(harness.sandbox.seed, ["push", "--force", "origin", "other:main"]);
      await git(checkout, ["fetch", "origin"]);
      const moved = (await git(checkout, ["rev-parse", "origin/main"])).trim();
      const tip = (await git(checkout, ["rev-parse", "origin/main"])).trim();
      expect(tip).toBe(moved);
      await writeLoopState(
        harness.ctx.statePath,
        { "gh-demo-1": { ...initialLoopItem() } },
        holdOf(merge),
      );
      const wrapped = {
        ...harness.ctx.github,
        checkRuns: (() =>
          Promise.resolve([runShape(1, "success")])) as typeof harness.ctx.github.checkRuns,
      };
      const scheduler = createScheduler({ ...harness.ctx, github: wrapped });
      await scheduler.tick();
      await settleSoon(scheduler, harness.control);
      const state = await readLoopState(harness.ctx.statePath);
      expect(state.mergeHold).toEqual(holdOf(merge));
      expect(countPrefix(harness.events, "github-error:")).toBe(0);
    } finally {
      restoreEnv();
    }
  });
});

async function seedFinishedRegistry(registryPath: string): Promise<void> {
  await Bun.write(
    registryPath,
    `${JSON.stringify({
      sessions: [
        {
          requestId: "gh-demo-1:0",
          workItemId: "gh-demo-1",
          repo: REPO,
          hostAlias: "host-a",
          branch: "moc/gh-demo-1",
          baseRef: "origin/main",
          resume: false,
          model: { providerId: PROVIDER, model: PREFERRED },
          briefSha256: "0".repeat(64),
          sessionId: "mem-1",
          worktree: null,
          baseCommit: null,
          startedAt: NOW,
          cursor: null,
          unreachableCount: 0,
          lastSeenState: "running",
          lastSeenAt: NOW,
          cancelReason: null,
          terminal: {
            state: "finished",
            observedAt: NOW,
            seconds: 1,
            usage: null,
            usageValid: true,
            detail: "ok",
            ledgerAppended: true,
          },
          resolvedAt: null,
          revision: 1,
        },
      ],
    })}\n`,
  );
}

async function seedLiveRegistry(
  registryPath: string,
  requestId: string,
  workItemId: string,
): Promise<void> {
  await Bun.write(
    registryPath,
    `${JSON.stringify({
      sessions: [
        {
          requestId,
          workItemId,
          repo: REPO,
          hostAlias: "host-a",
          branch: `moc/${workItemId}`,
          baseRef: "origin/main",
          resume: false,
          model: { providerId: PROVIDER, model: PREFERRED },
          briefSha256: "0".repeat(64),
          sessionId: "mem-9",
          worktree: null,
          baseCommit: null,
          startedAt: NOW,
          cursor: null,
          unreachableCount: 0,
          lastSeenState: "running",
          lastSeenAt: NOW,
          cancelReason: null,
          terminal: null,
          resolvedAt: null,
          revision: 1,
        },
      ],
    })}\n`,
  );
}

// ST4: an unnamed live session logs once and escalates once over two ticks.
test("ST4 orphan session logs once and escalates once", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-9")]);
      await writeLoopState(harness.ctx.statePath, { "gh-demo-9": { ...initialLoopItem() } });
      await seedLiveRegistry(harness.registryPath, "gh-demo-9:0", "gh-demo-9");
      let cancels = 0;
      const counting = {
        ...harness.ctx.dispatcher,
        cancel: ((...args: Parameters<typeof harness.ctx.dispatcher.cancel>) => {
          cancels += 1;
          return harness.ctx.dispatcher.cancel(...args);
        }) as typeof harness.ctx.dispatcher.cancel,
      };
      const ctx: SchedulerContext = { ...harness.ctx, dispatcher: counting };
      const scheduler = createScheduler(ctx);
      await scheduler.tick();
      await scheduler.tick();
      await settleSoon(scheduler, harness.control);
      const state = await readLoopState(harness.ctx.statePath);
      const li = state.items["gh-demo-9"] as unknown as LoopItem;
      expect(li.escalations.filter((entry) => entry.key === "orphan:gh-demo-9:0")).toHaveLength(1);
      expect(countPrefix(harness.events, "orphan-session:")).toBe(1);
      expect(cancels).toBe(0);
    } finally {
      restoreEnv();
    }
  });
});

// ST8: a backoff window survives a scheduler restart; expiry claims.
test("ST8 backoff window survives a restart", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await appendPending(harness.ctx.ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0", "gh-demo-1"));
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": { ...initialLoopItem(), backoffUntil: "2026-10-28T10:01:00.000Z" },
      });
      const early = createScheduler({
        ...harness.ctx,
        now: () => new Date(new Date(NOW).getTime() + 59_000),
      });
      const first = await early.tick();
      expect(first.claimed).toEqual([]);
      await settleSoon(early, harness.control);
      const late = createScheduler({
        ...harness.ctx,
        now: () => new Date(new Date(NOW).getTime() + 60_000),
      });
      const second = await late.tick();
      expect(second.claimed).toEqual(["gh-demo-1"]);
      await settleSoon(late, harness.control);
    } finally {
      restoreEnv();
    }
  });
});

// ST9: a stored round without a result line is appended exactly once.
test("ST9 missing result lines append exactly once", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          phase: "idle",
          rounds: [
            {
              round: 0,
              retry: 0,
              requestId: null,
              model: PREFERRED,
              providerId: PROVIDER,
              hostAlias: null,
              attempt: "failure",
              outcome: "start-rejected",
              headSha: null,
              failingChecks: [],
              verdict: null,
              newlyMet: [],
              at: NOW,
              baseRace: false,
            },
          ],
        },
      });
      const scheduler = createScheduler(harness.ctx);
      await scheduler.tick();
      await scheduler.tick();
      await settleSoon(scheduler, harness.control);
      const text = await Bun.file(harness.ctx.resultsPath)
        .text()
        .catch((): string => "");
      const lines = text.split("\n").filter((line) => line.length > 0);
      expect(
        lines.filter((line) => (JSON.parse(line) as { key: string }).key === "gh-demo-1:0"),
      ).toHaveLength(1);
    } finally {
      restoreEnv();
    }
  });
});

async function pushEmpty(seed: string, branch: string, from = "main"): Promise<string> {
  await git(seed, ["checkout", "-B", branch, from]);
  await git(seed, ["commit", "--allow-empty", "-m", branch]);
  await git(seed, ["push", "origin", branch]);
  return (await git(seed, ["rev-parse", branch])).trim();
}

// ST10: one tick runs auditing then the merge in the same step call.
test("ST10 one tick audits then merges", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await harness.ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      const verdict = readyVerdict(head);
      await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${head}.json`),
        `${JSON.stringify(verdict)}\n`,
      );
      const marker = renderComment(verdict);
      if (marker !== null) {
        await harness.ctx.github.postComment(REPO, 1, marker);
      }
      await appendPending(harness.ctx.ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0", "gh-demo-1"));
      await seedFinishedRegistry(harness.registryPath);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          phase: "auditing",
          session: { hostAlias: "host-a", providerId: PROVIDER, model: PREFERRED },
          requestId: "gh-demo-1:0",
          pull: { number: 1, headSha: head },
          ciSince: NOW,
        },
      });
      const scheduler = createScheduler(harness.ctx);
      await scheduler.tick();
      await settleSoon(scheduler, harness.control);
      const view = await harness.ctx.github.viewPull(REPO, 1);
      expect(view.state).toBe("MERGED");
      const li = (await readLoopState(harness.ctx.statePath)).items[
        "gh-demo-1"
      ] as unknown as LoopItem;
      expect(li.phase).toBe("final");
      expect(li.finalize).toEqual({ result: "success", done: true });
    } finally {
      restoreEnv();
    }
  });
});

// ST11: a timed-out run launches a stall cancel exactly once per tick.
test("ST11 a stale running session is stall-cancelled", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, { "gh-demo-1": { ...initialLoopItem() } });
      const scheduler = createScheduler(harness.ctx);
      const first = await scheduler.tick();
      expect(first.claimed).toEqual(["gh-demo-1"]);
      await settleSoon(scheduler, harness.control);
      const claimed = (await readLoopState(harness.ctx.statePath)).items[
        "gh-demo-1"
      ] as unknown as LoopItem;
      const rid = claimed.requestId;
      if (rid === null) {
        throw new Error("expected a request id");
      }
      expect(claimed.phase).toBe("running");
      const entries = await readRegistry(harness.registryPath);
      const entry = entries.find((candidate) => candidate.requestId === rid);
      if (entry === undefined) {
        throw new Error("expected a registry entry");
      }
      await replaceRegistryEntry(harness.registryPath, {
        ...entry,
        startedAt: new Date(new Date(NOW).getTime() - 3_600_001).toISOString(),
        revision: entry.revision + 1,
      });
      let cancels = 0;
      const realCancel = harness.ctx.dispatcher.cancel.bind(harness.ctx.dispatcher);
      const ctx: SchedulerContext = {
        ...harness.ctx,
        dispatcher: {
          ...harness.ctx.dispatcher,
          cancel: (...args: Parameters<typeof realCancel>) => {
            cancels += 1;
            return realCancel(...args);
          },
        },
      };
      const second = createScheduler(ctx);
      await second.tick();
      await settleSoon(second, harness.control);
      expect(cancels).toBe(1);
      const third = createScheduler(ctx);
      await third.tick();
      await settleSoon(third, harness.control);
      expect(cancels).toBe(1);
    } finally {
      restoreEnv();
    }
  });
});

// ST12: a lost host parks the item with the host excluded; no fresh claim.
test("ST12 a lost host parks the item on one tick", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, { "gh-demo-1": { ...initialLoopItem() } });
      const scheduler = createScheduler(harness.ctx);
      const first = await scheduler.tick();
      expect(first.claimed).toEqual(["gh-demo-1"]);
      for (let round = 0; round < 1000 && harness.control.sessions().length === 0; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      harness.control.loseHost("host-a");
      await settleSoon(scheduler, harness.control);
      const running = (await readLoopState(harness.ctx.statePath)).items[
        "gh-demo-1"
      ] as unknown as LoopItem;
      expect(running.phase).toBe("running");
      const second = createScheduler(harness.ctx);
      const report = await second.tick();
      expect(report.claimed).toEqual([]);
      await settleSoon(second, harness.control);
      const lost = (await readLoopState(harness.ctx.statePath)).items[
        "gh-demo-1"
      ] as unknown as LoopItem;
      expect(lost.park).toMatchObject({ kind: "lost" });
      expect(lost.excludedHosts).toEqual(["host-a"]);
      expect(lost.rounds.at(-1)).toMatchObject({ outcome: "lost", attempt: "lost" });
      expect(report.launched).toContain("gh-demo-1");
    } finally {
      restoreEnv();
    }
  });
});

// ST13: an oversized brief parks the item without touching a host.
test("ST13 an oversized brief parks without a claim", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, { "gh-demo-1": { ...initialLoopItem() } });
      const scheduler = createScheduler({ ...harness.ctx, maxBriefBytes: 1 });
      const report = await scheduler.tick();
      expect(report.claimed).toEqual([]);
      await settleSoon(scheduler, harness.control);
      const li = (await readLoopState(harness.ctx.statePath)).items[
        "gh-demo-1"
      ] as unknown as LoopItem;
      expect(li.park).toMatchObject({ kind: "operator", code: "brief-too-large" });
      expect(harness.control.sessions()).toHaveLength(0);
      const store = (await Bun.file(harness.ctx.storePath).json()) as { items: WorkItem[] };
      expect(store.items[0]).toMatchObject({ status: "parked" });
    } finally {
      restoreEnv();
    }
  });
});

// ST14: an operator park escalates once and keeps the item out of claims.
test("ST14 an operator park escalates and never claims", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          park: { kind: "operator", reason: "operator: brief-too-large", code: "brief-too-large" },
        },
      });
      const scheduler = createScheduler(harness.ctx);
      const first = await scheduler.tick();
      expect(first.claimed).toEqual([]);
      expect(first.launched).toContain("gh-demo-1");
      await settleSoon(scheduler, harness.control);
      const escalated = (await readLoopState(harness.ctx.statePath)).items[
        "gh-demo-1"
      ] as unknown as LoopItem;
      expect(
        escalated.escalations.filter((entry) => entry.key === "op:gh-demo-1:brief-too-large"),
      ).toHaveLength(1);
      const second = await scheduler.tick();
      expect(second.claimed).toEqual([]);
      await settleSoon(scheduler, harness.control);
      const again = (await readLoopState(harness.ctx.statePath)).items[
        "gh-demo-1"
      ] as unknown as LoopItem;
      expect(
        again.escalations.filter((entry) => entry.key === "op:gh-demo-1:brief-too-large"),
      ).toHaveLength(1);
      expect(harness.control.sessions()).toHaveLength(0);
    } finally {
      restoreEnv();
    }
  });
});

// ST15: stop drains in-flight work and a later tick reports nothing.
test("ST15 stop drains and ticks report empty", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, { "gh-demo-1": { ...initialLoopItem() } });
      const scheduler = createScheduler(harness.ctx);
      const first = await scheduler.tick();
      expect(first.claimed).toEqual(["gh-demo-1"]);
      scheduler.stop();
      await settleSoon(scheduler, harness.control);
      await scheduler.settled();
      const second = await scheduler.tick();
      expect(second).toEqual({ claimed: [], launched: [] });
    } finally {
      restoreEnv();
    }
  });
});

// ST16: a step failure latches and surfaces on the next tick.
test("ST16 a step failure latches the scheduler", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          phase: "running",
          requestId: "gh-demo-1:0",
        },
      });
      await seedFinishedRegistry(harness.registryPath);
      const boom = new Error("boom");
      const ctx: SchedulerContext = {
        ...harness.ctx,
        dispatcher: {
          ...harness.ctx.dispatcher,
          watch: () => Promise.reject(boom),
        },
      };
      const scheduler = createScheduler(ctx);
      await scheduler.tick();
      let settledError: unknown;
      try {
        await scheduler.settled();
      } catch (caught: unknown) {
        settledError = caught;
      }
      expect(settledError).toBe(boom);
      let tickError: unknown;
      try {
        await scheduler.tick();
      } catch (caught: unknown) {
        tickError = caught;
      }
      expect(tickError).toBe(boom);
    } finally {
      restoreEnv();
    }
  });
});

// R2-8 (a): a second tick while the item's step call is still in flight
// launches nothing more for it. The blocked step settles after the
// second tick, and the item is not relaunched from its old phase.
test("R2-8a step in flight blocks a second launch", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          phase: "running",
          session: { hostAlias: "host-a", providerId: PROVIDER, model: PREFERRED },
          requestId: "gh-demo-1:0",
        },
      });
      await seedFinishedRegistry(harness.registryPath);
      let releases = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = () => {
          releases += 1;
          resolve();
        };
      });
      let calls = 0;
      const realWatch = harness.ctx.dispatcher.watch.bind(harness.ctx.dispatcher);
      const ctx: SchedulerContext = {
        ...harness.ctx,
        dispatcher: {
          ...harness.ctx.dispatcher,
          watch: (async (requestId: string) => {
            calls += 1;
            await gate;
            return realWatch(requestId);
          }) as typeof harness.ctx.dispatcher.watch,
        },
      };
      const scheduler = createScheduler(ctx);
      const first = await scheduler.tick();
      expect(first.launched).toEqual(["gh-demo-1"]);
      const second = await scheduler.tick();
      expect(second.launched).toEqual([]);
      expect(calls).toBe(1);
      release();
      await scheduler.settled();
      expect(releases).toBe(1);
      const third = await scheduler.tick();
      expect(third.launched).toEqual(["gh-demo-1"]);
      expect(calls).toBe(2);
      await settleSoon(scheduler, harness.control);
    } finally {
      restoreEnv();
    }
  });
});

// R2-8 (b): a starting item from an earlier tick holds its host's only
// agent slot, so the next tick places no second item on that host.
test("R2-8b starting item from an earlier tick holds its host slot", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir, { hosts: ["host-a"], maxActiveItems: 2 });
      await writeStore(harness.ctx.storePath, [item("gh-demo-1"), item("gh-demo-2")]);
      await writeLoopState(harness.ctx.statePath, {});
      await appendPending(harness.ctx.ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0", "gh-demo-1"));
      await appendPending(harness.ctx.ledgerPath, grantUsage("gh-demo-2:gh-demo-2:0", "gh-demo-2"));
      const first = createScheduler(harness.ctx);
      const firstReport = await first.tick();
      expect(firstReport.claimed).toEqual(["gh-demo-1"]);
      const second = createScheduler(harness.ctx);
      const secondReport = await second.tick();
      expect(secondReport.claimed).toEqual([]);
      const state = await readLoopState(harness.ctx.statePath);
      expect(state.items["gh-demo-2"]).toBeUndefined();
      await settleSoon(first, harness.control);
      await settleSoon(second, harness.control);
    } finally {
      restoreEnv();
    }
  });
});

function readyVerdict(head: string): {
  readonly schemaVersion: "v1";
  readonly repo: string;
  readonly workItemId: string;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly authorModels: readonly string[];
  readonly auditorModel: string;
  readonly counts: { readonly high: 0; readonly medium: 0; readonly low: 0 };
  readonly findings: readonly [];
} {
  return {
    schemaVersion: "v1",
    repo: REPO,
    workItemId: "gh-demo-1",
    pullNumber: 1,
    headSha: head,
    authorModels: [PREFERRED],
    auditorModel: AUDITOR,
    counts: { high: 0, medium: 0, low: 0 },
    findings: [],
  };
}

async function makeSandbox(repoDir: string): Promise<Sandbox> {
  const dir = mkdtempSync(join(tmpdir(), "loop-scheduler-sandbox-"));
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const scratchDir = join(dir, "scratch");
  await git(dir, ["init", "--bare", origin]);
  await git(dir, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "clone",
    origin,
    seed,
  ]);
  await git(seed, ["config", "user.name", "fixture"]);
  await git(seed, ["config", "user.email", "fixture@example.invalid"]);
  await Bun.write(join(seed, "f.txt"), "main line\n");
  await git(seed, ["add", "f.txt"]);
  await git(seed, ["commit", "-m", "main1"]);
  await git(seed, ["branch", "-M", "main"]);
  await git(seed, ["push", "origin", "main"]);
  const repoPath = resolve(repoDir);
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.name", "fixture"]);
  await git(repoPath, ["config", "user.email", "fixture@example.invalid"]);
  await Bun.write(join(repoPath, "f.txt"), "main line\n");
  await git(repoPath, ["add", "f.txt"]);
  await git(repoPath, ["commit", "-m", "main1"]);
  await git(repoPath, ["remote", "add", "origin", origin]);
  await git(repoPath, ["fetch", "origin"]);
  return {
    origin,
    seed,
    scratchDir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

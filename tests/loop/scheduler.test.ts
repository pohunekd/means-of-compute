// Scheduler tests: the smoke (ST10: one tick audits, then merges) and the
// regressions for F2 (R2-8a, stale loop item) and F1 (R2-8b, starting slot).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkItem } from "../../contracts/v1/types.js";
import type { HostCapacity } from "../../contracts/v1/types.js";
import type { LoopLog } from "../../src/loop/log.js";
import { PortRejectedError } from "../../src/dispatcher/port.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import type { GitDeps } from "../../src/loop/git.js";
import { createStubGitHub, type StubCi } from "../../src/loop/stub/github.js";
import { readLoopState, updateLoopState } from "../../src/loop/state.js";
import type { LoopItem, RoundRecord } from "../../src/loop/types.js";
import { readRegistry } from "../../src/dispatcher/registry.js";
import { initialLoopItem } from "../../src/loop/start.js";
import { updateWorkStore } from "../../src/work/store.js";
import { appendPending } from "../../src/ledger/store.js";
import type { PendingUsage } from "../../src/ledger/types.js";
import { createCollector } from "../../src/hoststate/collector.js";
import { createMemoryHostStatePort } from "../../src/hoststate/memory-port.js";
import type { HostStateConfig } from "../../src/hoststate/config.js";
import { createApprovalsView } from "../../src/loop/approvals-view.js";
import { createMergeMutex } from "../../src/loop/merge.js";
import { renderComment } from "../../src/auditor/verdict.js";
import { createScheduler, type SchedulerContext } from "../../src/loop/scheduler.js";
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
    followupLabels: ["factory:followup", "readiness:design-needed"],
    verdictDir: join(dir, "verdicts"),
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
    checkExcerpt: { maxBytes: 4000, stripPrefixes: [] },
    ciTimeoutMs: 600_000,
    auditRetries: 1,
    auditor: {
      config: {
        verdictDir,
        maxDiffBytes: 1_000_000,
        auditors: [{ providerId: PROVIDER, model: "test-auditor" }],
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
    hostCooldown: { rejections: 3, windowMs: 600_000, cooldownMs: 900_000 },
    retireRetryMs: 60_000,
    ciPollMs: overrides.ciPollMs ?? 30_000,
    intake: {
      enabled: false,
      optInLabel: "factory:auto",
      readyLabel: "readiness:ready",
      blockedLabel: "readiness:blocked",
      pollMs: 300_000,
      defaultModel: PREFERRED,
      maxGoalChars: 12_000,
    },
    trustedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
    maxItemBytes: 16_384,
    digestDir: join(dir, "digest"),
    providersDir: "config/providers",
    nvidiaProviderId: "nvidia-build",
    spendBounds: {
      auditCall: { inputTokens: 262144, outputTokens: 65536 },
      meterCall: { inputTokens: 16777216, outputTokens: 65536 },
    },
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

// Waits, through the loop state lock, until the item satisfies the check.
// Holding the lock means the writer that made the change has released it.
async function untilItem(
  statePath: string,
  id: string,
  check: (li: LoopItem | undefined) => boolean,
): Promise<LoopItem | undefined> {
  for (let round = 0; round < 1000; round += 1) {
    const li = await updateLoopState(statePath, (state) =>
      Promise.resolve({ next: null, value: state.items[id] as unknown as LoopItem }),
    );
    if (check(li)) {
      return li;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`item ${id} never reached the expected state`);
}

async function seedFinishedRegistry(registryPath: string, workItemId = "gh-demo-1"): Promise<void> {
  await Bun.write(
    registryPath,
    `${JSON.stringify({
      sessions: [
        {
          requestId: `${workItemId}:0`,
          workItemId,
          repo: REPO,
          hostAlias: "host-a",
          branch: `moc/${workItemId}`,
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

// R2-8 (a), the F2 regression: a tick launches nothing for gh-demo-2 while
// its watch is in flight. Then gh-demo-2's watch finishes while the next
// tick is held inside gh-demo-1's reconcile, so gh-demo-2's loop item must
// be read after that reconcile. The tick reads storePath four times before
// that reconcile (tick start, orphan pass, pre-loop store read, the
// reconcile call); the fourth read takes the work store lock first, so the
// reconcile waits behind it until the test opens the gate.
test("R2-8a step in flight blocks a second launch", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir, { maxActiveItems: 0 });
      await writeStore(harness.ctx.storePath, [item("gh-demo-1"), item("gh-demo-2")]);
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          phase: "final",
          finalize: { result: "success", done: true },
        },
        "gh-demo-2": {
          ...initialLoopItem(),
          phase: "running",
          session: { hostAlias: "host-b", providerId: PROVIDER, model: PREFERRED },
          requestId: "gh-demo-2:0",
        },
      });
      await seedFinishedRegistry(harness.registryPath, "gh-demo-2");
      let releaseWatch!: () => void;
      const watchGate = new Promise<void>((resolve) => {
        releaseWatch = resolve;
      });
      const realWatch = harness.ctx.dispatcher.watch.bind(harness.ctx.dispatcher);
      const ctx: SchedulerContext = {
        ...harness.ctx,
        dispatcher: {
          ...harness.ctx.dispatcher,
          watch: async (requestId: string) => {
            if (requestId === "gh-demo-2:0") {
              await watchGate;
            }
            return realWatch(requestId);
          },
        },
      };
      const storePath = harness.ctx.storePath;
      let storeReads = 0;
      let armed = false;
      let openStore!: () => void;
      const storeGate = new Promise<void>((resolve) => {
        openStore = resolve;
      });
      let markHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        markHeld = resolve;
      });
      let holder!: Promise<void>;
      Object.defineProperty(ctx, "storePath", {
        get: () => {
          if (armed) {
            storeReads += 1;
            if (storeReads === 4) {
              holder = updateWorkStore(storePath, async () => {
                markHeld();
                await storeGate;
                return { next: null, value: undefined };
              });
            }
          }
          return storePath;
        },
      });
      const scheduler = createScheduler(ctx);
      const first = await scheduler.tick();
      expect(first.launched).toEqual(["gh-demo-2"]);
      await scheduler.settled();
      const blocked = await scheduler.tick();
      expect(blocked.launched).toEqual([]);
      await scheduler.settled();
      armed = true;
      const secondTick = scheduler.tick();
      const reached = await Promise.race([
        held.then(() => "held" as const),
        secondTick.then(() => "tick-finished" as const),
      ]);
      expect(reached).toBe("held");
      releaseWatch();
      await untilItem(ctx.statePath, "gh-demo-2", (li) => li?.phase !== "running");
      openStore();
      await holder;
      const second = await secondTick;
      expect(second.launched).toEqual(["gh-demo-2"]);
      const outcome = await scheduler.settled().then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect(outcome).toBe("resolved");
      const finished = (await readLoopState(ctx.statePath)).items[
        "gh-demo-2"
      ] as unknown as LoopItem;
      expect(finished.phase).not.toBe("running");
      expect(finished.rounds.at(-1)?.outcome).toBe("no-push");
    } finally {
      restoreEnv();
    }
  });
});

// R3-3 (b): gh-demo-1 stays in starting across the second tick because
// the gated port holds driveStart open; the held slot keeps gh-demo-2
// unclaimed even though the tick would otherwise place it.
test("R2-8b starting item from an earlier tick holds its host slot", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir, { hosts: ["host-a"], maxActiveItems: 2 });
      await writeStore(harness.ctx.storePath, [item("gh-demo-1"), item("gh-demo-2")]);
      await writeLoopState(harness.ctx.statePath, {});
      await appendPending(harness.ctx.ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0", "gh-demo-1"));
      await appendPending(harness.ctx.ledgerPath, grantUsage("gh-demo-2:gh-demo-2:0", "gh-demo-2"));
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = () => {
          resolve();
        };
      });
      const realStart = harness.ctx.dispatcher.start.bind(harness.ctx.dispatcher);
      const gatedStart: typeof realStart = (...args) => {
        if (args[0].id === "gh-demo-1") {
          return startGate.then(() => realStart(...args));
        }
        return realStart(...args);
      };
      const ctx: SchedulerContext = {
        ...harness.ctx,
        dispatcher: {
          ...harness.ctx.dispatcher,
          start: gatedStart,
        },
      };
      const first = createScheduler(ctx);
      const firstTick = first.tick();
      await untilItem(harness.ctx.statePath, "gh-demo-1", (li) => li?.phase === "starting");
      const firstReport = await firstTick;
      expect(firstReport.claimed).toEqual(["gh-demo-1"]);
      const second = createScheduler(ctx);
      const secondReport = await second.tick();
      expect(secondReport.claimed).toEqual([]);
      const held = await readLoopState(harness.ctx.statePath);
      expect(held.items["gh-demo-1"]?.phase).toBe("starting");
      expect(held.items["gh-demo-2"]).toBeUndefined();
      releaseStart();
      await untilItem(harness.ctx.statePath, "gh-demo-1", (li) => li?.phase !== "starting");
      await settleSoon(first, harness.control);
      await settleSoon(second, harness.control);
    } finally {
      restoreEnv();
    }
  });
});

// B1: one routed host sits in excludedHosts while the item already
// counts two startRejections. The next tick claims the same host again
// through the exclusion retry and logs exclusions-retried. The port
// rejects that start, and the rejection parks the item as operator
// start-rejected through the existing start.ts path.
test("B1 a claim retries the excluded host and parks at maxStartRejections", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir, { hosts: ["host-a"] });
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          excludedHosts: ["host-a"],
          startRejections: 2,
        },
      });
      await appendPending(harness.ctx.ledgerPath, grantUsage("gh-demo-1:gh-demo-1:0", "gh-demo-1"));
      const ctx: SchedulerContext = {
        ...harness.ctx,
        dispatcher: {
          ...harness.ctx.dispatcher,
          start: () =>
            Promise.reject(new PortRejectedError("host-unsupported", "host host-a rejects starts")),
        },
      };
      const scheduler = createScheduler(ctx);
      const report = await scheduler.tick();
      await scheduler.settled();
      expect(report.claimed).toEqual(["gh-demo-1"]);
      const retry = harness.events.find((line) => line.startsWith("exclusions-retried:"));
      expect(retry).toBe("exclusions-retried::host-a::::");
      const parked = (await readLoopState(ctx.statePath)).items["gh-demo-1"] as unknown as LoopItem;
      expect(parked.park).toMatchObject({ kind: "operator", code: "start-rejected" });
      expect(parked.startRejections).toBe(3);
      expect(parked.excludedHosts).toContain("host-a");
    } finally {
      restoreEnv();
    }
  });
});

// Row 2: a cooled host is skipped for every item, also by the exclusions retry.
test("a cooled host is skipped for every item, also by the exclusions retry", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir, { hosts: ["host-a"] });
      await writeStore(harness.ctx.storePath, [item("gh-demo-1"), item("gh-demo-2")]);
      const rejected = (n: number, at: string): RoundRecord => ({
        round: n,
        retry: 0,
        requestId: null,
        model: PREFERRED,
        providerId: PROVIDER,
        hostAlias: "host-a",
        attempt: "failure",
        outcome: "start-rejected",
        headSha: null,
        failingChecks: [],
        verdict: null,
        newlyMet: [],
        at,
        baseRace: false,
      });
      const end = Date.parse(NOW) - 30_000 + 900_000;
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          phase: "final",
          finalize: { result: "success", done: true },
          rounds: [
            rejected(0, new Date(Date.parse(NOW) - 120_000).toISOString()),
            rejected(1, new Date(Date.parse(NOW) - 60_000).toISOString()),
            rejected(2, new Date(Date.parse(NOW) - 30_000).toISOString()),
          ],
        },
        "gh-demo-2": { ...initialLoopItem(), excludedHosts: ["host-a"] },
      });
      const scheduler = createScheduler(harness.ctx);
      const first = await scheduler.tick();
      await scheduler.settled();
      const second = await scheduler.tick();
      await scheduler.settled();
      expect(first.claimed).toEqual([]);
      expect(second.claimed).toEqual([]);
      const cooldowns = harness.events.filter((line) => line.startsWith("host-cooldown:"));
      expect(cooldowns).toHaveLength(1);
      expect(cooldowns[0]).toBe(`host-cooldown::${new Date(end).toISOString()}::::host-a`);
      expect(harness.events.some((line) => line.startsWith("exclusions-retried:"))).toBe(false);
      expect(harness.events.some((line) => line.startsWith("no-host:"))).toBe(true);
    } finally {
      restoreEnv();
    }
  });
});

// Rule A (160a): both routine models authored the item, so no auditor
// stays eligible. The claim parks operator no-eligible-auditor before
// any session starts: no registry entry, a parked log line, no claim.
test("rule A parks the claim when no auditor stays eligible (160a)", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      const sparkEntry = grantUsage("gh-demo-1:gh-demo-1:0", "gh-demo-1");
      await appendPending(harness.ctx.ledgerPath, sparkEntry);
      await appendPending(harness.ctx.ledgerPath, {
        ...grantUsage("gh-demo-1:gh-demo-1:1", "gh-demo-1"),
        startModel: AUDITOR,
        tokens: [
          {
            provider: "nvidia-build",
            model: AUDITOR,
            inputTokens: 0,
            outputTokens: 0,
            requests: 0,
            source: "meter",
          },
        ],
      });
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, {});
      const ctx: SchedulerContext = {
        ...harness.ctx,
        auditor: {
          ...harness.ctx.auditor,
          config: {
            ...harness.ctx.auditor.config,
            auditors: [
              { providerId: PROVIDER, model: PREFERRED },
              { providerId: "nvidia-build", model: AUDITOR },
            ],
          },
        },
      };
      const scheduler = createScheduler(ctx);
      const report = await scheduler.tick();
      await scheduler.settled();
      expect(report.claimed).toEqual([]);
      const li = (await readLoopState(ctx.statePath)).items["gh-demo-1"] as unknown as LoopItem;
      expect(li.park).toMatchObject({ kind: "operator", code: "no-eligible-auditor" });
      expect(harness.control.sessions()).toEqual([]);
      const entries = await readRegistry(harness.registryPath);
      expect(entries.some((e) => e.workItemId === "gh-demo-1")).toBe(false);
      expect(harness.events.find((line) => line.startsWith("parked:"))).toBe(
        "parked:no-eligible-auditor:::::",
      );
      expect(harness.events.some((line) => line.startsWith("claim:"))).toBe(false);
    } finally {
      restoreEnv();
    }
  });
});

// Retire sweep: a settled, ledgered entry no loop item names belongs to a
// closed round, so one tick removes its session from the host.
test("a tick retires the session of a closed round", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      const handle = await harness.control.port.start({
        requestId: "gh-demo-1:0",
        workItemId: "gh-demo-1",
        repo: REPO,
        hostAlias: "host-a",
        branch: "moc/gh-demo-1",
        baseRef: "origin/main",
        resume: false,
        model: { providerId: PROVIDER, model: PREFERRED },
        brief: "Do the work.",
      });
      expect(handle.sessionId).toBe("mem-1");
      harness.control.complete("mem-1", { state: "finished", usage: null, detail: "ok" });
      await seedFinishedRegistry(harness.registryPath);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          phase: "final",
          finalize: { result: "success", done: true },
        },
      });
      const scheduler = createScheduler(harness.ctx);
      await scheduler.tick();
      await scheduler.settled();
      expect(harness.control.sessions()).toEqual([]);
      expect(harness.events.some((line) => line.startsWith("retire-failed:"))).toBe(false);
      const marked = (await readRegistry(harness.registryPath)).find(
        (entry) => entry.requestId === "gh-demo-1:0",
      );
      expect(marked?.retiredAt).toBe(harness.nowValue.current.toISOString());
      harness.control.setUnreachable("host-a", true);
      const restarted = createScheduler(harness.ctx);
      await restarted.tick();
      await restarted.settled();
      expect(harness.events.some((line) => line.startsWith("retire-failed:"))).toBe(false);
    } finally {
      restoreEnv();
    }
  });
});

// Retire sweep: an unreachable host refuses the retire, so the sweep logs
// retire-failed and leaves the item; once retireRetryMs passes the next
// tick removes the session.
test("an unreachable retire is logged, retried after retireRetryMs, and leaves the item", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      const handle = await harness.control.port.start({
        requestId: "gh-demo-1:0",
        workItemId: "gh-demo-1",
        repo: REPO,
        hostAlias: "host-a",
        branch: "moc/gh-demo-1",
        baseRef: "origin/main",
        resume: false,
        model: { providerId: PROVIDER, model: PREFERRED },
        brief: "Do the work.",
      });
      expect(handle.sessionId).toBe("mem-1");
      harness.control.complete("mem-1", { state: "finished", usage: null, detail: "ok" });
      await seedFinishedRegistry(harness.registryPath);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          phase: "final",
          finalize: { result: "success", done: true },
        },
      });
      harness.control.setUnreachable("host-a", true);
      const scheduler = createScheduler(harness.ctx);
      await scheduler.tick();
      await scheduler.settled();
      expect(harness.control.sessions()).toHaveLength(1);
      const failures = harness.events.filter((line) => line.startsWith("retire-failed:"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBe("retire-failed:unreachable::::gh-demo-1:0:host-a");
      const parked = (await readLoopState(harness.ctx.statePath)).items[
        "gh-demo-1"
      ] as unknown as LoopItem;
      expect(parked.phase).toBe("final");
      harness.control.setUnreachable("host-a", false);
      await scheduler.tick();
      await scheduler.settled();
      expect(harness.control.sessions()).toHaveLength(1);
      expect(harness.events.filter((line) => line.startsWith("retire-failed:"))).toHaveLength(1);
      harness.nowValue.current = new Date(harness.nowValue.current.getTime() + 60_000);
      await scheduler.tick();
      await scheduler.settled();
      expect(harness.control.sessions()).toEqual([]);
    } finally {
      restoreEnv();
    }
  });
});

// Retire sweep: an error the adapter does not map is logged with its name and
// retried like a refusal; it never stops the scheduler.
test("an unmapped retire error logs retire-failed and the scheduler keeps ticking", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    try {
      const harness = await makeHarness(dir);
      await seedFinishedRegistry(harness.registryPath);
      await writeStore(harness.ctx.storePath, [item("gh-demo-1")]);
      await writeLoopState(harness.ctx.statePath, {
        "gh-demo-1": {
          ...initialLoopItem(),
          phase: "final",
          finalize: { result: "success", done: true },
        },
      });
      const scheduler = createScheduler({
        ...harness.ctx,
        dispatcher: {
          ...harness.ctx.dispatcher,
          retire: () => Promise.reject(new TypeError("command unsupported")),
        },
      });
      await scheduler.tick();
      await scheduler.settled();
      expect(harness.events.filter((line) => line.startsWith("retire-failed:"))).toEqual([
        "retire-failed:TypeError::::gh-demo-1:0:host-a",
      ]);
      harness.nowValue.current = new Date(harness.nowValue.current.getTime() + 60_000);
      await scheduler.tick();
      await scheduler.settled();
      expect(harness.events.filter((line) => line.startsWith("retire-failed:"))).toHaveLength(2);
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

// Driver review tests (slice 5d rows RT1-RT21): publish, ci and audit
// through the real dispatcher, memory port and files, with one named
// mutation per row killed by its own assertion.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import { BudgetGateError } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { WorkItem } from "../../contracts/v1/types.js";
import type { ModelRequest, SingleCallResult } from "../../src/providers/router.js";
import { readLoopState } from "../../src/loop/state.js";
import type { LoopLog } from "../../src/loop/log.js";
import { initialLoopItem } from "../../src/loop/start.js";
import type { LoopItem } from "../../src/loop/types.js";
import { admittingGate, applyTestEnv, refusingGate } from "../auditor/test-env.js";
import { InputPathError } from "../../src/fs/input.js";
import { renderComment } from "../../src/auditor/verdict.js";
import { readVerdicts } from "../../src/auditor/store.js";
import { callProviderOnce } from "../../src/providers/router.js";
import { startLoopback } from "../../src/providers/loopback.js";
import { loadAuditorConfig } from "../../src/auditor/config.js";
import { GitHubError } from "../../src/loop/github.js";
import { createStubGitHub } from "../../src/loop/stub/github.js";
import type { GitDeps } from "../../src/loop/git.js";
import {
  auditStep,
  ciStep,
  failingChecksOf,
  previousRoundOf,
  publishStep,
  type ReviewContext,
} from "../../src/loop/review.js";

const PREFERRED = "muse-spark-1.3-contributor";
const PROVIDER = "meta-api";
const NOW = "2026-10-28T10:00:00.000Z";
const REPO = "example/demo";
const FACTORY_LOGIN = "moc-factory";
const FALLBACK = "muse-wonder-1.0";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    schemaVersion: "v1",
    id: "gh-demo-1",
    repo: REPO,
    title: "Demo item gh-demo-1",
    goal: "Drive a review",
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
        events.push(`${event.event}:${event.code ?? ""}:${event.detail ?? ""}:${event.sha ?? ""}`);
      },
      failed(): boolean {
        return false;
      },
      async close(): Promise<void> {},
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

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-review-"));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

const GIT_ENV = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
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
  readonly dir: string;
  readonly origin: string;
  readonly seed: string;
  readonly scratchDir: string;
  readonly cleanup: () => Promise<void>;
}

interface ReviewHarness {
  readonly ctx: ReviewContext;
  readonly events: string[];
  readonly sandbox: Sandbox;
  readonly registryPath: string;
  readonly control: ReturnType<typeof createMemoryPort>;
  readonly dispatcher: ReviewContext["dispatcher"];
}

interface SeededTerminal {
  readonly requestId: string;
  readonly session: NonNullable<LoopItem["session"]>;
}

// One finished session in the durable registry, so the watch replay
// returns attempt success without a live port call.
async function seedFinishedSession(
  registryPath: string,
  workItemId: string,
  overrides: Partial<SeededTerminal> = {},
): Promise<SeededTerminal> {
  const requestId = overrides.requestId ?? `${workItemId}:0`;
  const session = overrides.session ?? {
    hostAlias: "host-a",
    providerId: PROVIDER,
    model: PREFERRED,
  };
  await Bun.write(
    registryPath,
    `${JSON.stringify({
      sessions: [
        {
          requestId,
          workItemId,
          repo: REPO,
          hostAlias: session.hostAlias,
          branch: `moc/${workItemId}`,
          baseRef: "origin/main",
          resume: false,
          model: { providerId: session.providerId, model: session.model },
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
  return { requestId, session };
}

async function makeHarness(
  dir: string,
  overrides: Partial<ReviewContext> = {},
): Promise<ReviewHarness> {
  const seen = logged();
  const registryPath = join(dir, "registry.json");
  const control = createMemoryPort();
  const dispatcher = createDispatcher({
    port: control.port,
    budget: GATE,
    ledgerPath: join(dir, "ledger.jsonl"),
    config: configOf(registryPath),
    now: () => new Date(NOW),
    sleep: () => Promise.resolve(),
    log: () => undefined,
    settleUsage: () => Promise.resolve(null),
  });
  const checkoutDir = join(dir, "checkout");
  await mkdir(checkoutDir, { recursive: true });
  const sandbox = await makeSandbox(checkoutDir);
  const gitDeps: GitDeps = { PATH: GIT_ENV.PATH, timeoutMs: 30000 };
  const ctx: ReviewContext = {
    branchPrefix: "moc/",
    statePath: join(dir, "loop-state.json"),
    resultsPath: join(dir, "loop-results.jsonl"),
    storePath: join(dir, "work-items.json"),
    stall: { maxStagnantRounds: 3, maxRetries: 2 },
    log: seen.log,
    now: () => new Date(NOW),
    github: createStubGitHub({
      repo: REPO,
      originDir: sandbox.origin,
      baseBranch: "main",
      factoryLogin: FACTORY_LOGIN,
      git: gitDeps,
      scratchDir: sandbox.scratchDir,
      ci: () => "success",
    }),
    factoryLogin: FACTORY_LOGIN,
    ledgerPath: join(dir, "ledger.jsonl"),
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
        verdictDir: join(dir, "verdicts"),
        maxDiffBytes: 1_000_000,
        auditors: [],
        mergeAuditor: { providerId: PROVIDER, model: PREFERRED },
        maxFindings: 50,
        maxFieldChars: 2000,
      },
      budget: GATE,
      call: () => Promise.reject(new Error("no loopback wired")),
    },
    ...overrides,
  };
  return { ctx, events: seen.events, sandbox, registryPath, control, dispatcher };
}

function publishingItem(overrides: Partial<LoopItem> = {}): LoopItem {
  return {
    ...initialLoopItem(),
    phase: "publishing",
    session: { hostAlias: "host-a", providerId: PROVIDER, model: PREFERRED },
    requestId: "gh-demo-1:0",
    ...overrides,
  };
}

// The excerpt names a counting `call` wrapper, so every model call count
// is asserted instead of inferred.
function countingCall(
  calls: { count: number },
  inner: (providerId: string, request: ModelRequest) => Promise<SingleCallResult>,
): (providerId: string, request: ModelRequest) => Promise<SingleCallResult> {
  return (providerId, request) => {
    calls.count += 1;
    return inner(providerId, request);
  };
}

test("RT1 pushed head, no PR: creates the pull and moves to ci", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir, { branchPrefix: "alt/" });
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.ctx.repos[0]?.checkoutDir ?? dir, ["fetch", "origin"]);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, publishingItem());
      const step = await publishStep(harness.ctx, item());
      expect(step).toBe("ci");
      const li = await readItem(harness.ctx.statePath);
      expect(li.pull).toEqual({ number: 1, headSha: head });
      expect(li.ciSince).toBe(new Date(NOW).toISOString());
      expect(li.phase).toBe("ci");
      const stored = JSON.parse(await Bun.file(harness.ctx.storePath).text()) as {
        items: WorkItem[];
      };
      expect(stored.items[0]?.status).toBe("review");
      expect(stored.items[0]?.pullNumber).toBe(1);
      // The registry branch wins over the diverging display prefix: the
      // PR is created on moc/gh-demo-1 even though branchPrefix is alt/.
      const createdPull = (
        harness.ctx.github as unknown as {
          snapshot(): { pulls: { head: string; body: string }[] };
        }
      )
        .snapshot()
        .pulls.at(0);
      expect(createdPull?.head).toBe("moc/gh-demo-1");
      expect(createdPull?.body).toBe(
        "<!-- moc:work-item:gh-demo-1 -->\n\nDefinition of done:\n- [ ] D1: Done\n",
      );
      expect(stored.items[0]?.branch).toBe("alt/gh-demo-1");
      const pulls = harness.events.filter((line) => line.startsWith("pull:created:"));
      expect(pulls).toHaveLength(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT2 one open factory PR: adopts it and the stub holds 1 PR", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.ctx.repos[0]?.checkoutDir ?? dir, ["fetch", "origin"]);
      const github = harness.ctx.github;
      if (!("snapshot" in github)) {
        throw new Error("stub github has no snapshot");
      }
      const created = await github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      expect(created).toBe(1);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, publishingItem());
      const step = await publishStep(harness.ctx, item());
      expect(step).toBe("ci");
      const li = await readItem(harness.ctx.statePath);
      expect(li.pull).toEqual({ number: 1, headSha: head });
      const snapshot = (github as { snapshot(): { pulls: unknown[] } }).snapshot();
      expect(snapshot.pulls).toHaveLength(1);
      const adopted = harness.events.filter((line) => line.startsWith("pull:adopted:"));
      expect(adopted).toHaveLength(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT3 two open factory PRs: parks duplicate-pulls with 0 rounds", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.ctx.repos[0]?.checkoutDir ?? dir, ["fetch", "origin"]);
      await harness.ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      // A second pull for the same branch by the factory login.
      await harness.ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t2", "b2");
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, publishingItem());
      const step = await publishStep(harness.ctx, item());
      expect(step).toBe("parked");
      const li = await readItem(harness.ctx.statePath);
      expect(li.park?.code).toBe("duplicate-pulls");
      expect(li.rounds).toHaveLength(0);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT4 absent branch: success gives no-push, a failed session gives session-failed", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, publishingItem());
      const step = await publishStep(harness.ctx, item());
      expect(step).toBe("idle");
      const li = await readItem(harness.ctx.statePath);
      expect(li.rounds[0]).toMatchObject({ outcome: "no-push", headSha: null });
      const stored = JSON.parse(await Bun.file(harness.ctx.storePath).text()) as {
        items: WorkItem[];
      };
      expect(stored.items[0]?.status).toBe("queued");
      expect(stored.items[0]?.branch).toBeNull();
      expect(li.rounds[0]?.headSha).toBeNull();
      expect(stored.items[0]?.stallRounds).toBe(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      await Bun.write(
        harness.registryPath,
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
                state: "failed",
                observedAt: NOW,
                seconds: 1,
                usage: null,
                usageValid: true,
                detail: "exited 1",
                ledgerAppended: true,
              },
              resolvedAt: null,
              revision: 1,
            },
          ],
        })}\n`,
      );
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, publishingItem());
      const step = await publishStep(harness.ctx, item());
      expect(step).toBe("idle");
      const li = await readItem(harness.ctx.statePath);
      expect(li.rounds[0]).toMatchObject({ outcome: "session-failed", headSha: null });
      const failedStored = JSON.parse(await Bun.file(harness.ctx.storePath).text()) as {
        items: WorkItem[];
      };
      expect(failedStored.items[0]?.status).toBe("queued");
      expect(failedStored.items[0]?.stallRounds).toBe(1);
      expect(failedStored.items[0]?.branch).toBeNull();
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT5 stored head unchanged: closes no-new-commit and keeps the PR", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.ctx.repos[0]?.checkoutDir ?? dir, ["fetch", "origin"]);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      const github = harness.ctx.github;
      await github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(
        harness.ctx.statePath,
        publishingItem({ pull: { number: 1, headSha: head } }),
      );
      const step = await publishStep(harness.ctx, item());
      expect(step).toBe("idle");
      const li = await readItem(harness.ctx.statePath);
      expect(li.rounds[0]).toMatchObject({ outcome: "no-new-commit", headSha: head });
      const stored = JSON.parse(await Bun.file(harness.ctx.storePath).text()) as {
        items: WorkItem[];
      };
      expect(stored.items[0]?.pullNumber).toBe(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT6 github and git errors keep the phase and log github-error", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.ctx.repos[0]?.checkoutDir ?? dir, ["fetch", "origin"]);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, publishingItem());
      const github = harness.ctx.github;
      const failing = {
        ...github,
        pullsForBranch: () =>
          Promise.reject(new GitHubError("unavailable", "pullsForBranch", "pullsForBranch: down")),
      };
      const failingCtx = { ...harness.ctx, github: failing };
      const step = await publishStep(failingCtx, item());
      expect(step).toBe("pending");
      const li = await readItem(harness.ctx.statePath);
      expect(li.phase).toBe("publishing");
      expect(li.rounds).toHaveLength(0);
      expect(
        harness.events.filter((line) =>
          line.startsWith("github-error:unavailable:pullsForBranch:"),
        ),
      ).toHaveLength(1);
      const retry = await publishStep(harness.ctx, item());
      expect(retry).toBe("ci");
    } finally {
      await harness.sandbox.cleanup();
    }
  });
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      rmSync(join(dir, "checkout"), { recursive: true, force: true });
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, publishingItem());
      const step = await publishStep(harness.ctx, item());
      expect(step).toBe("pending");
      const li = await readItem(harness.ctx.statePath);
      expect(li.phase).toBe("publishing");
      expect(li.rounds).toHaveLength(0);
      expect(
        harness.events.filter((line) => line.startsWith("github-error:failed:remoteBranchSha:")),
      ).toHaveLength(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

function ciItem(head: string, ciSince: string): LoopItem {
  return {
    ...initialLoopItem(),
    phase: "ci",
    session: { hostAlias: "host-a", providerId: PROVIDER, model: PREFERRED },
    requestId: "gh-demo-1:0",
    pull: { number: 1, headSha: head },
    ciSince,
  };
}

test("RT7 green CI moves the item to auditing", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await harness.ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, ciItem(head, NOW));
      const step = await ciStep(harness.ctx, item());
      expect(step).toBe("auditing");
      const li = await readItem(harness.ctx.statePath);
      expect(li.phase).toBe("auditing");
      expect(harness.events.filter((line) => line.startsWith("ci:green:"))).toHaveLength(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT8 red CI closes red-ci with the failing names", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const failingGithub = createStubGitHub({
      repo: REPO,
      originDir: harness.sandbox.origin,
      baseBranch: "main",
      factoryLogin: FACTORY_LOGIN,
      git: { PATH: GIT_ENV.PATH, timeoutMs: 30000 },
      scratchDir: harness.sandbox.scratchDir,
      ci: () => "failure",
    });
    const failingCtx = { ...harness.ctx, github: failingGithub };
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await failingGithub.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, ciItem(head, NOW));
      const step = await ciStep(failingCtx, item());
      expect(step).toBe("idle");
      const li = await readItem(harness.ctx.statePath);
      expect(li.rounds[0]).toMatchObject({
        outcome: "red-ci",
        headSha: head,
        failingChecks: ["gates"],
      });
      const stored = JSON.parse(await Bun.file(harness.ctx.storePath).text()) as {
        items: WorkItem[];
      };
      expect(stored.items[0]?.status).toBe("queued");
      expect(stored.items[0]?.pullNumber).toBe(1);
      expect(stored.items[0]?.stallRounds).toBe(1);
      expect(harness.events.filter((line) => line.startsWith("ci:red:"))).toHaveLength(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT9 failingChecksOf takes the latest run per name", () => {
  const runs = [
    { id: 1, name: "lint", status: "completed", conclusion: "failure" },
    { id: 3, name: "lint", status: "completed", conclusion: "success" },
    { id: 2, name: "gates", status: "completed", conclusion: "cancelled" },
    { id: 2, name: "docs", status: "completed", conclusion: "skipped" },
    { id: 2, name: "types", status: "completed", conclusion: "skipped" },
  ];
  expect(failingChecksOf(runs, ["types"])).toEqual(["gates", "types"]);
});

test("RT10 pending CI times out exactly at ciSince plus ciTimeoutMs", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir, { ciTimeoutMs: 600_000 });
    const pendingGithub = createStubGitHub({
      repo: REPO,
      originDir: harness.sandbox.origin,
      baseBranch: "main",
      factoryLogin: FACTORY_LOGIN,
      git: { PATH: GIT_ENV.PATH, timeoutMs: 30000 },
      scratchDir: harness.sandbox.scratchDir,
      ci: () => "pending",
    });
    const pendingCtx = { ...harness.ctx, github: pendingGithub };
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await pendingGithub.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      const base = Date.parse(NOW);
      await writeLoopState(
        harness.ctx.statePath,
        ciItem(head, new Date(base - 600_000 + 1).toISOString()),
      );
      expect(await ciStep(pendingCtx, item())).toBe("ci");
      await writeLoopState(
        harness.ctx.statePath,
        ciItem(head, new Date(base - 600_000).toISOString()),
      );
      expect(await ciStep(pendingCtx, item())).toBe("idle");
      const li = await readItem(harness.ctx.statePath);
      expect(li.rounds[0]).toMatchObject({ outcome: "ci-timeout", headSha: head });
      expect(li.rounds[0]?.failingChecks).toEqual([]);
      const lines = (await Bun.file(pendingCtx.resultsPath).text()).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "") as { routingResult?: string }).toMatchObject({
        routingResult: "excluded",
      });
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT11 moved CI head: resets the pull head and ciSince without a round", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      const headA = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "second\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const headB = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      expect(headB).not.toBe(headA);
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      const movedGithub = createStubGitHub({
        repo: REPO,
        originDir: harness.sandbox.origin,
        baseBranch: "main",
        factoryLogin: FACTORY_LOGIN,
        git: { PATH: GIT_ENV.PATH, timeoutMs: 30000 },
        scratchDir: harness.sandbox.scratchDir,
        ci: (sha) => (sha === headA ? "success" : "pending"),
      });
      const movedCtx = { ...harness.ctx, github: movedGithub };
      await movedGithub.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, ciItem(headA, NOW));
      const step = await ciStep(movedCtx, item());
      expect(step).toBe("ci");
      const li = await readItem(harness.ctx.statePath);
      expect(li.pull).toEqual({ number: 1, headSha: headB });
      expect(li.ciSince).toBe(new Date(NOW).toISOString());
      expect(li.phase).toBe("ci");
      expect(li.rounds).toHaveLength(0);
      expect(harness.events.filter((line) => line.startsWith("pull:moved:"))).toHaveLength(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT12 phase auditing at A with the branch moved to B returns to ci", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const server = await startLoopback("tests/auditor/recordings/clean.json");
    process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const calls = { count: 0 };
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: {
          ...auditorConfig,
          verdictDir: join(dir, "verdicts"),
          maxDiffBytes: 1_000_000,
        },
        call: countingCall(calls, callProviderOnce),
      },
    };
    await mkdir(join(dir, "verdicts"), { recursive: true });
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      expect(moved).not.toBe(head);
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      // The loop still names A while the branch already moved to B.
      await writeLoopState(ctx.statePath, auditingItem(head));
      expect(await auditStep(ctx, item())).toBe("ci");
      const li = await readItem(ctx.statePath);
      expect(li.pull).toEqual({ number: 1, headSha: moved });
      expect(li.phase).toBe("ci");
      expect(li.auditAttempts).toBeNull();
      expect(calls.count).toBe(0);
      expect(harness.events.filter((line) => line.startsWith("pull:moved:"))).toHaveLength(1);
    } finally {
      await server.stop();
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT13 clean.json posts audited once on the first run and on retry", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const server = await startLoopback("tests/auditor/recordings/clean.json");
    process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const calls = { count: 0 };
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: {
          ...auditorConfig,
          verdictDir: join(dir, "verdicts"),
          maxDiffBytes: 1_000_000,
        },
        call: countingCall(calls, callProviderOnce),
      },
    };
    await mkdir(join(dir, "verdicts"), { recursive: true });
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      expect(moved).not.toBe(head);
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      expect(await auditStep(ctx, item())).toBe("audited");
      const li = await readItem(ctx.statePath);
      expect(li.rounds).toHaveLength(0);
      expect(li.phase).toBe("auditing");
      expect(li.auditAttempts).toEqual({ headSha: moved, count: 1 });
      const stored = await readVerdicts(join(dir, "verdicts"), "gh-demo-1");
      const verdict = stored.find((entry) => entry.headSha === moved);
      if (verdict === undefined) {
        throw new Error("expected a stored verdict at the audited head");
      }
      const stub = ctx.github as unknown as {
        snapshot(): { comments: { number: number; login: string; body: string }[] };
      };
      const comments = stub.snapshot().comments;
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body.split("\n")[0]).toBe(renderComment(verdict)?.split("\n")[0] ?? "");
      expect(harness.events.filter((line) => line.startsWith("verdict:clean:"))).toHaveLength(1);
      expect(calls.count).toBe(1);
      expect(await auditStep(ctx, item())).toBe("audited");
      expect(stub.snapshot().comments).toHaveLength(1);
      expect(calls.count).toBe(1);
      expect(harness.events.filter((line) => line.startsWith("verdict:clean:"))).toHaveLength(1);
    } finally {
      await server.stop();
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT14 a rejected postComment retries the stored verdict without a new audit", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const server = await startLoopback("tests/auditor/recordings/clean.json");
    process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const calls = { count: 0 };
    const postFailures = { count: 0 };
    const countingGithub = {
      ...harness.ctx.github,
      async postComment(repo: string, pullNumber: number, body: string): Promise<void> {
        if (postFailures.count === 0) {
          postFailures.count += 1;
          throw new GitHubError("unavailable", "postComment", "postComment: down");
        }
        return harness.ctx.github.postComment(repo, pullNumber, body);
      },
    };
    const ctx = {
      ...harness.ctx,
      github: countingGithub,
      auditor: {
        ...harness.ctx.auditor,
        config: {
          ...auditorConfig,
          verdictDir: join(dir, "verdicts"),
          maxDiffBytes: 1_000_000,
        },
        call: countingCall(calls, callProviderOnce),
      },
    };
    await mkdir(join(dir, "verdicts"), { recursive: true });
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      expect(moved).not.toBe(head);
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await countingGithub.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      expect(await auditStep(ctx, item())).toBe("pending");
      const verdicts = await readVerdicts(join(dir, "verdicts"), "gh-demo-1");
      expect(verdicts.some((entry) => entry.headSha === moved)).toBe(true);
      const stub = countingGithub as unknown as {
        snapshot(): { comments: { number: number; body: string }[] };
      };
      expect(stub.snapshot().comments).toHaveLength(0);
      expect(calls.count).toBe(1);
      expect(
        harness.events.filter((line) => line.startsWith("github-error:unavailable:postComment:")),
      ).toHaveLength(1);
      expect(await auditStep(ctx, item())).toBe("audited");
      expect(stub.snapshot().comments).toHaveLength(1);
      expect(calls.count).toBe(1);
      // The retry posts the stored verdict without a new audit, so it
      // writes no further audit attempt.
      expect((await readItem(ctx.statePath)).auditAttempts).toEqual({
        headSha: moved,
        count: 1,
      });
      expect(harness.events.filter((line) => line.startsWith("verdict:clean:"))).toHaveLength(1);
    } finally {
      await server.stop();
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT15 non-json with one retry parks audit-failed after two loopback calls", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const server = await startLoopback("tests/auditor/recordings/non-json.json");
    process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    const harness = await makeHarness(dir, { auditRetries: 1 });
    const auditorConfig = await loadAuditorConfig();
    const calls = { count: 0 };
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: {
          ...auditorConfig,
          verdictDir: join(dir, "verdicts"),
          maxDiffBytes: 1_000_000,
        },
        budget: admittingGate(dir),
        call: countingCall(calls, callProviderOnce),
      },
    };
    await mkdir(join(dir, "verdicts"), { recursive: true });
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      expect(moved).not.toBe(head);
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      expect(await auditStep(ctx, item())).toBe("pending");
      let li = await readItem(ctx.statePath);
      expect(li.auditAttempts).toEqual({ headSha: moved, count: 1 });
      expect(calls.count).toBe(1);
      expect(
        harness.events.filter((line) => line.startsWith("audit-error:audit-model-error:")),
      ).toHaveLength(1);
      expect(await auditStep(ctx, item())).toBe("pending");
      li = await readItem(ctx.statePath);
      expect(li.auditAttempts).toEqual({ headSha: moved, count: 2 });
      expect(calls.count).toBe(2);
      expect(
        harness.events.filter((line) => line.startsWith("audit-error:audit-model-error:")),
      ).toHaveLength(2);
      expect(await auditStep(ctx, item())).toBe("parked");
      li = await readItem(ctx.statePath);
      expect(li.park?.code).toBe("audit-failed");
      expect(calls.count).toBe(2);
    } finally {
      await server.stop();
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT16(a) a budget refusal on the same head keeps attempts null on retry", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const gateCalls = { count: 0 };
    const inner = refusingGate(dir);
    const ctx = {
      ...harness.ctx,
      budgetBackoffMs: 60_000,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts") },
        budget: {
          admit: () => {
            gateCalls.count += 1;
            return inner.admit();
          },
        },
      },
    };
    await mkdir(join(dir, "verdicts"), { recursive: true });
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      expect(await auditStep(ctx, item())).toBe("pending");
      const li = await readItem(ctx.statePath);
      expect(li.phase).toBe("auditing");
      expect(li.rounds).toHaveLength(0);
      expect(li.auditAttempts).toBeNull();
      expect(li.backoffUntil).toBe(new Date(Date.parse(NOW) + 60_000).toISOString());
      expect(
        harness.events.filter((line) => line.startsWith("budget-refused:refused:")),
      ).toHaveLength(1);
      expect(await auditStep(ctx, item())).toBe("pending");
      expect(gateCalls.count).toBe(1);
      const retry = await readItem(ctx.statePath);
      expect(retry.auditAttempts).toBeNull();
      expect(retry.rounds).toHaveLength(0);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT17a the branch at the base closes empty-diff", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await harness.ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(harness.ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, auditingItem(head));
      await mkdir(join(dir, "verdicts"), { recursive: true });
      expect(await auditStep(harness.ctx, item())).toBe("idle");
      const li = await readItem(harness.ctx.statePath);
      expect(li.rounds[0]).toMatchObject({ outcome: "empty-diff", headSha: head });
      expect(li.rounds[0]?.failingChecks).toEqual([]);
      expect(
        harness.events.filter((line) => line.startsWith("round-closed:empty-diff:")),
      ).toHaveLength(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT17c an empty ledger parks no-authors", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const calls = { count: 0 };
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts") },
        budget: admittingGate(dir),
        call: countingCall(calls, () => Promise.reject(new Error("audit must not run"))),
      },
    };
    await mkdir(join(dir, "verdicts"), { recursive: true });
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await Bun.write(ctx.ledgerPath, "");
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      expect(await auditStep(ctx, item())).toBe("parked");
      const li = await readItem(ctx.statePath);
      expect(li.park?.code).toBe("no-authors");
      expect(calls.count).toBe(0);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT17d an authoring auditor parks no-eligible-auditor", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const calls = { count: 0 };
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        // The session model is the only configured auditor, so nobody
        // may audit this head.
        config: {
          ...auditorConfig,
          verdictDir: join(dir, "verdicts"),
          auditors: [{ providerId: PROVIDER, model: PREFERRED }],
        },
        budget: admittingGate(dir),
        call: countingCall(calls, () => Promise.reject(new Error("audit must not run"))),
      },
    };
    await mkdir(join(dir, "verdicts"), { recursive: true });
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      expect(await auditStep(ctx, item())).toBe("parked");
      const li = await readItem(ctx.statePath);
      expect(li.park?.code).toBe("no-eligible-auditor");
      expect(calls.count).toBe(0);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT17b maxDiffBytes 10 closes diff-too-large", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const server = await startLoopback("tests/auditor/recordings/clean.json");
    process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const calls = { count: 0 };
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts"), maxDiffBytes: 10 },
        call: countingCall(calls, callProviderOnce),
      },
    };
    await mkdir(join(dir, "verdicts"), { recursive: true });
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      expect(await auditStep(ctx, item())).toBe("idle");
      const li = await readItem(ctx.statePath);
      expect(li.rounds[0]).toMatchObject({ outcome: "diff-too-large", headSha: moved });
      expect(li.rounds[0]?.failingChecks).toEqual([]);
      // The diff is refused before any model call, so the counting
      // call never runs.
      expect(calls.count).toBe(0);
    } finally {
      await server.stop();
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT16(b) an exiting gate defers budget-gate-error with no park", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const gateCalls = { count: 0 };
    const exiting = {
      admit: (): Promise<never> => {
        gateCalls.count += 1;
        return Promise.reject(
          new Error('budget gate command ["bun","-e","process.exit(1);"] failed with rc 1: ', {
            cause: new BudgetGateError("budget gate: command failed"),
          }),
        );
      },
    };
    const ctx = {
      ...harness.ctx,
      budgetBackoffMs: 60_000,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts") },
        budget: exiting,
      },
    };
    await mkdir(join(dir, "verdicts"), { recursive: true });
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      expect(await auditStep(ctx, item())).toBe("pending");
      const li = await readItem(ctx.statePath);
      expect(li.rounds).toHaveLength(0);
      expect(li.phase).toBe("auditing");
      expect(li.park).toBeNull();
      expect(li.auditAttempts).toBeNull();
      expect(li.backoffUntil).toBe(new Date(Date.parse(NOW) + 60_000).toISOString());
      expect(gateCalls.count).toBe(1);
      expect(
        harness.events.filter((line) => line.startsWith("budget-refused:budget-gate-error:")),
      ).toHaveLength(1);
      expect(await auditStep(ctx, item())).toBe("pending");
      expect(gateCalls.count).toBe(1);
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT19 a throwing call parks audit-error with detail boom", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const calls = { count: 0 };
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts") },
        budget: admittingGate(dir),
        call: countingCall(calls, () => Promise.reject(new Error("boom"))),
      },
    };
    await mkdir(join(dir, "verdicts"), { recursive: true });
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      expect(await auditStep(ctx, item())).toBe("parked");
      const li = await readItem(ctx.statePath);
      expect(li.park?.code).toBe("audit-error");
      expect(calls.count).toBe(1);
      expect(
        harness.events.filter((line) => line.startsWith("audit-error:audit-error:boom")),
      ).toHaveLength(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT18 a removed verdict dir rejects with InputPathError", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const calls = { count: 0 };
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts") },
        budget: admittingGate(dir),
        call: countingCall(calls, () => Promise.reject(new Error("audit must not run"))),
      },
    };
    // The verdict directory is removed before the call, so the
    // stored-verdict read rejects with InputPathError.
    rmSync(join(dir, "verdicts"), { recursive: true, force: true });
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      let failure: unknown = null;
      try {
        await auditStep(ctx, item());
      } catch (error: unknown) {
        failure = error;
      }
      if (failure === null) {
        throw new Error("expected auditStep to reject when the verdict dir is gone");
      }
      expect((failure as Error).message).toContain("Verdict dir");
      expect(failure).toBeInstanceOf(InputPathError);
      expect(calls.count).toBe(0);
      const li = await readItem(ctx.statePath);
      expect(li.park).toBeNull();
      expect(li.phase).toBe("auditing");
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT20 a stored verdict at A on PR 1 posts without a model call", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const calls = { count: 0 };
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts") },
        budget: admittingGate(dir),
        call: countingCall(calls, () => Promise.reject(new Error("audit must not run"))),
      },
    };
    await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      // The seeded file copies the A8-4 stored verdict shape with only
      // workItemId, repo, pullNumber and headSha changed.
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${moved}.json`),
        `${JSON.stringify({
          schemaVersion: "v1",
          repo: REPO,
          workItemId: "gh-demo-1",
          pullNumber: 99,
          headSha: moved,
          authorModels: [`${PROVIDER}/${FALLBACK}`],
          auditorModel: PREFERRED,
          counts: { high: 1, medium: 0, low: 0 },
          findings: [
            {
              severity: "high",
              location: "src/add.ts:2",
              defect: "add subtracts instead of adding",
              scenario: "any caller summing two numbers gets the wrong result",
              fixDirection: "return a + b",
            },
          ],
        })}\n`,
      );
      expect(await auditStep(ctx, item())).toBe("audited");
      const li = await readItem(ctx.statePath);
      expect(li.rounds).toHaveLength(0);
      expect(calls.count).toBe(0);
      const posted = (
        ctx.github as unknown as {
          snapshot(): { comments: { number: number; body: string }[] };
        }
      ).snapshot().comments;
      expect(posted.filter((comment) => comment.number === 1)).toHaveLength(0);
      expect(posted.filter((comment) => comment.number === 99)).toHaveLength(0);
      // A verdict for another pull is invalid for PR 1: it is audited
      // without a post and without a verdict event.
      expect(harness.events.filter((line) => line.startsWith("verdict:"))).toHaveLength(0);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT21 verdict counts at A then start-rejected give the findings record", () => {
  const fullVerdict = {
    schemaVersion: "v1" as const,
    repo: REPO,
    workItemId: "gh-demo-1",
    pullNumber: 1,
    headSha: "a",
    authorModels: [`${PROVIDER}/${PREFERRED}`],
    auditorModel: PREFERRED,
    counts: { high: 1, medium: 0, low: 0 },
    findings: [
      {
        severity: "high" as const,
        location: "src/add.ts:2",
        defect: "add subtracts instead of adding",
        scenario: "any caller summing two numbers gets the wrong result",
        fixDirection: "return a + b",
      },
    ],
  };
  const verdict = {
    auditorModel: PREFERRED,
    high: 1,
    medium: 0,
    low: 0,
  };
  const base = {
    ...initialLoopItem(),
    rounds: [
      {
        round: 0,
        retry: 0,
        requestId: "r0",
        model: PREFERRED,
        providerId: PROVIDER,
        hostAlias: "host-a",
        attempt: "success" as const,
        outcome: "findings" as const,
        headSha: "a",
        failingChecks: ["gates"],
        verdict,
        newlyMet: [],
        at: NOW,
        baseRace: false,
      },
      {
        round: 1,
        retry: 0,
        requestId: "r1",
        model: PREFERRED,
        providerId: PROVIDER,
        hostAlias: "host-a",
        attempt: "failure" as const,
        outcome: "start-rejected" as const,
        headSha: "b",
        failingChecks: [],
        verdict: null,
        newlyMet: [],
        at: NOW,
        baseRace: false,
      },
    ],
  };
  // The last stored round is start-rejected, which previousRoundOf
  // skips: the brief carries the findings record's outcome and checks
  // plus the findings of the verdict at A.
  const previous = previousRoundOf({ ...base, round: 2 }, [fullVerdict]);
  expect(previous?.outcome).toBe("findings");
  expect(previous?.failingChecks).toEqual(["gates"]);
  expect(previous?.findings).toEqual({ headSha: "a", list: fullVerdict.findings });
  expect(previousRoundOf({ ...base, round: 0, rounds: [] }, [])).toBeNull();
});

async function makeSandbox(repoDir: string, seedFiles = true): Promise<Sandbox> {
  const dir = mkdtempSync(join(tmpdir(), "loop-review-sandbox-"));
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
  if (seedFiles) {
    await Bun.write(join(seed, "f.txt"), "main line\n");
    await git(seed, ["add", "f.txt"]);
    await git(seed, ["commit", "-m", "main1"]);
    await git(seed, ["branch", "-M", "main"]);
    await git(seed, ["push", "origin", "main"]);
  }
  const repoPath = resolve(repoDir);
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.name", "fixture"]);
  await git(repoPath, ["config", "user.email", "fixture@example.invalid"]);
  await Bun.write(join(repoPath, "f.txt"), "main line\n");
  await git(repoPath, ["add", "f.txt"]);
  await git(repoPath, ["commit", "-m", "main1"]);
  await git(repoPath, ["remote", "add", "origin", origin]);
  await git(repoPath, ["fetch", "origin"]);
  return {
    dir,
    origin,
    seed,
    scratchDir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

async function pushEmpty(seed: string, branch: string, from = "main"): Promise<string> {
  await git(seed, ["checkout", "-B", branch, from]);
  await git(seed, ["commit", "--allow-empty", "-m", branch]);
  await git(seed, ["push", "origin", branch]);
  return (await git(seed, ["rev-parse", branch])).trim();
}

// One finished usage record, so authorModelsOf finds PREFERRED for the item.
async function seedSessionLedger(ledgerPath: string): Promise<void> {
  await Bun.write(
    ledgerPath,
    `${JSON.stringify({
      schemaVersion: "v1",
      workItemId: "gh-demo-1",
      finishedAt: new Date(Date.parse(NOW) - 3_600_000).toISOString(),
      tokens: [
        {
          provider: PROVIDER,
          model: PREFERRED,
          inputTokens: 100,
          outputTokens: 50,
          requests: 1,
          source: "provider-usage",
        },
      ],
      sessionSeconds: [{ hostAlias: "host-a", seconds: 5, source: "dispatcher-clock" }],
      attempts: [{ model: PREFERRED, result: "success" }],
      retries: 0,
      humanInterventions: 0,
      result: "success",
    })}\n`,
  );
}

function auditingItem(head: string, overrides: Partial<LoopItem> = {}): LoopItem {
  return {
    ...initialLoopItem(),
    phase: "auditing",
    session: { hostAlias: "host-a", providerId: PROVIDER, model: PREFERRED },
    requestId: "gh-demo-1:0",
    pull: { number: 1, headSha: head },
    ciSince: NOW,
    ...overrides,
  };
}

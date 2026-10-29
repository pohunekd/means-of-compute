// Driver review tests (slice 5d rows RT1-RT21): publish, ci and audit
// through the real dispatcher, memory port and files, with one named
// mutation per row killed by its own assertion.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { WorkItem } from "../../contracts/v1/types.js";
import { readLoopState } from "../../src/loop/state.js";
import type { LoopLog } from "../../src/loop/log.js";
import { initialLoopItem } from "../../src/loop/start.js";
import type { LoopItem } from "../../src/loop/types.js";
import { admittingGate, applyTestEnv, refusingGate } from "../auditor/test-env.js";
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

test("RT1 pushed head, no PR: creates the pull and moves to ci", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
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
      expect(stored.items[0]?.branch).toBe("moc/gh-demo-1");
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
    const harness = await makeHarness(dir, {
      repos: [{ repo: REPO, checkoutDir: "/nonexistent/x.git", idPrefix: "gh-" }],
    });
    try {
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
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
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await harness.ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, ciItem(headA, NOW));
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "second\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const headB = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      expect(headB).not.toBe(headA);
      const step = await ciStep(harness.ctx, item());
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

test("RT12 clean audit posts audited once on the first run and on retry", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const server = await startLoopback("tests/auditor/recordings/clean.json");
    process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: {
          ...auditorConfig,
          verdictDir: join(dir, "verdicts"),
          maxDiffBytes: 1_000_000,
        },
        call: callProviderOnce,
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
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      const findingsOutcome = await auditStep(ctx, item());
      if (findingsOutcome !== "audited") {
        const debugLi = await readItem(ctx.statePath);
        throw new Error(
          `outcome ${findingsOutcome} park=${JSON.stringify(debugLi.park)} events=${harness.events.join("|")}`,
        );
      }
      expect(findingsOutcome).toBe("audited");
      const li = await readItem(ctx.statePath);
      expect(li.rounds).toHaveLength(0);
      expect(li.phase).toBe("auditing");
      const stub = ctx.github as unknown as {
        snapshot(): { comments: { number: number; body: string }[] };
      };
      expect(stub.snapshot().comments).toHaveLength(1);
      expect(stub.snapshot().comments[0]?.body ?? "").toContain("audit:v1:");
      // Post retry: the verdict row exists, the verdict comment exists, the
      // marker matches, so RS5 returns audited without a second post.
      expect(await auditStep(ctx, item())).toBe("audited");
      expect(stub.snapshot().comments).toHaveLength(1);
      expect(harness.events.filter((line) => line.startsWith("verdict:"))).toHaveLength(1);
    } finally {
      await server.stop();
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT13 a verdict row with a stale marker posts the stored verdict again", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: {
          ...auditorConfig,
          verdictDir: join(dir, "verdicts"),
          maxDiffBytes: 1_000_000,
        },
        call: () => Promise.reject(new Error("audit must not run when a verdict exists")),
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
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      const pull = await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      expect(pull).toBe(1);
      await seedSessionLedger(ctx.ledgerPath);
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${moved}.json`),
        `${JSON.stringify({
          schemaVersion: "v1",
          repo: REPO,
          workItemId: "gh-demo-1",
          pullNumber: 1,
          headSha: moved,
          authorModels: [PREFERRED],
          auditorModel: FALLBACK,
          counts: { high: 0, medium: 0, low: 0 },
          findings: [],
        })}\n`,
      );
      expect(await auditStep(ctx, item())).toBe("audited");
      const posted = (
        ctx.github as unknown as {
          snapshot(): { comments: { number: number; body: string }[] };
        }
      ).snapshot().comments;
      expect(posted).toHaveLength(1);
      expect(posted[0]?.body ?? "").toContain("audit:v1:");
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT14 nothing to audit closes empty-diff and idles", async () => {
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
      expect(
        harness.events.filter((line) => line.startsWith("round-closed:empty-diff:")),
      ).toHaveLength(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT15 diff too large closes diff-too-large with no failing checks", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const server = await startLoopback("tests/auditor/recordings/clean.json");
    process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts"), maxDiffBytes: 1 },
        call: callProviderOnce,
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
    } finally {
      await server.stop();
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT16 no author models parks no-authors with the operator label", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(harness.sandbox.seed, "b.txt"), "more\n");
      await git(harness.sandbox.seed, ["add", "b.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "second"]);
      await git(harness.sandbox.seed, ["push", "origin", "moc/gh-demo-1"]);
      const moved = (await git(harness.sandbox.seed, ["rev-parse", "moc/gh-demo-1"])).trim();
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await harness.ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      // The ledger holds no finished record, so there are no author models.
      await Bun.write(harness.ctx.ledgerPath, "");
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, auditingItem(moved));
      await mkdir(join(dir, "verdicts"), { recursive: true });
      expect(await auditStep(harness.ctx, item())).toBe("parked");
      const li = await readItem(harness.ctx.statePath);
      expect(li.park?.code).toBe("no-authors");
      expect(
        harness.events.filter((line) => line.startsWith("escalation:op:gh-demo-1:no-authors:")),
      ).toHaveLength(1);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT17 no eligible auditor parks no-eligible-auditor", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    // The author model equals the only auditor, so nobody may audit.
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: {
          ...auditorConfig,
          verdictDir: join(dir, "verdicts"),
          auditors: [{ providerId: PROVIDER, model: PREFERRED }],
        },
        call: () => Promise.reject(new Error("audit must not run without an auditor")),
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
      expect(await auditStep(ctx, item())).toBe("parked");
      const li = await readItem(ctx.statePath);
      expect(li.park?.code).toBe("no-eligible-auditor");
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT18 budget refusal defers the audit without a round", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const ctx = {
      ...harness.ctx,
      budgetBackoffMs: 60_000,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts") },
        budget: refusingGate(dir),
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
      expect(li.backoffUntil).toBe(new Date(Date.parse(NOW) + 60_000).toISOString());
      // The attempt recorded before the audit call stands.
      expect(li.auditAttempts).toEqual({ headSha: moved, count: 1 });
      expect(
        harness.events.filter((line) => line.startsWith("budget-refused:refused:")),
      ).toHaveLength(1);
      // A refused head stays deferred: the retry keeps the phase and the count.
      await writeLoopState(ctx.statePath, { ...li, backoffUntil: null });
      expect(await auditStep(ctx, item())).toBe("pending");
      const retry = await readItem(ctx.statePath);
      expect(retry.auditAttempts).toEqual({ headSha: moved, count: 2 });
      expect(retry.rounds).toHaveLength(0);
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT19 an audit model failure defers with audit-model-error", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts") },
        budget: admittingGate(dir),
        call: () => Promise.reject(new TypeError("fetch failed")),
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
      expect(li.park).toBeNull();
      expect(li.phase).toBe("auditing");
      expect(
        harness.events.filter((line) => line.startsWith("audit-error:audit-model-error:")),
      ).toHaveLength(1);
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT20 findings post the verdict and keep the audit phase", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const finding = {
      status: 200,
      body: {
        choices: [
          {
            message: {
              content:
                '{"findings": [{"severity": "medium", "location": "b.txt:1", "defect": "line is short", "scenario": "a reader wants context", "fixDirection": "add more"}]}',
            },
          },
        ],
        usage: { prompt_tokens: 130, completion_tokens: 40 },
      },
    };
    await Bun.write(join(dir, "finding.json"), `${JSON.stringify([finding])}\n`);
    const server = await startLoopback(join(dir, "finding.json"));
    process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
    const harness = await makeHarness(dir);
    const auditorConfig = await loadAuditorConfig();
    const ctx = {
      ...harness.ctx,
      auditor: {
        ...harness.ctx.auditor,
        config: { ...auditorConfig, verdictDir: join(dir, "verdicts") },
        call: callProviderOnce,
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
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, auditingItem(moved));
      expect(await auditStep(ctx, item())).toBe("audited");
      const li = await readItem(ctx.statePath);
      expect(li.rounds).toHaveLength(0);
      const posted = (
        ctx.github as unknown as {
          snapshot(): { comments: { number: number; body: string }[] };
        }
      ).snapshot().comments;
      expect(posted).toHaveLength(1);
      expect(posted[0]?.body ?? "").toContain("audit:v1:");
      expect(harness.events.filter((line) => line.startsWith("verdict:findings:"))).toHaveLength(1);
    } finally {
      await server.stop();
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

test("RT21 previousRoundOf skips the running round and parses the query", () => {
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
        outcome: "red-ci" as const,
        headSha: "a",
        failingChecks: ["gates"],
        verdict: null,
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
        attempt: "success" as const,
        outcome: "ci-timeout" as const,
        headSha: "b",
        failingChecks: [],
        verdict: null,
        newlyMet: [],
        at: NOW,
        baseRace: false,
      },
    ],
  };
  // previousRoundOf reports the latest stored round and skips lost closes.
  expect(previousRoundOf({ ...base, round: 2 }, [])?.outcome).toBe("ci-timeout");
  expect(
    previousRoundOf(
      {
        ...base,
        round: 1,
        rounds: [...base.rounds, { ...base.rounds[1]!, outcome: "lost" as const, round: 2 }],
      },
      [],
    )?.outcome,
  ).toBe("ci-timeout");
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
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
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

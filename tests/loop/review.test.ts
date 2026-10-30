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
import type { ModelRequest, SingleCallResult } from "../../src/providers/router.js";
import { readLoopState } from "../../src/loop/state.js";
import type { LoopLog } from "../../src/loop/log.js";
import { initialLoopItem } from "../../src/loop/start.js";
import type { LoopItem } from "../../src/loop/types.js";
import { applyTestEnv } from "../auditor/test-env.js";
import { renderComment } from "../../src/auditor/verdict.js";
import { readVerdicts } from "../../src/auditor/store.js";
import { callProviderOnce, ProviderCallError } from "../../src/providers/router.js";
import { startLoopback } from "../../src/providers/loopback.js";
import { loadAuditorConfig } from "../../src/auditor/config.js";
import { createStubGitHub } from "../../src/loop/stub/github.js";
import type { GitDeps } from "../../src/loop/git.js";
import { auditStep, ciStep, publishStep, type ReviewContext } from "../../src/loop/review.js";
import { pullDecision, workItemMarker } from "../../src/loop/merge-rule.js";
import type { PullRow } from "../../src/loop/github.js";

const PREFERRED = "muse-spark-1.3-contributor";
const PROVIDER = "meta-api";
const NOW = "2026-10-28T10:00:00.000Z";
const REPO = "example/demo";
const FACTORY_LOGIN = "moc-factory";

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
      const pulls = harness.events.filter((line) => line.startsWith("pull:created:"));
      expect(pulls).toHaveLength(1);
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

// One finished usage record for `model`, so `authorModelsOf` names it as the author.
async function seedSessionLedger(ledgerPath: string, model = PREFERRED): Promise<void> {
  await Bun.write(
    ledgerPath,
    `${JSON.stringify({
      schemaVersion: "v1",
      workItemId: "gh-demo-1",
      finishedAt: new Date(Date.parse(NOW) - 3_600_000).toISOString(),
      tokens: [
        {
          provider: PROVIDER,
          model,
          inputTokens: 100,
          outputTokens: 50,
          requests: 1,
          source: "provider-usage",
        },
      ],
      sessionSeconds: [{ hostAlias: "host-a", seconds: 5, source: "dispatcher-clock" }],
      attempts: [{ model, result: "success" }],
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

test("A2 audit timeout logs audit-model-error with the message detail", async () => {
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
      expect(moved).not.toBe(head);
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await harness.ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await seedSessionLedger(harness.ctx.ledgerPath);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, auditingItem(moved));
      await mkdir(join(dir, "verdicts"), { recursive: true });
      const error = new ProviderCallError(
        "Provider meta-api timed out",
        504,
        true,
        null,
        "timeout",
      );
      const auditorConfig = await loadAuditorConfig();
      const step = await auditStep(
        {
          ...harness.ctx,
          auditor: {
            ...harness.ctx.auditor,
            config: {
              ...auditorConfig,
              verdictDir: join(dir, "verdicts"),
              maxDiffBytes: 1_000_000,
            },
            call: () => Promise.reject(error),
          },
        },
        item(),
      );
      expect(step).toBe("pending");
      const coded = harness.events.filter((line) => line.includes("audit-model-error"));
      expect(coded).toHaveLength(1);
      expect(coded[0]).toContain(":model call failed: Provider meta-api timed out:");
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

test("RT22 adopts only an own pull whose body starts with the item marker", () => {
  const row: PullRow = {
    number: 7,
    state: "OPEN",
    headRefOid: "a".repeat(40),
    baseRefName: "main",
    isDraft: false,
    isCrossRepository: false,
    authorLogin: FACTORY_LOGIN,
    bodyFirstLine: "A pull opened by hand on the factory branch",
  };
  const marker = workItemMarker("demo-1");
  expect(pullDecision([row], FACTORY_LOGIN, marker)).toEqual({ kind: "foreign" });
  const own = { ...row, bodyFirstLine: marker };
  expect(pullDecision([own], FACTORY_LOGIN, marker)).toEqual({ kind: "adopt", pull: own });
});

test("RT1b PR body for intake item uses Closes", async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    try {
      await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.ctx.repos[0]?.checkoutDir ?? dir, ["fetch", "origin"]);
      await seedFinishedSession(harness.registryPath, "gh-demo-1");
      const intakeItem = item({ issue: 123 });
      await writeStore(harness.ctx.storePath, intakeItem);
      await writeLoopState(harness.ctx.statePath, publishingItem());
      const step = await publishStep(harness.ctx, intakeItem);
      expect(step).toBe("ci");
      const createdPull = (
        harness.ctx.github as unknown as {
          snapshot(): { pulls: { head: string; body: string }[] };
        }
      )
        .snapshot()
        .pulls.at(0);
      expect(createdPull?.body).toContain("Closes #123");
      expect(createdPull?.body).not.toContain("Refs #123");
    } finally {
      await harness.sandbox.cleanup();
    }
  });
});

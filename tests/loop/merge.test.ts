// Driver merge tests (row MT1): the ready path merges and finalizes
// through the stub GitHub.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkItem } from "../../contracts/v1/types.js";
import type { LoopLog } from "../../src/loop/log.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import type { GitDeps } from "../../src/loop/git.js";
import { createStubGitHub, type StubCi } from "../../src/loop/stub/github.js";
import { readLoopState } from "../../src/loop/state.js";
import type { LoopItem } from "../../src/loop/types.js";
import { initialLoopItem } from "../../src/loop/start.js";
import { renderComment } from "../../src/auditor/verdict.js";
import { appendPending } from "../../src/ledger/store.js";
import type { PendingUsage } from "../../src/ledger/types.js";
import { createApprovalsView } from "../../src/loop/approvals-view.js";
import { applyTestEnv } from "../auditor/test-env.js";
import { createMergeMutex, mergeCheck, type MergeContext } from "../../src/loop/merge.js";

const PREFERRED = "muse-spark-1.3-contributor";
const PROVIDER = "meta-api";
const AUDITOR = "meta/muse-glimmer-30b";
const NOW = "2026-10-28T10:00:00.000Z";
const REPO = "example/demo";
const FACTORY_LOGIN = "moc-factory";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    schemaVersion: "v1",
    id: "gh-demo-1",
    repo: REPO,
    title: "Demo item gh-demo-1",
    goal: "Drive a merge",
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
          `${event.event}:${event.code ?? ""}:${event.detail ?? ""}:${event.sha ?? ""}:${String(event.round ?? "")}:${event.requestId ?? ""}`,
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

async function makeSandbox(repoDir: string): Promise<Sandbox> {
  const dir = mkdtempSync(join(tmpdir(), "loop-merge-sandbox-"));
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

async function pushEmpty(seed: string, branch: string, from = "main"): Promise<string> {
  await git(seed, ["checkout", "-B", branch, from]);
  await git(seed, ["commit", "--allow-empty", "-m", branch]);
  await git(seed, ["push", "origin", branch]);
  return (await git(seed, ["rev-parse", branch])).trim();
}

async function seedFinishedSession(registryPath: string, requestId = "gh-demo-1:0"): Promise<void> {
  const itemId = requestId.split(":")[0] ?? "gh-demo-1";
  const branch = `moc/${itemId}`;
  await Bun.write(
    registryPath,
    `${JSON.stringify({
      sessions: [
        {
          requestId,
          workItemId: itemId,
          repo: REPO,
          hostAlias: "host-a",
          branch,
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

async function readItem(statePath: string, id = "gh-demo-1"): Promise<LoopItem> {
  const state = await readLoopState(statePath);
  return state.items[id] as unknown as LoopItem;
}

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-merge-"));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function pendingLedger(): PendingUsage {
  return {
    entryId: "e1-session",
    kind: "session",
    workItemId: "gh-demo-1",
    finishedAt: "2026-10-28T09:00:00.000Z",
    startModel: PREFERRED,
    tokens: [
      {
        provider: PROVIDER,
        model: PREFERRED,
        inputTokens: 10,
        outputTokens: 20,
        requests: 1,
        source: "provider-usage",
      },
    ],
    session: { hostAlias: "host-a", seconds: 60, source: "dispatcher-clock", result: "failure" },
  };
}

interface MergeHarness {
  readonly ctx: MergeContext;
  readonly events: string[];
  readonly sandbox: Sandbox;
  readonly registryPath: string;
}

async function makeHarness(
  dir: string,
  overrides: Partial<MergeContext> & { ci?: (sha: string) => StubCi } = {},
): Promise<MergeHarness> {
  const seen = logged();
  const registryPath = join(dir, "registry.json");
  const control = createMemoryPort();
  const dispatcher = createDispatcher({
    port: control.port,
    budget: {
      admit: () => Promise.resolve({ admit: true as const, line: "admitted: test" }),
    },
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
  const { ci, ...rest } = overrides;
  const ctx: MergeContext = {
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
      ci: ci ?? (() => "success"),
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
      budget: {
        admit: () => Promise.resolve({ admit: true as const, line: "admitted: test" }),
      },
      call: () => Promise.reject(new Error("merge tests never audit")),
    },
    specs: [{ schemaVersion: "v1", repo: REPO, mergeMode: "by-rule" }],
    approvals: createApprovalsView(join(dir, "approval-requests.json")),
    mergeRetries: 1,
    trialMerge: { scratchDir: join(dir, "trials"), steps: [], timeoutMs: 30_000 },
    home: dir,
    mergeMutex: createMergeMutex(),
    ...rest,
  };
  return { ctx, events: seen.events, sandbox, registryPath };
}

function readyItem(head: string, overrides: Partial<LoopItem> = {}): LoopItem {
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

function cleanVerdict(
  head: string,
  pullNumber = 1,
): {
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
    pullNumber,
    headSha: head,
    authorModels: [PREFERRED],
    auditorModel: AUDITOR,
    counts: { high: 0, medium: 0, low: 0 },
    findings: [],
  };
}

test("MT1 ready with an ancestral base merges and finalizes", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const harness = await makeHarness(dir);
    const ctx = harness.ctx;
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      const verdict = cleanVerdict(head);
      await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${head}.json`),
        `${JSON.stringify(verdict)}\n`,
      );
      const marker = renderComment(verdict);
      if (marker !== null) {
        await ctx.github.postComment(REPO, 1, marker);
      }
      await appendPending(ctx.ledgerPath, pendingLedger());
      await seedFinishedSession(harness.registryPath);
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, readyItem(head));
      const base = await ctx.github.baseSha(REPO, "main");
      const outcome = await mergeCheck(ctx, item());
      expect(outcome).toBe("done");
      const view = await ctx.github.viewPull(REPO, 1);
      expect(view.state).toBe("MERGED");
      const mergeCommit = view.mergeCommit;
      if (mergeCommit === null) {
        throw new Error("expected a merge commit");
      }
      const li = await readItem(ctx.statePath);
      expect(li.phase).toBe("final");
      expect(li.finalize).toEqual({ result: "success", done: true });
      expect(li.trial).toEqual({ baseSha: base, headSha: head, passed: true });
      expect(li.mergeAttempts).toEqual({ headSha: head, count: 1 });
      expect((await readLoopState(ctx.statePath)).mergeHold).toBeNull();
      expect(li.rounds).toHaveLength(1);
      expect(li.rounds[0]).toMatchObject({
        outcome: "merged",
        headSha: head,
        baseRace: false,
        verdict: { auditorModel: AUDITOR, high: 0, medium: 0, low: 0 },
      });
      const lines = (await Bun.file(ctx.resultsPath).text())
        .split("\n")
        .filter((line) => line !== "");
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0] as string) as { routingResult: string }).routingResult).toBe(
        "success",
      );
      const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
      expect(store.items[0]?.status).toBe("done");
      expect(store.items[0]?.dod.every((entry) => entry.done)).toBe(true);
      const text = await Bun.file(ctx.ledgerPath).text();
      const records = text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as unknown);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ workItemId: "gh-demo-1", result: "success" });
      const mergedEvents = harness.events.filter((line) => line.startsWith("merged:"));
      expect(mergedEvents).toHaveLength(1);
      expect(mergedEvents[0]).toContain(`:${mergeCommit}:`);
      expect(mergedEvents[0]).toContain(":gh-demo-1:0");
      const mergedRound = Number(mergedEvents[0]?.split(":")[4] ?? "-1");
      expect(mergedRound).toBe(li.round - 1);
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

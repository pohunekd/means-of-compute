// Driver merge tests (slice 5e rows MT1-MT23): the ready path, the
// trial gate, the base race hold, human merges and the error latches.
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
import { GitHubError } from "../../src/loop/github.js";
import {
  createStubGitHub,
  type StubCi,
  type StubGitHubSnapshot,
} from "../../src/loop/stub/github.js";
import { readLoopState, updateLoopState } from "../../src/loop/state.js";
import type { LoopItem } from "../../src/loop/types.js";
import { initialLoopItem } from "../../src/loop/start.js";
import { renderComment } from "../../src/auditor/verdict.js";
import { appendPending } from "../../src/ledger/store.js";
import type { PendingUsage } from "../../src/ledger/types.js";
import { createApprovalsView } from "../../src/loop/approvals-view.js";
import { decideRequest } from "../../src/approvals/decide.js";
import { recordRequest } from "../../src/approvals/store.js";
import { applyTestEnv } from "../auditor/test-env.js";
import {
  createMergeMutex,
  finishMerge,
  mergeCheck,
  type MergeContext,
  type MergeOutcome,
} from "../../src/loop/merge.js";
import { project, reconcile } from "../../src/loop/project.js";

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

// MT2 helper state lives inline in the test body below.

// MT2: a moved base trials once per call, then the second call merges.
test("MT2 a moved base runs one trial per call then merges", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const harness = await makeHarness(dir);
    const spyFile = join(dir, "trials.log");
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      await git(harness.sandbox.seed, ["checkout", "main"]);
      await Bun.write(join(harness.sandbox.seed, "f.txt"), "main line\nsecond\n");
      await git(harness.sandbox.seed, ["add", "f.txt"]);
      await git(harness.sandbox.seed, ["commit", "-m", "b2"]);
      await git(harness.sandbox.seed, ["push", "origin", "main"]);
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await harness.ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      const base = await harness.ctx.github.baseSha(REPO, "main");
      const verdict = cleanVerdict(head);
      await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${head}.json`),
        `${JSON.stringify(verdict)}\n`,
      );
      const marker = renderComment(verdict);
      if (marker !== null) {
        await harness.ctx.github.postComment(REPO, 1, marker);
      }
      await appendPending(harness.ctx.ledgerPath, pendingLedger());
      await seedFinishedSession(harness.registryPath);
      await writeStore(harness.ctx.storePath, item());
      await writeLoopState(harness.ctx.statePath, readyItem(head));
      const realBaseSha = harness.ctx.github.baseSha.bind(harness.ctx.github);
      const realMerge = harness.ctx.github.mergePull.bind(harness.ctx.github);
      let baseShaCalls = 0;
      let mergeCalls = 0;
      const ctx: MergeContext = {
        ...harness.ctx,
        trialMerge: {
          scratchDir: join(dir, "trial-scratch"),
          steps: [["true"]],
          timeoutMs: 30_000,
        },
        github: {
          ...harness.ctx.github,
          async baseSha(repo: string, baseBranch: string): Promise<string> {
            baseShaCalls += 1;
            const current = await realBaseSha(repo, baseBranch);
            if (baseShaCalls === 2) {
              await git(harness.sandbox.seed, ["checkout", "main"]);
              await Bun.write(
                join(harness.sandbox.seed, "f.txt"),
                `main line\nsecond ${String(baseShaCalls)}\n`,
              );
              await git(harness.sandbox.seed, ["add", "f.txt"]);
              await git(harness.sandbox.seed, ["commit", "-m", "b2-again"]);
              await git(harness.sandbox.seed, ["push", "origin", "main"]);
              return realBaseSha(repo, baseBranch);
            }
            return current;
          },
          async mergePull(repo: string, pull: number, sha: string): Promise<void> {
            mergeCalls += 1;
            return realMerge(repo, pull, sha);
          },
        },
      };
      const fetched = await realBaseSha(REPO, "main");
      expect(fetched).toBe(base);
      const trialScript = join(dir, "append.sh");
      const scriptCtx: MergeContext = {
        ...ctx,
        trialMerge: {
          scratchDir: join(dir, "trial-scratch"),
          steps: [["sh", trialScript, spyFile]],
          timeoutMs: 30_000,
        },
      };
      await Bun.write(trialScript, `#!/bin/sh\necho trial >> "$1"\n`);
      await Bun.$`chmod +x ${trialScript}`.quiet();
      const first = await mergeCheck(scriptCtx, item());
      expect(first).toBe("pending");
      expect(mergeCalls).toBe(0);
      const afterFirst = await readItem(scriptCtx.statePath);
      expect(afterFirst.phase).toBe("merging");
      expect(afterFirst.trial).toEqual({ baseSha: base, headSha: head, passed: true });
      const trialLines = (await Bun.file(spyFile).text()).split("\n").filter((line) => line !== "");
      expect(trialLines).toHaveLength(1);
      const second = await mergeCheck(scriptCtx, item());
      expect(second).toBe("done");
      expect(mergeCalls).toBe(1);
      const trialLinesAfter = (await Bun.file(spyFile).text())
        .split("\n")
        .filter((line) => line !== "");
      expect(trialLinesAfter).toHaveLength(2);
      const final = await readItem(scriptCtx.statePath);
      expect(final.mergeAttempts).toEqual({ headSha: head, count: 1 });
      expect(fetched).toBe(base);
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

interface ReadySeed {
  readonly harness: MergeHarness;
  readonly ctx: MergeContext;
  readonly events: string[];
  readonly head: string;
  readonly base: string;
}

interface SeedOpts {
  readonly branch?: string;
  readonly ci?: (sha: string) => StubCi;
  readonly skipMarker?: boolean;
  readonly store?: (head: string, li: LoopItem, ctx: { readonly branchPrefix: string }) => WorkItem;
}

async function seedReadyItem(
  dir: string,
  overrides: Partial<LoopItem> = {},
  opts: SeedOpts = {},
): Promise<ReadySeed> {
  const extra = opts.ci === undefined ? {} : { ci: opts.ci };
  const harness = await makeHarness(dir, extra);
  const branch = opts.branch ?? "moc/gh-demo-1";
  const head = await pushEmpty(harness.sandbox.seed, branch);
  const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
  await git(checkout, ["fetch", "origin"]);
  await harness.ctx.github.createPull(REPO, branch, "main", "t", "b");
  const base = await harness.ctx.github.baseSha(REPO, "main");
  const verdict = cleanVerdict(head);
  await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
  await Bun.write(
    join(dir, "verdicts", "gh-demo-1", `${head}.json`),
    `${JSON.stringify(verdict)}\n`,
  );
  if (opts.skipMarker !== true) {
    const marker = renderComment(verdict);
    if (marker !== null) {
      await harness.ctx.github.postComment(REPO, 1, marker);
    }
  }
  await appendPending(harness.ctx.ledgerPath, pendingLedger());
  await seedFinishedSession(harness.registryPath);
  const seededItem = readyItem(head, overrides);
  const seededStore =
    opts.store === undefined ? item() : opts.store(head, seededItem, { branchPrefix: "moc/" });
  await writeStore(harness.ctx.storePath, seededStore);
  await writeLoopState(harness.ctx.statePath, seededItem);
  return { harness, ctx: harness.ctx, events: harness.events, head, base };
}

async function secondReviewItem(seed: ReadySeed): Promise<LoopItem> {
  const checkoutDir = seed.ctx.repos[0]?.checkoutDir ?? seed.ctx.home;
  const head2 = await pushEmpty(seed.harness.sandbox.seed, "moc/gh-demo-2");
  await git(checkoutDir, ["fetch", "origin"]);
  const pullNumber = await seed.ctx.github.createPull(REPO, "moc/gh-demo-2", "main", "t2", "b2");
  const verdict2 = { ...cleanVerdict(head2, pullNumber), workItemId: "gh-demo-2" };
  const verdictDir = join(seed.ctx.auditor.config.verdictDir, "gh-demo-2");
  await mkdir(verdictDir, { recursive: true });
  await Bun.write(join(verdictDir, `${head2}.json`), `${JSON.stringify(verdict2)}\n`);
  const marker2 = renderComment(verdict2);
  if (marker2 !== null) {
    await seed.ctx.github.postComment(REPO, pullNumber, marker2);
  }
  await appendPending(seed.ctx.ledgerPath, { ...pendingLedger(), workItemId: "gh-demo-2" });
  return {
    ...initialLoopItem(),
    session: { hostAlias: "host-a", providerId: PROVIDER, model: PREFERRED },
    phase: "merging",
    requestId: "gh-demo-2:0",
    pull: { number: pullNumber, headSha: head2 },
    ciSince: NOW,
    trial: {
      baseSha: await seed.ctx.github.baseSha(REPO, "main"),
      headSha: head2,
      passed: true,
    },
  };
}

async function withReadySeed(
  dir: string,
  body: (seed: ReadySeed) => Promise<void>,
  overrides: Partial<LoopItem> = {},
  opts: SeedOpts = {},
): Promise<void> {
  const restoreEnv = applyTestEnv();
  const seed = await seedReadyItem(dir, overrides, opts);
  try {
    await body(seed);
  } finally {
    restoreEnv();
    await seed.harness.sandbox.cleanup();
  }
}

// Trial spy helpers live inline in MT2.

// MT3: a raced merge holds, escalates and closes with baseRace.
test("MT3 a raced merge sets the hold and escalates once", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head, base } = seed;
      const realMerge = seed.ctx.github.mergePull.bind(seed.ctx.github);
      let mergeCalls = 0;
      const ctx: MergeContext = {
        ...seed.ctx,
        github: {
          ...seed.ctx.github,
          mergePull: async (repo: string, pull: number, sha: string): Promise<void> => {
            mergeCalls += 1;
            await git(seed.harness.sandbox.seed, ["checkout", "main"]);
            await Bun.write(
              join(seed.harness.sandbox.seed, "f.txt"),
              `main line\nrace ${String(mergeCalls)}\n`,
            );
            await git(seed.harness.sandbox.seed, ["add", "f.txt"]);
            await git(seed.harness.sandbox.seed, ["commit", "-m", `b2-${String(mergeCalls)}`]);
            await git(seed.harness.sandbox.seed, ["push", "origin", "main"]);
            return realMerge(repo, pull, sha);
          },
        },
      };
      const outcome = await mergeCheck(ctx, item());
      expect(outcome).toBe("done");
      expect(mergeCalls).toBe(1);
      const view = await seed.ctx.github.viewPull(REPO, 1);
      const mergeSha = view.mergeCommit;
      if (mergeSha === null) {
        throw new Error("expected a merge commit");
      }
      const state = await readLoopState(ctx.statePath);
      expect(state.mergeHold).not.toBeNull();
      const hold = state.mergeHold as {
        readonly mergeSha: string;
        readonly workItemId: string;
        readonly expectedBase: string;
        readonly parents: readonly string[];
        readonly since: string;
      } | null;
      if (hold === null) {
        throw new Error("expected a merge hold");
      }
      expect(hold.mergeSha).toBe(mergeSha);
      expect(hold.workItemId).toBe("gh-demo-1");
      expect(hold.expectedBase).toBe(base);
      const racedBase = hold.parents[0] ?? "";
      expect(racedBase).not.toBe("");
      expect(hold.parents).toEqual([racedBase, head]);
      expect(racedBase).not.toBe(base);
      expect(hold.since).toBe(NOW);
      const li = await readItem(ctx.statePath);
      expect(li.phase).toBe("final");
      expect(li.finalize).toEqual({ result: "success", done: true });
      expect(li.rounds).toHaveLength(1);
      expect(li.rounds[0]).toMatchObject({
        outcome: "merged",
        headSha: head,
        baseRace: true,
        verdict: { auditorModel: AUDITOR, high: 0, medium: 0, low: 0 },
      });
      const resultsFile = Bun.file(ctx.resultsPath);
      const lines = (await resultsFile.text()).split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0] as string) as { routingResult: string }).routingResult).toBe(
        "success",
      );
      const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
      expect(store.items[0]?.status).toBe("done");
      const records = (await Bun.file(ctx.ledgerPath).text())
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as unknown);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ workItemId: "gh-demo-1", result: "success" });
      const stateCheck = await readLoopState(ctx.statePath);
      expect(stateCheck.mergeHold).toEqual(hold);
      const raceEvents = seed.harness.events.filter((line) => line.startsWith("merge-base-race:"));
      expect(raceEvents).toHaveLength(1);
      const snapshot: StubGitHubSnapshot = (
        seed.ctx.github as unknown as { snapshot(): StubGitHubSnapshot }
      ).snapshot();
      const escalations = snapshot.issues.filter((issue) =>
        issue.labels.includes(seed.ctx.escalationLabel),
      );
      expect(escalations).toHaveLength(1);
      expect(escalations[0]?.body.split("\n")[0]).toBe(`<!-- moc:escalation:race:${mergeSha} -->`);
      expect(escalations[0]?.body).toContain(
        `Merge ${mergeSha} of pull request #1 has parents ${racedBase}, ${head}, not [${base}, ${head}]: the merged tree was not trial-merged.`,
      );
      expect(view.state).toBe("MERGED");
      const mergedEvents = seed.harness.events.filter((line) => line.startsWith("merged:"));
      expect(mergedEvents).toHaveLength(1);
      expect(mergedEvents[0]).toContain(`:${mergeSha}:`);
      // MT3's second call uses a fresh mutex and waits on the set hold
      // before any second GitHub read: the state stays byte-equal and
      // no further merge runs.
      const secondLi = await secondReviewItem(seed);
      const head2 = secondLi.pull?.headSha;
      if (head2 === undefined) {
        throw new Error("expected a second head");
      }
      await writeStore(seed.ctx.storePath, {
        ...item(),
        id: "gh-demo-2",
        modelRouting: { preferredModel: PREFERRED, attempts: 0, fallbackUsed: false },
      });
      await seedFinishedSession(seed.harness.registryPath, "gh-demo-2:0");
      await updateLoopState<undefined>(seed.ctx.statePath, (state) =>
        Promise.resolve({
          next: {
            ...state,
            items: {
              ...state.items,
              "gh-demo-2": secondLi as unknown as Record<string, unknown>,
            },
          },
          value: undefined,
        }),
      );
      const beforeHold = await Bun.file(ctx.statePath).text();
      const heldCtx: MergeContext = { ...ctx, mergeMutex: createMergeMutex() };
      const next = await mergeCheck(heldCtx, { ...item(), id: "gh-demo-2" });
      expect(next).toBe("pending");
      expect(await Bun.file(ctx.statePath).text()).toBe(beforeHold);
      expect(mergeCalls).toBe(1);
    });
  });
});

// MT4: an already-merged PR in merging finishes without merging again.
// MT5: an already-merged PR in auditing finishes as a human merge.
test("MT4 an already merged PR in merging finishes without merging again", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head, base } = seed;
      const ctx = seed.ctx;
      let mergeCalls = 0;
      let parentsCalls = 0;
      const tracked: MergeContext = {
        ...ctx,
        github: {
          ...ctx.github,
          mergePull: async (repo: string, pull: number, sha: string): Promise<void> => {
            mergeCalls += 1;
            return ctx.github.mergePull(repo, pull, sha);
          },
          commitParents: async (repo: string, sha: string): Promise<readonly string[]> => {
            parentsCalls += 1;
            return ctx.github.commitParents(repo, sha);
          },
        },
      };
      await ctx.github.mergePull(REPO, 1, head);
      await writeLoopState(
        ctx.statePath,
        readyItem(head, {
          phase: "merging",
          trial: { baseSha: base, headSha: head, passed: true },
        }),
      );
      const outcome = await mergeCheck(tracked, item());
      expect(outcome).toBe("done");
      expect(mergeCalls).toBe(0);
      expect(parentsCalls).toBe(1);
      const li = await readItem(ctx.statePath);
      expect(li.phase).toBe("final");
      expect(li.humanInterventions).toBe(0);
      expect(li.rounds[0]).toMatchObject({ outcome: "merged", baseRace: false });
    });
  });
});

test("MT5 an already merged PR in auditing finishes as a human merge", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head } = seed;
      const ctx = seed.ctx;
      let mergeCalls = 0;
      let parentsCalls = 0;
      const tracked: MergeContext = {
        ...ctx,
        github: {
          ...ctx.github,
          mergePull: async (repo: string, pull: number, sha: string): Promise<void> => {
            mergeCalls += 1;
            return ctx.github.mergePull(repo, pull, sha);
          },
          commitParents: async (repo: string, sha: string): Promise<readonly string[]> => {
            parentsCalls += 1;
            return ctx.github.commitParents(repo, sha);
          },
        },
      };
      await ctx.github.mergePull(REPO, 1, head);
      const outcome = await mergeCheck(tracked, item());
      expect(outcome).toBe("done");
      expect(mergeCalls).toBe(0);
      expect(parentsCalls).toBe(0);
      const li = await readItem(ctx.statePath);
      expect(li.phase).toBe("final");
      expect(li.humanInterventions).toBe(1);
      expect(li.rounds[0]).toMatchObject({ outcome: "merged", baseRace: false });
    });
  });
});

// MT6: a conflicting trial closes trial-failed without merging.
test("MT6 a conflicting trial closes trial-failed without merging", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head } = seed;
      const ctx = seed.ctx;
      await git(seed.harness.sandbox.seed, ["checkout", "main"]);
      await Bun.write(join(seed.harness.sandbox.seed, "f.txt"), "main line\nconflict base\n");
      await git(seed.harness.sandbox.seed, ["add", "f.txt"]);
      await git(seed.harness.sandbox.seed, ["commit", "-m", "base-conflict"]);
      await git(seed.harness.sandbox.seed, ["push", "origin", "main"]);
      const checkout = ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      const base = await ctx.github.baseSha(REPO, "main");
      await git(seed.harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
      await Bun.write(join(seed.harness.sandbox.seed, "f.txt"), "main line\nconflict head\n");
      await git(seed.harness.sandbox.seed, ["add", "f.txt"]);
      await git(seed.harness.sandbox.seed, ["commit", "--amend", "--no-edit"]);
      await git(seed.harness.sandbox.seed, ["push", "--force", "origin", "moc/gh-demo-1"]);
      await git(checkout, ["fetch", "origin"]);
      let mergeCalls = 0;
      const amendedHead = (await ctx.github.viewPull(REPO, 1)).headRefOid;
      expect(amendedHead).not.toBe(head);
      const amendedVerdict = cleanVerdict(amendedHead);
      await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${amendedHead}.json`),
        `${JSON.stringify(amendedVerdict)}\n`,
      );
      const amendedMarker = renderComment(amendedVerdict);
      if (amendedMarker !== null) {
        await ctx.github.postComment(REPO, 1, amendedMarker);
      }
      await writeLoopState(ctx.statePath, readyItem(amendedHead, {}));
      const tracked: MergeContext = {
        ...ctx,
        github: {
          ...ctx.github,
          mergePull: async (repo: string, pull: number, sha: string): Promise<void> => {
            mergeCalls += 1;
            return ctx.github.mergePull(repo, pull, sha);
          },
        },
      };
      const seededHead = (await tracked.github.viewPull(REPO, 1)).headRefOid;
      expect(seededHead).toBe(amendedHead);
      const conflictedHead = seededHead;
      const outcome = await mergeCheck(tracked, item());
      expect(outcome).toBe("idle");
      expect(mergeCalls).toBe(0);
      const li = await readItem(ctx.statePath);
      expect(li.trial).toEqual({ baseSha: base, headSha: conflictedHead, passed: false });
      expect(li.rounds[0]).toMatchObject({ outcome: "trial-failed", headSha: conflictedHead });
      const stored = (await tracked.github.viewPull(REPO, 1)).headRefOid;
      expect(stored).toBe(conflictedHead);
      const resultsText = await Bun.file(ctx.resultsPath)
        .text()
        .catch(() => "");
      const resultLines = resultsText.split("\n").filter((line) => line !== "");
      expect(resultLines).toHaveLength(1);
      expect(
        (JSON.parse(resultLines[0] as string) as { routingResult: string }).routingResult,
      ).toBe("excluded");
    });
  });
});

// MT7: a wrong base parks the item without closing a round.
test("MT7 a wrong base parks the item without closing a round", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const harness = await makeHarness(dir);
    const ctx = harness.ctx;
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      const checkout = ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await git(harness.sandbox.seed, ["checkout", "-B", "other", "main"]);
      await git(harness.sandbox.seed, ["push", "origin", "other"]);
      const targetPull = await ctx.github.createPull(REPO, "moc/gh-demo-1", "other", "t2", "b2");
      expect(targetPull).toBe(1);
      const verdict = cleanVerdict(head, 2);
      await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${head}.json`),
        `${JSON.stringify(verdict)}\n`,
      );
      const marker = renderComment(verdict);
      if (marker !== null) {
        await ctx.github.postComment(REPO, targetPull, marker);
      }
      await appendPending(ctx.ledgerPath, pendingLedger());
      await seedFinishedSession(harness.registryPath);
      await writeStore(ctx.storePath, item());
      await writeLoopState(
        ctx.statePath,
        readyItem(head, { pull: { number: targetPull, headSha: head } }),
      );
      const outcome = await mergeCheck(ctx, item());
      expect(outcome).toBe("parked");
      const li = await readItem(ctx.statePath);
      expect(li.park).toMatchObject({ code: "base-mismatch" });
      expect(li.rounds).toHaveLength(0);
      expect(li.phase).toBe("idle");
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const harness = await makeHarness(dir);
    const ctx = harness.ctx;
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      const checkout = ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await git(harness.sandbox.seed, ["checkout", "-B", "other", "main"]);
      await git(harness.sandbox.seed, ["push", "origin", "other"]);
      const mergedNumber = await ctx.github.createPull(REPO, "moc/gh-demo-1", "other", "t", "b");
      await ctx.github.mergePull(REPO, mergedNumber, head);
      const verdict = cleanVerdict(head);
      await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${head}.json`),
        `${JSON.stringify(verdict)}\n`,
      );
      const marker = renderComment(verdict);
      if (marker !== null) {
        await ctx.github.postComment(REPO, mergedNumber, marker);
      }
      await appendPending(ctx.ledgerPath, pendingLedger());
      await seedFinishedSession(harness.registryPath);
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, readyItem(head));
      const outcome = await mergeCheck(ctx, item());
      expect(outcome).toBe("parked");
      const li = await readItem(ctx.statePath);
      expect(li.park).toMatchObject({ code: "merged-elsewhere" });
      expect(li.rounds).toHaveLength(0);
      expect(li.phase).toBe("idle");
      const stored = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
      expect(stored.items[0]?.status).not.toBe("done");
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

// MT8: findings close the round without merging.
test("MT8 findings close the round without merging", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head } = seed;
      const findingsVerdict = {
        ...cleanVerdict(head),
        counts: { high: 1 as const, medium: 0 as const, low: 0 as const },
        findings: [
          {
            severity: "high" as const,
            location: "src/example.ts:1",
            defect: "A finding blocks the merge.",
            scenario: "Review flags the head.",
            fixDirection: "Fix the flagged code.",
          },
        ],
      };
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${head}.json`),
        `${JSON.stringify(findingsVerdict)}\n`,
      );
      const marker = renderComment(findingsVerdict);
      if (marker !== null) {
        await seed.ctx.github.postComment(REPO, 1, marker);
      }
      let mergeCalls = 0;
      const ctx: MergeContext = {
        ...seed.ctx,
        github: {
          ...seed.ctx.github,
          mergePull: async (repo: string, pull: number, sha: string): Promise<void> => {
            mergeCalls += 1;
            return seed.ctx.github.mergePull(repo, pull, sha);
          },
        },
      };
      const outcome = await mergeCheck(ctx, item());
      expect(outcome).toBe("idle");
      expect(mergeCalls).toBe(0);
      const li = await readItem(ctx.statePath);
      expect(li.rounds[0]).toMatchObject({
        outcome: "findings",
        headSha: head,
        verdict: { auditorModel: AUDITOR, high: 1, medium: 0, low: 0 },
      });
      expect(li.rounds).toHaveLength(1);
      const stored = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
      expect(stored.items[0]?.status).toBe("queued");
      await reconcile(ctx.storePath, item().id, li, ctx);
      const projected = project(item(), li, ctx);
      expect(projected.stallRounds).toBe(1);
      expect(stored.items[0]).toMatchObject({
        stallRounds: projected.stallRounds,
        status: "queued",
      });
    });
  });
});

// MT9: a missing marker parks in auditing and returns to auditing otherwise.
test("MT9 a missing marker parks in auditing and returns otherwise", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(
      dir,
      async (seed) => {
        let commentCalls = 0;
        const tracked: MergeContext = {
          ...seed.ctx,
          github: {
            ...seed.ctx.github,
            postComment: async (repo: string, number: number, body: string): Promise<void> => {
              commentCalls += 1;
              return seed.ctx.github.postComment(repo, number, body);
            },
          },
        };
        const outcome = await mergeCheck(tracked, item());
        expect(outcome).toBe("parked");
        expect(commentCalls).toBe(0);
        const li = await readItem(seed.ctx.statePath);
        expect(li.park).toMatchObject({ code: "marker-missing" });
        const parked = (await Bun.file(seed.ctx.storePath).json()) as { items: WorkItem[] };
        expect(parked.items[0]?.status).toBe("parked");
        expect(li.rounds).toHaveLength(0);
      },
      {},
      { skipMarker: true },
    );
  });
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const harness = await makeHarness(dir);
    const ctx = harness.ctx;
    try {
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await appendPending(ctx.ledgerPath, pendingLedger());
      await seedFinishedSession(harness.registryPath);
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, readyItem(head, { phase: "awaiting-approval" }));
      const verdict = cleanVerdict(head);
      await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${head}.json`),
        `${JSON.stringify(verdict)}\n`,
      );
      const outcome = await mergeCheck(ctx, item());
      expect(outcome).toBe("auditing");
      const li = await readItem(ctx.statePath);
      expect(li.phase).toBe("auditing");
      expect(li.park).toBeNull();
      expect(li.rounds).toHaveLength(0);
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

// MT10: human-approval waits for an approval of the exact triple.
// A reconciled seed projects awaiting items as review.
test("MT10 human-approval waits for an approval of the exact triple", async () => {
  await withTempDir(async (dir) => {
    const approveHead = async (ctx: MergeContext, head: string, pull: number): Promise<void> => {
      const recorded = await recordRequest(join(dir, "approval-requests.json"), {
        tool: "approve",
        args: { workItemId: "gh-demo-1", pullNumber: pull, headSha: head, reason: "Ship it." },
        caller: "owner",
        now: () => new Date(NOW),
        maxPending: 20,
      });
      if (recorded.kind !== "recorded") {
        throw new Error(`expected recorded, got ${recorded.kind}`);
      }
      const decided = await decideRequest(join(dir, "approval-requests.json"), {
        requestId: recorded.request.requestId,
        decision: "approved",
        author: "owner",
        now: () => new Date(NOW),
      });
      if (decided.kind !== "decided") {
        throw new Error(`expected decided, got ${decided.kind}`);
      }
      expect(ctx.specs).toHaveLength(1);
    };
    await withReadySeed(
      dir,
      async (seed) => {
        const { head } = seed;
        const human: MergeContext = {
          ...seed.ctx,
          specs: [{ schemaVersion: "v1", repo: REPO, mergeMode: "human-approval" }],
        };
        const waiting = await mergeCheck(human, item());
        expect(waiting).toBe("awaiting-approval");
        const stored = await readItem(human.statePath);
        expect(stored.phase).toBe("awaiting-approval");
        await reconcile(human.storePath, item().id, stored, human);
        const saved = (await Bun.file(human.storePath).json()) as { items: WorkItem[] };
        expect(saved.items[0]?.status).toBe("review");
        let mergeCalls = 0;
        const tracked: MergeContext = {
          ...human,
          github: {
            ...human.github,
            mergePull: async (repo: string, pull: number, sha: string): Promise<void> => {
              mergeCalls += 1;
              return human.github.mergePull(repo, pull, sha);
            },
          },
        };
        expect(mergeCalls).toBe(0);
        await approveHead(human, `${"0".repeat(39)}1`, 1);
        const stillWaiting = await mergeCheck(tracked, item());
        expect(stillWaiting).toBe("awaiting-approval");
        expect(mergeCalls).toBe(0);
        await approveHead(human, head, 1);
        const done = await mergeCheck(tracked, item());
        expect(done).toBe("done");
        expect(mergeCalls).toBe(1);
      },
      {},
      {
        store: (_head, li, projectionCtx) => {
          const projected = project(item(), li, projectionCtx);
          return {
            ...item(),
            status: projected.status,
            statusReason: projected.statusReason,
            assignedHostAlias: projected.assignedHostAlias,
            branch: projected.branch,
            pullNumber: projected.pullNumber,
            modelRouting: projected.modelRouting,
            retryCount: projected.retryCount,
            stallRounds: projected.stallRounds,
            dod: item().dod.map((entry) => ({
              ...entry,
              done: entry.id === "D1" ? projected.dodDone : entry.done,
            })),
          };
        },
      },
    );
  });
});

// MT11/MT12: CI pending returns to ci with a fresh ciSince.
test("MT11 pending CI returns to ci with a fresh ciSince", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(
      dir,
      async (seed) => {
        const outcome = await mergeCheck(seed.ctx, item());
        expect(outcome).toBe("ci");
        const li = await readItem(seed.ctx.statePath);
        expect(li.phase).toBe("ci");
        expect(li.ciSince).toBe(NOW);
      },
      { ciSince: "2026-10-28T09:00:00.000Z" },
      { ci: () => "pending" },
    );
  });
});

test("MT12 a new head after the audit returns to ci with a fresh ciSince", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(
      dir,
      async (seed) => {
        const { head } = seed;
        const checkout = seed.ctx.repos[0]?.checkoutDir ?? dir;
        await git(seed.harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
        await Bun.write(join(seed.harness.sandbox.seed, "f.txt"), "main line\nsecond head\n");
        await git(seed.harness.sandbox.seed, ["add", "f.txt"]);
        await git(seed.harness.sandbox.seed, ["commit", "--amend", "--no-edit"]);
        await git(seed.harness.sandbox.seed, ["push", "--force", "origin", "moc/gh-demo-1"]);
        await git(checkout, ["fetch", "origin"]);
        const moved = (await seed.ctx.github.viewPull(REPO, 1)).headRefOid;
        expect(moved).not.toBe(head);
        let mergeCalls = 0;
        const ctx: MergeContext = {
          ...seed.ctx,
          github: {
            ...seed.ctx.github,
            mergePull: async (repo: string, pull: number, sha: string): Promise<void> => {
              mergeCalls += 1;
              return seed.ctx.github.mergePull(repo, pull, sha);
            },
          },
        };
        const outcome = await mergeCheck(ctx, item());
        expect(outcome).toBe("ci");
        expect(mergeCalls).toBe(0);
        const li = await readItem(ctx.statePath);
        expect(li.pull?.headSha).toBe(moved);
        expect(li.ciSince).toBe(NOW);
      },
      { ciSince: "2026-10-28T09:00:00.000Z" },
    );
  });
});

// MT13: a verdict authored by the session author parks as verdict-invalid.
test("MT13 a verdict authored by the session author parks as verdict-invalid", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head } = seed;
      const authored = {
        ...cleanVerdict(head),
        auditorModel: PREFERRED,
        authorModels: [AUDITOR],
      };
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${head}.json`),
        `${JSON.stringify(authored)}\n`,
      );
      const marker = renderComment(authored);
      if (marker !== null) {
        await seed.ctx.github.postComment(REPO, 1, marker);
      }
      const outcome = await mergeCheck(seed.ctx, item());
      expect(outcome).toBe("parked");
      const li = await readItem(seed.ctx.statePath);
      expect(li.park).toMatchObject({ code: "verdict-invalid" });
      await reconcile(seed.ctx.storePath, item().id, li, seed.ctx);
      const saved = (await Bun.file(seed.ctx.storePath).json()) as { items: WorkItem[] };
      expect(saved.items[0]?.status).toBe("parked");
    });
  });
});

// MT14: rejected merges count attempts and then park as merge-failed.
test("MT14 rejected merges count attempts and then park as merge-failed", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head } = seed;
      let mergeCalls = 0;
      const rejecting = (base: MergeContext): MergeContext => ({
        ...base,
        mergeRetries: 1,
        mergeMutex: createMergeMutex(),
        github: {
          ...base.github,
          mergePull: (): Promise<void> => {
            mergeCalls += 1;
            return Promise.reject(
              new GitHubError("rejected", "mergePull", "mergePull: merge conflict"),
            );
          },
        },
      });
      const first = await mergeCheck(rejecting(seed.ctx), item());
      expect(first).toBe("pending");
      expect((await readItem(seed.ctx.statePath)).mergeAttempts).toEqual({
        headSha: head,
        count: 1,
      });
      const second = await mergeCheck(rejecting(seed.ctx), item());
      expect(second).toBe("pending");
      expect((await readItem(seed.ctx.statePath)).mergeAttempts).toEqual({
        headSha: head,
        count: 2,
      });
      const third = await mergeCheck(rejecting(seed.ctx), item());
      expect(third).toBe("parked");
      expect(mergeCalls).toBe(2);
      const li = await readItem(seed.ctx.statePath);
      expect(li.park).toMatchObject({ code: "merge-failed" });
      await reconcile(seed.ctx.storePath, item().id, li, seed.ctx);
      const saved = (await Bun.file(seed.ctx.storePath).json()) as { items: WorkItem[] };
      expect(saved.items[0]?.status).toBe("parked");
    });
  });
});

// MT15: a seeded merge hold stops the driver before any GitHub read.
test("MT15 a seeded merge hold stops the driver before any GitHub read", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head } = seed;
      const { updateLoopState } = await import("../../src/loop/state.js");
      await updateLoopState<undefined>(seed.ctx.statePath, (state) =>
        Promise.resolve({
          next: {
            ...state,
            mergeHold: {
              mergeSha: "d".repeat(40),
              workItemId: "gh-demo-1",
              expectedBase: "b".repeat(40),
              parents: ["b".repeat(40), head],
              since: NOW,
            },
          },
          value: undefined,
        }),
      );
      const before = await Bun.file(seed.ctx.statePath).text();
      let baseCalls = 0;
      let mergeCalls = 0;
      const baseImpl = seed.ctx.github.baseSha.bind(seed.ctx.github);
      const mergeImpl = seed.ctx.github.mergePull.bind(seed.ctx.github);
      const ctx: MergeContext = {
        ...seed.ctx,
        github: {
          ...seed.ctx.github,
          baseSha: (...args: Parameters<typeof seed.ctx.github.baseSha>) => {
            baseCalls += 1;
            return baseImpl(...args);
          },
          mergePull: (...args: Parameters<typeof seed.ctx.github.mergePull>) => {
            mergeCalls += 1;
            return mergeImpl(...args);
          },
        },
      };
      const outcome = await mergeCheck(ctx, item());
      expect(outcome).toBe("pending");
      expect(baseCalls).toBe(0);
      expect(mergeCalls).toBe(0);
      const after = await Bun.file(seed.ctx.statePath).text();
      expect(after).toBe(before);
    });
  });
});

// MT16: awaiting-approval without a verdict file returns to auditing.
// MT16b: the same in auditing returns to auditing with no park.
test("MT16 awaiting-approval without a verdict file returns to auditing", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(
      dir,
      async (seed) => {
        await Bun.$`rm ${join(dir, "verdicts", "gh-demo-1", `${seed.head}.json`)}`.quiet();
        const outcome = await mergeCheck(seed.ctx, item());
        expect(outcome).toBe("auditing");
        const li = await readItem(seed.ctx.statePath);
        expect(li.phase).toBe("auditing");
        expect(li.park).toBeNull();
      },
      { phase: "awaiting-approval" },
    );
  });
  await withTempDir(async (dir) => {
    await withReadySeed(
      dir,
      async (seed) => {
        await Bun.$`rm ${join(dir, "verdicts", "gh-demo-1", `${seed.head}.json`)}`.quiet();
        const outcome = await mergeCheck(seed.ctx, item());
        expect(outcome).toBe("auditing");
        const li = await readItem(seed.ctx.statePath);
        expect(li.phase).toBe("auditing");
        expect(li.park).toBeNull();
        const issues = (
          seed.ctx.github as unknown as {
            snapshot(): StubGitHubSnapshot;
          }
        )
          .snapshot()
          .issues.filter((entry) => entry.labels.includes("moc-escalation"));
        expect(issues).toHaveLength(0);
      },
      { phase: "auditing" },
    );
  });
});

// MT17: GitHub errors log once and keep the phase.
test("MT17 GitHub errors log once and keep the phase", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      let calls = 0;
      const failing: MergeContext = {
        ...seed.ctx,
        github: {
          ...seed.ctx.github,
          viewPull: async (repo: string, pull: number) => {
            calls += 1;
            if (calls === 1) {
              throw new GitHubError("unavailable", "viewPull", "unavailable");
            }
            return seed.ctx.github.viewPull(repo, pull);
          },
        },
      };
      const before = await Bun.file(seed.ctx.statePath).text();
      const outcome = await mergeCheck(failing, item());
      expect(outcome).toBe("pending");
      expect(await Bun.file(seed.ctx.statePath).text()).toBe(before);
      const errors = seed.events.filter((line) => line.startsWith("github-error:"));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("unavailable:viewPull");
    });
  });
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head } = seed;
      let mergeCalls = 0;
      const flaky = (base: MergeContext): MergeContext => ({
        ...base,
        mergeRetries: 1,
        mergeMutex: createMergeMutex(),
        github: {
          ...base.github,
          mergePull: async (repo: string, pull: number, sha: string): Promise<void> => {
            mergeCalls += 1;
            if (mergeCalls === 1) {
              throw new GitHubError("unavailable", "mergePull", "rejected");
            }
            return seed.ctx.github.mergePull(repo, pull, sha);
          },
        },
      });
      const first = await mergeCheck(flaky(seed.ctx), item());
      expect(first).toBe("pending");
      const second = await mergeCheck(flaky(seed.ctx), item());
      expect(second).toBe("done");
      expect(mergeCalls).toBe(2);
      expect((await readItem(seed.ctx.statePath)).mergeAttempts).toEqual({
        headSha: head,
        count: 2,
      });
    });
  });
});

// MT18: finishMerge finalizes the ledger once, then writes final.
test("MT18 finishMerge finalizes the ledger once then writes final", async () => {
  await withTempDir(async (dir) => {
    const restoreEnv = applyTestEnv();
    const harness = await makeHarness(dir);
    const ctx = harness.ctx;
    try {
      const base = await harness.ctx.github.baseSha(REPO, "main");
      expect(base).not.toBe("");
      const head = await pushEmpty(harness.sandbox.seed, "moc/gh-demo-1");
      const checkout = harness.ctx.repos[0]?.checkoutDir ?? dir;
      await git(checkout, ["fetch", "origin"]);
      await ctx.github.createPull(REPO, "moc/gh-demo-1", "main", "t", "b");
      await ctx.github.mergePull(REPO, 1, head);
      const mergedHead = (await ctx.github.viewPull(REPO, 1)).headRefOid;
      const verdict = cleanVerdict(mergedHead);
      await mkdir(join(dir, "verdicts", "gh-demo-1"), { recursive: true });
      await Bun.write(
        join(dir, "verdicts", "gh-demo-1", `${mergedHead}.json`),
        `${JSON.stringify(verdict)}\n`,
      );
      const marker = renderComment(verdict);
      if (marker !== null) {
        await ctx.github.postComment(REPO, 1, marker);
      }
      await appendPending(ctx.ledgerPath, pendingLedger());
      await seedFinishedSession(harness.registryPath);
      await writeStore(ctx.storePath, item());
      await writeLoopState(ctx.statePath, {
        ...readyItem(mergedHead),
        phase: "finalizing",
        finalize: { result: "success", done: false },
        rounds: [
          {
            round: 0,
            retry: 0,
            requestId: "gh-demo-1:0",
            model: PREFERRED,
            providerId: PROVIDER,
            hostAlias: "host-a",
            attempt: "success",
            outcome: "merged",
            headSha: mergedHead,
            failingChecks: [],
            verdict: { auditorModel: AUDITOR, high: 0, medium: 0, low: 0 },
            newlyMet: [],
            at: NOW,
            baseRace: false,
          },
        ],
      });
      const mid = await readItem(ctx.statePath);
      expect(mid.phase).toBe("finalizing");
      expect(mid.finalize).toEqual({ result: "success", done: false });
      const fresh: MergeContext = { ...ctx, mergeMutex: createMergeMutex() };
      const first = await finishMerge(fresh, item());
      expect(first).toBe("done");
      const li = await readItem(ctx.statePath);
      expect(li.phase).toBe("final");
      expect(li.finalize).toEqual({ result: "success", done: true });
      const records = await Bun.file(fresh.ledgerPath).text();
      const lines = records.split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] ?? "{}") as { result?: string };
      expect(parsed.result).toBe("success");
      const mergedEvents = harness.events.filter((line) => line.startsWith("merged:"));
      expect(mergedEvents).toHaveLength(0);
      const second = await finishMerge(fresh, item());
      expect(second).toBe("done");
      const again = await Bun.file(fresh.ledgerPath).text();
      expect(again.split("\n").filter((line) => line !== "")).toHaveLength(1);
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

// MT21: a failed trial in merging writes auditing and then closes trial-failed.
test("MT21 a failed trial in merging audits again then closes trial-failed", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(
      dir,
      async (seed) => {
        const fetched = seed.ctx.repos[0]?.checkoutDir ?? dir;
        await git(seed.harness.sandbox.seed, ["checkout", "main"]);
        await Bun.write(join(seed.harness.sandbox.seed, "f.txt"), "main line\nconflict base\n");
        await git(seed.harness.sandbox.seed, ["add", "f.txt"]);
        await git(seed.harness.sandbox.seed, ["commit", "-m", "base-conflict"]);
        await git(seed.harness.sandbox.seed, ["push", "origin", "main"]);
        await git(fetched, ["fetch", "origin"]);
        const movedBase = await seed.ctx.github.baseSha(REPO, "main");
        expect(movedBase).not.toBe(seed.base);
        await git(seed.harness.sandbox.seed, ["checkout", "moc/gh-demo-1"]);
        await Bun.write(join(seed.harness.sandbox.seed, "f.txt"), "main line\nconflict head\n");
        await git(seed.harness.sandbox.seed, ["add", "f.txt"]);
        await git(seed.harness.sandbox.seed, ["commit", "--amend", "--no-edit"]);
        await git(seed.harness.sandbox.seed, ["push", "--force", "origin", "moc/gh-demo-1"]);
        await git(fetched, ["fetch", "origin"]);
        const conflictedHead = (await seed.ctx.github.viewPull(REPO, 1)).headRefOid;
        expect(conflictedHead).not.toBe(seed.head);
        const verdict = cleanVerdict(conflictedHead);
        await Bun.write(
          join(dir, "verdicts", "gh-demo-1", `${conflictedHead}.json`),
          `${JSON.stringify(verdict)}\n`,
        );
        const marker = renderComment(verdict);
        if (marker !== null) {
          await seed.ctx.github.postComment(REPO, 1, marker);
        }
        await writeLoopState(
          seed.ctx.statePath,
          readyItem(conflictedHead, {
            phase: "merging",
            pull: { number: 1, headSha: conflictedHead },
            trial: { baseSha: seed.base, headSha: conflictedHead, passed: true },
          }),
        );
        const midCtx: MergeContext = {
          ...seed.ctx,
          dispatcher: {
            start: seed.ctx.dispatcher.start.bind(seed.ctx.dispatcher),
            cancel: seed.ctx.dispatcher.cancel.bind(seed.ctx.dispatcher),
            watch: () => Promise.reject(new Error("fault: close")),
          },
        };
        let thrown: unknown = null;
        try {
          await mergeCheck(midCtx, item());
        } catch (error: unknown) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe("fault: close");
        const mid = await readItem(seed.ctx.statePath);
        expect(mid.phase).toBe("auditing");
        expect(mid.trial).toEqual({
          baseSha: movedBase,
          headSha: conflictedHead,
          passed: false,
        });
        expect(mid.rounds).toHaveLength(0);
        const next = await mergeCheck(seed.ctx, item());
        expect(next).toBe("idle");
        const li = await readItem(seed.ctx.statePath);
        expect(li.phase).toBe("idle");
        expect(seed.head).not.toBe("");
        expect(li.trial).toEqual({ baseSha: movedBase, headSha: conflictedHead, passed: false });
        expect(li.rounds).toHaveLength(1);
        expect(li.rounds[0]).toMatchObject({ outcome: "trial-failed", headSha: conflictedHead });
      },
      {},
    );
  });
});

// MT22: a merged close with stagnant rounds finalizes with no stall park.
test("MT22 a finalizing close skips the stall decision", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(
      dir,
      async (seed) => {
        const fetched = seed.ctx.repos[0]?.checkoutDir ?? dir;
        await git(fetched, ["fetch", "origin"]);
        await seed.ctx.github.mergePull(REPO, 1, seed.head);
        const mergedHead = (await seed.ctx.github.viewPull(REPO, 1)).headRefOid;
        const stagnant: LoopItem = {
          ...initialLoopItem(),
          session: { hostAlias: "host-a", providerId: PROVIDER, model: PREFERRED },
          phase: "auditing",
          requestId: "gh-demo-1:0",
          pull: { number: 1, headSha: mergedHead },
          ciSince: NOW,
          trial: { baseSha: seed.base, headSha: mergedHead, passed: true },
          round: 1,
          rounds: [
            {
              round: 0,
              retry: 0,
              requestId: "gh-demo-1:0",
              model: PREFERRED,
              providerId: PROVIDER,
              hostAlias: "host-a",
              attempt: "success",
              outcome: "trial-failed",
              headSha: mergedHead,
              failingChecks: [],
              verdict: null,
              newlyMet: [],
              at: "2026-10-28T09:00:00.000Z",
              baseRace: false,
            },
          ],
        };
        await writeLoopState(seed.ctx.statePath, stagnant);
        await writeStore(seed.ctx.storePath, {
          ...item(),
          status: "review",
          statusReason: "stalled: 1 rounds without a newly met DoD item",
        });
        const stalled: MergeContext = {
          ...seed.ctx,
          stall: { maxStagnantRounds: 1, maxRetries: 2 },
        };
        const pendingOutcome: Promise<MergeOutcome> = mergeCheck(stalled, item());
        // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression
        await expect(pendingOutcome).resolves.toBe("done");
        const li = await readItem(stalled.statePath);
        expect(li.phase).toBe("final");
        expect(li.finalize).toEqual({ result: "success", done: true });
        expect(li.park).toBeNull();
        expect(li.rounds).toHaveLength(2);
        expect(li.rounds[0]).toMatchObject({ outcome: "trial-failed" });
        expect(li.rounds[1]).toMatchObject({ outcome: "merged", baseRace: false });
        const mergedEvents = seed.events.filter((line) => line.startsWith("merged:"));
        expect(mergedEvents).toHaveLength(1);
        const stored = (await Bun.file(stalled.storePath).json()) as { items: WorkItem[] };
        expect(stored.items[0]?.status).toBe("done");
      },
      {},
    );
  });
});

// MT23: a human-merged PR in a repo with no spec throws, and nothing is written.
test("MT23 a repo without a factory spec throws before any write", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head } = seed;
      await seed.ctx.github.mergePull(REPO, 1, head);
      const missing: MergeContext = { ...seed.ctx, specs: [] };
      const before = await Bun.file(missing.statePath).text();
      let thrown: unknown = null;
      try {
        await mergeCheck(missing, item());
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("merge: no factory spec for example/demo");
      expect(await Bun.file(missing.statePath).text()).toBe(before);
    });
  });
});

// MT19: a failed escalation keeps the race pending without a second event.
test("MT19 a failed escalation keeps the race pending without a second event", async () => {
  await withTempDir(async (dir) => {
    await withReadySeed(dir, async (seed) => {
      const { head } = seed;
      const stateBefore = await readLoopState(seed.ctx.statePath);
      expect(stateBefore.mergeHold).toBeNull();
      const realMerge = seed.ctx.github.mergePull.bind(seed.ctx.github);
      const realIssue = seed.ctx.github.createIssue.bind(seed.ctx.github);
      let issueCalls = 0;
      const flaky: MergeContext = {
        ...seed.ctx,
        github: {
          ...seed.ctx.github,
          mergePull: async (repo: string, pull: number, sha: string): Promise<void> => {
            await git(seed.harness.sandbox.seed, ["checkout", "main"]);
            await Bun.write(join(seed.harness.sandbox.seed, "f.txt"), "main line\nrace one\n");
            await git(seed.harness.sandbox.seed, ["add", "f.txt"]);
            await git(seed.harness.sandbox.seed, ["commit", "-m", "race one"]);
            await git(seed.harness.sandbox.seed, ["push", "origin", "main"]);
            await realMerge(repo, pull, sha);
          },
          createIssue: async (
            repo: string,
            title: string,
            body: string,
            labels: readonly string[],
          ) => {
            issueCalls += 1;
            if (issueCalls === 1) {
              throw new GitHubError("unavailable", "createIssue", "unavailable");
            }
            return realIssue(repo, title, body, labels);
          },
        },
      };
      const first = await mergeCheck(flaky, item());
      expect(first).toBe("pending");
      const held = await readLoopState(seed.ctx.statePath);
      expect(held.mergeHold).not.toBeNull();
      expect(issueCalls).toBe(1);
      const races = seed.events.filter((line) => line.startsWith("merge-base-race:"));
      expect(races).toHaveLength(1);
      const mid = await readItem(seed.ctx.statePath);
      expect(mid.phase).toBe("merging");
      expect(head).not.toBe("");
      const steady: MergeContext = {
        ...seed.ctx,
        github: {
          ...seed.ctx.github,
          mergePull: () => Promise.resolve(),
          createIssue: realIssue,
        },
      };
      const second = await mergeCheck(steady, item());
      expect(second).toBe("done");
      const issues = seed.ctx.github as unknown as {
        snapshot(): StubGitHubSnapshot;
      };
      const escalationIssues = issues
        .snapshot()
        .issues.filter((entry) => entry.labels.includes("moc-escalation"));
      expect(escalationIssues).toHaveLength(1);
      const later = seed.events.filter((line) => line.startsWith("merge-base-race:"));
      expect(later).toHaveLength(1);
    });
  });
});
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

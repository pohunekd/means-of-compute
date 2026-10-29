// Driver merge tests (slice 5e rows MT1-MT19): the ready path, the
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
import {
  createStubGitHub,
  type StubCi,
  type StubGitHubSnapshot,
} from "../../src/loop/stub/github.js";
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

async function seedFinishedSession(registryPath: string): Promise<void> {
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
  readonly head: string;
  readonly base: string;
}

async function seedReadyItem(
  dir: string,
  overrides: Partial<LoopItem> = {},
  opts: { readonly branch?: string; readonly ci?: (sha: string) => StubCi } = {},
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
  const marker = renderComment(verdict);
  if (marker !== null) {
    await harness.ctx.github.postComment(REPO, 1, marker);
  }
  await appendPending(harness.ctx.ledgerPath, pendingLedger());
  await seedFinishedSession(harness.registryPath);
  await writeStore(harness.ctx.storePath, item());
  await writeLoopState(harness.ctx.statePath, readyItem(head, overrides));
  return { harness, ctx: harness.ctx, head, base };
}

async function withReadySeed(
  dir: string,
  body: (seed: ReadySeed) => Promise<void>,
  overrides: Partial<LoopItem> = {},
  opts: { readonly branch?: string; readonly ci?: (sha: string) => StubCi } = {},
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

// MT3: a raced merge sets the hold, escalates once and keeps later calls out.
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
      expect(outcome).toBe("pending");
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
      expect(li.phase).toBe("merging");
      expect(li.rounds).toHaveLength(0);
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
      // A set hold stops the second call at MR3 step 1: the raced item
      // stays merging with byte-equal state and no further merge call.
      const before = await Bun.file(ctx.statePath).text();
      const next = await mergeCheck(ctx, item());
      expect(next).toBe("pending");
      expect(await Bun.file(ctx.statePath).text()).toBe(before);
      expect(mergeCalls).toBe(1);
      const done = await readItem(ctx.statePath);
      expect(done.phase).toBe("merging");
      expect(done.rounds).toHaveLength(0);
      const resultsFile = Bun.file(ctx.resultsPath);
      if (await resultsFile.exists()) {
        const lines = (await resultsFile.text()).split("\n").filter((line) => line !== "");
        expect(lines).toHaveLength(0);
      }
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
      const stored = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
      expect(stored.items[0]?.status).not.toBe("done");
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

// MT1: ready with an ancestral base merges, finalizes and logs one event.
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
    } finally {
      restoreEnv();
      await harness.sandbox.cleanup();
    }
  });
});

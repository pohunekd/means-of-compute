// Work store projection tests (matrix rows C4-C6): the status table,
// attempts with an open session, stall counting, branch derivation and
// the reconcile write, no-op and busy paths.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../../contracts/v1/types.js";
import { LoopStateDataError } from "../../src/loop/state.js";
import type { LoopItem, RoundRecord } from "../../src/loop/types.js";
import { applyProjection, project, reconcile } from "../../src/loop/project.js";

const PREFERRED = "meta/muse-glimmer-30b";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    schemaVersion: "v1",
    id: "gh-moc-5",
    repo: "example/demo-repo",
    title: "Item gh-moc-5",
    goal: "Goal of gh-moc-5",
    issue: null,
    dod: [
      { id: "D1", text: "First", done: false },
      { id: "D2", text: "Second", done: false },
    ],
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

function record(overrides: Partial<RoundRecord> = {}): RoundRecord {
  return {
    round: 0,
    retry: 0,
    requestId: null,
    model: PREFERRED,
    providerId: "nvidia-build",
    hostAlias: null,
    attempt: "failure",
    outcome: "red-ci",
    headSha: null,
    failingChecks: [],
    verdict: null,
    newlyMet: [],
    at: "2026-10-28T00:00:00.000Z",
    baseRace: false,
    ...overrides,
  };
}

function loopItem(overrides: Partial<LoopItem> = {}): LoopItem {
  return {
    phase: "idle",
    round: 0,
    retry: 0,
    park: null,
    session: null,
    fallbackUsed: false,
    start: null,
    requestId: null,
    pull: null,
    ciSince: null,
    trial: null,
    rounds: [],
    failures: {},
    excludedHosts: [],
    startRejections: 0,
    escalations: [],
    followups: [],
    humanInterventions: 0,
    finalize: null,
    auditAttempts: null,
    mergeAttempts: null,
    backoffUntil: null,
    ...overrides,
  };
}

const CTX = { branchPrefix: "moc/" };

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-project-"));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

async function writeStore(path: string, items: readonly WorkItem[]): Promise<void> {
  await Bun.write(
    path,
    `${JSON.stringify({ schemaVersion: "v1", revision: 0, items, submissions: [] })}\n`,
  );
}

test("the status table holds for every row of L3 (C4)", () => {
  const base = item();
  expect(project(base, loopItem(), CTX).status).toBe("queued");
  expect(project(base, loopItem({ phase: "starting" }), CTX).status).toBe("queued");
  const finalized = loopItem({ phase: "final", finalize: { result: "success", done: true } });
  const done = project(base, finalized, CTX);
  expect(done.status).toBe("done");
  expect(done.dodDone).toBe(true);
  expect(applyProjection(base, done).dod.every((entry) => entry.done)).toBe(true);
  const stall = loopItem({ park: { kind: "stall", reason: "stalled: 3 rounds", code: null } });
  const parked = project(base, stall, CTX);
  expect(parked.status).toBe("parked");
  expect(parked.statusReason).toBe("stalled: 3 rounds");
  const blockedItem = loopItem({
    phase: "final",
    park: { kind: "blocked", reason: "blocked: retries used", code: null },
    finalize: { result: "blocked", done: false },
  });
  expect(project(base, blockedItem, CTX).status).toBe("blocked");
  expect(project(base, loopItem({ phase: "running" }), CTX).status).toBe("running");
  expect(project(base, loopItem({ phase: "publishing" }), CTX).status).toBe("running");
  expect(project(base, loopItem({ phase: "ci" }), CTX).status).toBe("review");
  expect(project(base, loopItem({ phase: "auditing" }), CTX).status).toBe("review");
  expect(project(base, loopItem({ phase: "merging" }), CTX).status).toBe("review");
  expect(project(base, loopItem({ phase: "awaiting-approval" }), CTX).status).toBe("review");
  expect(project(base, loopItem({ phase: "final" }), CTX).status).toBe("queued");
  expect(project(base, loopItem({ phase: "finalizing" }), CTX).status).toBe("queued");
});

test("a start-rejected round on the preferred model never counts toward attempts (F5)", () => {
  const base = item();
  const li = loopItem({
    retry: 0,
    session: { hostAlias: "host-a", providerId: "nvidia-build", model: PREFERRED },
    rounds: [
      record({ round: 0, retry: 0, model: PREFERRED }),
      record({
        round: 1,
        retry: 0,
        model: PREFERRED,
        outcome: "start-rejected",
        attempt: "failure",
      }),
      record({ round: 2, retry: 0, model: PREFERRED, outcome: "lost", attempt: "lost" }),
    ],
  });
  const p = project(base, li, CTX);
  // One preferred round plus the open preferred session; start-rejected
  // and lost never count.
  expect(p.modelRouting.attempts).toBe(2);
});

test("ci-timeout and trial-failed count while start-rejected and lost never do (P10)", () => {
  const base = item();
  const li = loopItem({
    rounds: [
      record({ round: 0, model: PREFERRED, outcome: "ci-timeout", attempt: "failure" }),
      record({ round: 1, model: PREFERRED, outcome: "trial-failed", attempt: "failure" }),
      record({ round: 2, model: PREFERRED, outcome: "start-rejected", attempt: "failure" }),
      record({ round: 3, model: PREFERRED, outcome: "lost", attempt: "lost" }),
    ],
  });
  expect(project(base, li, CTX).modelRouting.attempts).toBe(2);
});

test("attempts count the open session once, stall counts the retry only, branch needs a head (C5)", () => {
  const base = item();
  const li = loopItem({
    retry: 1,
    session: { hostAlias: "host-a", providerId: "nvidia-build", model: PREFERRED },
    rounds: [
      record({ round: 0, retry: 0, model: PREFERRED }),
      record({ round: 1, retry: 0, model: "other/fallback-8b" }),
      record({ round: 2, retry: 1, model: PREFERRED, outcome: "red-ci" }),
    ],
  });
  const p = project(base, li, CTX);
  // Two preferred rounds plus the open preferred session.
  expect(p.modelRouting.attempts).toBe(3);
  expect(p.modelRouting.fallbackUsed).toBe(false);
  // Only retry-1 stagnant rounds count.
  expect(p.stallRounds).toBe(1);
  expect(p.retryCount).toBe(1);
  expect(p.assignedHostAlias).toBe("host-a");
  expect(p.branch).toBe(null);
  expect(p.pullNumber).toBe(null);
  const headed = loopItem({
    pull: { number: 7, headSha: "abc123" },
    rounds: [record({ headSha: "abc123" })],
  });
  const withHead = project(base, headed, CTX);
  expect(withHead.branch).toBe("moc/gh-moc-5");
  expect(withHead.pullNumber).toBe(7);
  const rounded = loopItem({ rounds: [record({ headSha: "def456" })] });
  expect(project(base, rounded, CTX).branch).toBe("moc/gh-moc-5");
});

test("reconcile leaves an unchanged projection alone (C6)", async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, "work-items.json");
    const li = loopItem();
    const stored = applyProjection(item(), project(item(), li, CTX));
    await writeStore(storePath, [stored]);
    const before = readFileSync(storePath, "utf8");
    expect(await reconcile(storePath, "gh-moc-5", li, CTX)).toBe("unchanged");
    expect(readFileSync(storePath, "utf8")).toBe(before);
  });
});

test("reconcile writes a changed projection with revision + 1 (C6)", async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, "work-items.json");
    await writeStore(storePath, [item()]);
    const li = loopItem({
      phase: "running",
      session: { hostAlias: "host-b", providerId: "nvidia-build", model: PREFERRED },
    });
    expect(await reconcile(storePath, "gh-moc-5", li, CTX)).toBe("written");
    const after = JSON.parse(readFileSync(storePath, "utf8")) as {
      revision: number;
      items: WorkItem[];
    };
    expect(after.revision).toBe(1);
    expect(after.items[0]?.status).toBe("running");
    expect(after.items[0]?.assignedHostAlias).toBe("host-b");
    expect(await reconcile(storePath, "gh-moc-5", li, CTX)).toBe("unchanged");
  });
});

test("reconcile on an unknown id throws the rule (a) text (C6)", async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, "work-items.json");
    await writeStore(storePath, [item()]);
    let error: unknown;
    try {
      await reconcile(storePath, "gh-moc-9", loopItem(), CTX);
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopStateDataError);
    expect((error as Error).message).toBe(
      `work store ${storePath}: rule (a): item "gh-moc-9" is not in the work store`,
    );
  });
});

test("reconcile on a held store lock gives busy (C6)", async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, "work-items.json");
    await writeStore(storePath, [item()]);
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "work", "lock-holder.case.ts")], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, WORK_STORE_TEST_PATH: storePath },
    });
    try {
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error("holder exited before printing the ready line");
        }
        if ((decoder.decode(value, { stream: true }) + "\n").includes("holder ready")) {
          reader.releaseLock();
          break;
        }
      }
      expect(await reconcile(storePath, "gh-moc-5", loopItem(), CTX)).toBe("busy");
    } finally {
      child.kill(9);
      await child.exited;
    }
  });
});

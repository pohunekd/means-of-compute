// Round close tests (matrix rows C7-C9): the close write set, the
// stall park key, excluded outcomes, and the R7 recovery append.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../../contracts/v1/types.js";
import type { LoopLog } from "../../src/loop/log.js";
import { readLoopState } from "../../src/loop/state.js";
import type { LoopItem, RoundRecord } from "../../src/loop/types.js";
import { appendMissingResults, closeRound, type CoreContext } from "../../src/loop/rounds.js";

const PREFERRED = "meta/muse-glimmer-30b";
const PROVIDER = "nvidia-build";

function item(): WorkItem {
  return {
    schemaVersion: "v1",
    id: "gh-moc-5",
    repo: "example/demo-repo",
    title: "Item gh-moc-5",
    goal: "Goal of gh-moc-5",
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
  };
}

function record(overrides: Partial<RoundRecord> = {}): RoundRecord {
  return {
    round: 0,
    retry: 0,
    requestId: "req-000001",
    model: PREFERRED,
    providerId: PROVIDER,
    hostAlias: "host-a",
    attempt: "failure",
    outcome: "red-ci",
    headSha: null,
    failingChecks: ["gates"],
    verdict: null,
    newlyMet: [],
    at: "2026-10-28T00:00:00.000Z",
    baseRace: false,
    ...overrides,
  };
}

const STORED_INTENT: LoopItem["start"] = {
  round: 0,
  decision: {
    schemaVersion: "v1",
    workItemId: "gh-moc-5",
    chosenHostAlias: "host-a",
    reason: "only idle host",
    candidates: [{ hostAlias: "host-a", score: 1, reason: "idle", excluded: false }],
  },
  model: { providerId: PROVIDER, model: PREFERRED },
  brief: "Stored intent",
  itemBranch: null,
  requestId: "req-000001",
};

function loopItem(overrides: Partial<LoopItem> = {}): LoopItem {
  return {
    phase: "running",
    round: 0,
    retry: 0,
    park: null,
    session: { hostAlias: "host-a", providerId: PROVIDER, model: PREFERRED },
    fallbackUsed: false,
    start: null,
    requestId: "req-000001",
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

function logged(): { log: LoopLog; events: { event: string; code?: string }[] } {
  const events: { event: string; code?: string }[] = [];
  return {
    events,
    log: {
      log(event): void {
        events.push({ event: event.event, code: event.code });
      },
      failed(): boolean {
        return false;
      },
      async close(): Promise<void> {},
    },
  };
}

function ctxFor(dir: string): { ctx: CoreContext; events: { event: string; code?: string }[] } {
  const seen = logged();
  return {
    events: seen.events,
    ctx: {
      branchPrefix: "moc/",
      statePath: join(dir, "loop-state.json"),
      resultsPath: join(dir, "loop-results.jsonl"),
      storePath: join(dir, "work-items.json"),
      stall: { maxStagnantRounds: 3, maxRetries: 1 },
      log: seen.log,
      now: () => new Date("2026-10-28T00:00:01.000Z"),
    },
  };
}

async function writeState(path: string, li: LoopItem): Promise<void> {
  await Bun.write(
    path,
    `${JSON.stringify({
      schemaVersion: "v1",
      revision: 0,
      items: { "gh-moc-5": li },
      resolvedApprovals: [],
      mergeHold: null,
      lastDigestDay: null,
    })}\n`,
  );
}

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-rounds-"));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("closeRound appends the record and returns continue (C7)", async () => {
  await withTempDir(async (dir) => {
    const { ctx, events } = ctxFor(dir);
    await writeState(ctx.statePath, loopItem());
    const decision = await closeRound(ctx, item(), {
      outcome: "red-ci",
      attempt: "failure",
      requestId: "req-000001",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: "host-a",
      headSha: null,
      failingChecks: ["gates"],
      verdict: null,
      baseRace: false,
    });
    expect(decision).toEqual({ kind: "continue", stallRounds: 1 });
    const state = await readLoopState(ctx.statePath);
    const li = state.items["gh-moc-5"] as unknown as LoopItem;
    expect(li.rounds).toHaveLength(1);
    expect(li.rounds[0]).toMatchObject({ round: 0, retry: 0, newlyMet: [] });
    expect(li.round).toBe(1);
    expect(li.session).toBe(null);
    expect(li.requestId).toBe(null);
    expect(li.phase).toBe("idle");
    expect(li.failures[PREFERRED]).toBe(1);
    const lines = readFileSync(ctx.resultsPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      key: "gh-moc-5:0",
      outcome: "red-ci",
      routingResult: "failure",
    });
    expect(events).toEqual([{ event: "round-closed", code: "red-ci" }]);
  });
});

test("a starting start-rejected close clears the intent and stays idle (C8)", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = ctxFor(dir);
    // The D2 outcome state: starting with a stored intent and no session.
    await writeState(
      ctx.statePath,
      loopItem({ phase: "starting", session: null, start: STORED_INTENT }),
    );
    const rejected = await closeRound(ctx, item(), {
      outcome: "start-rejected",
      attempt: "failure",
      requestId: "req-000001",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: null,
      headSha: null,
      failingChecks: [],
      verdict: null,
      baseRace: false,
    });
    expect(rejected).toEqual({ kind: "continue", stallRounds: 0 });
    const state = await readLoopState(ctx.statePath);
    const li = state.items["gh-moc-5"] as unknown as LoopItem;
    expect(li.phase).toBe("idle");
    expect(li.start).toBe(null);
    expect(li.rounds).toHaveLength(1);
    expect(li.rounds[0]).toMatchObject({ outcome: "start-rejected", retry: 0 });
  });
});

test("a starting lost close clears the intent and stays idle (C8)", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = ctxFor(dir);
    await writeState(
      ctx.statePath,
      loopItem({ phase: "starting", session: null, start: STORED_INTENT }),
    );
    const lost = await closeRound(ctx, item(), {
      outcome: "lost",
      attempt: "lost",
      requestId: "req-000001",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: null,
      headSha: null,
      failingChecks: [],
      verdict: null,
      baseRace: false,
    });
    expect(lost).toEqual({ kind: "continue", stallRounds: 0 });
    const state = await readLoopState(ctx.statePath);
    const li = state.items["gh-moc-5"] as unknown as LoopItem;
    expect(li.phase).toBe("idle");
    expect(li.start).toBe(null);
    expect(li.rounds[0]).toMatchObject({ outcome: "lost", attempt: "lost" });
  });
});

test("a start-rejected close is excluded and the third stagnant close parks (C8)", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = ctxFor(dir);
    await writeState(
      ctx.statePath,
      loopItem({
        round: 2,
        rounds: [record({ round: 0 }), record({ round: 1 })],
      }),
    );
    const rejected = await closeRound(ctx, item(), {
      outcome: "start-rejected",
      attempt: "failure",
      requestId: "req-000003",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: null,
      headSha: null,
      failingChecks: [],
      verdict: null,
      baseRace: false,
    });
    // Start-rejected is excluded: it neither raises failures nor counts.
    expect(rejected).toEqual({ kind: "continue", stallRounds: 2 });
    const decision = await closeRound(ctx, item(), {
      outcome: "red-ci",
      attempt: "failure",
      requestId: "req-000004",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: "host-a",
      headSha: null,
      failingChecks: ["gates"],
      verdict: null,
      baseRace: false,
    });
    expect(decision.kind).toBe("park");
    if (decision.kind === "park") {
      expect(decision.escalationKey).toBe("stall:gh-moc-5:0");
    }
    const state = await readLoopState(ctx.statePath);
    const li = state.items["gh-moc-5"] as unknown as LoopItem;
    // Only the failure-routed close raises the count.
    expect(li.failures[PREFERRED]).toBe(1);
    expect(li.start).toBe(null);
  });
});

test("a close at retry 1 keeps retry 1 in the record, line and park key (F4)", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = ctxFor(dir);
    await writeState(
      ctx.statePath,
      loopItem({
        round: 2,
        retry: 1,
        rounds: [record({ round: 0, retry: 0 }), record({ round: 1, retry: 0 })],
      }),
    );
    const decision = await closeRound(ctx, item(), {
      outcome: "red-ci",
      attempt: "failure",
      requestId: "req-000003",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: "host-a",
      headSha: null,
      failingChecks: ["gates"],
      verdict: null,
      baseRace: false,
    });
    expect(decision).toEqual({ kind: "continue", stallRounds: 1 });
    const state = await readLoopState(ctx.statePath);
    const li = state.items["gh-moc-5"] as unknown as LoopItem;
    expect(li.rounds).toHaveLength(3);
    expect(li.rounds[2]).toMatchObject({ round: 2, retry: 1 });
    const lines = readFileSync(ctx.resultsPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ key: "gh-moc-5:2", retry: 1 });
  });
});

test("the third stagnant close at retry 1 parks with the retry 1 key (F4)", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = ctxFor(dir);
    await writeState(
      ctx.statePath,
      loopItem({
        round: 4,
        retry: 1,
        rounds: [
          record({ round: 0, retry: 0 }),
          record({ round: 1, retry: 0 }),
          record({ round: 2, retry: 1 }),
          record({ round: 3, retry: 1 }),
        ],
      }),
    );
    const decision = await closeRound(ctx, item(), {
      outcome: "red-ci",
      attempt: "failure",
      requestId: "req-000005",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: "host-a",
      headSha: null,
      failingChecks: ["gates"],
      verdict: null,
      baseRace: false,
    });
    expect(decision.kind).toBe("park");
    if (decision.kind === "park") {
      expect(decision.escalationKey).toBe("stall:gh-moc-5:1");
    }
    const state = await readLoopState(ctx.statePath);
    const li = state.items["gh-moc-5"] as unknown as LoopItem;
    expect(li.rounds[4]).toMatchObject({ round: 4, retry: 1 });
  });
});

test("start-rejected twice keeps one exclusion and counts two rejections (U14)", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = ctxFor(dir);
    await writeState(
      ctx.statePath,
      loopItem({ phase: "starting", session: null, start: STORED_INTENT }),
    );
    const close = {
      outcome: "start-rejected",
      attempt: "failure",
      requestId: "req-000001",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: "host-a",
      headSha: null,
      failingChecks: [],
      verdict: null,
      baseRace: false,
    } as const;
    await closeRound(ctx, item(), { ...close });
    await writeState(
      ctx.statePath,
      loopItem({
        phase: "starting",
        session: null,
        start: STORED_INTENT,
        round: 1,
        rounds: [record({ round: 0, outcome: "start-rejected", attempt: "failure" })],
        excludedHosts: ["host-a"],
        startRejections: 1,
      }),
    );
    await closeRound(ctx, item(), { ...close, requestId: "req-000002" });
    const state = await readLoopState(ctx.statePath);
    const li = state.items["gh-moc-5"] as unknown as LoopItem;
    expect(li.excludedHosts).toEqual(["host-a"]);
    expect(li.startRejections).toBe(2);
  });
});

test("lost adds the host without raising startRejections (U14)", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = ctxFor(dir);
    await writeState(
      ctx.statePath,
      loopItem({
        phase: "starting",
        session: null,
        start: STORED_INTENT,
        excludedHosts: ["host-b"],
        startRejections: 1,
      }),
    );
    await closeRound(ctx, item(), {
      outcome: "lost",
      attempt: "lost",
      requestId: "req-000001",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: "host-a",
      headSha: null,
      failingChecks: [],
      verdict: null,
      baseRace: false,
    });
    const state = await readLoopState(ctx.statePath);
    const li = state.items["gh-moc-5"] as unknown as LoopItem;
    expect(li.excludedHosts).toEqual(["host-b", "host-a"]);
    expect(li.startRejections).toBe(1);
  });
});

test("red-ci changes neither excludedHosts nor startRejections (U14)", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = ctxFor(dir);
    await writeState(ctx.statePath, loopItem({ excludedHosts: ["host-a"], startRejections: 2 }));
    await closeRound(ctx, item(), {
      outcome: "red-ci",
      attempt: "failure",
      requestId: "req-000001",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: "host-a",
      headSha: null,
      failingChecks: ["gates"],
      verdict: null,
      baseRace: false,
    });
    const state = await readLoopState(ctx.statePath);
    const li = state.items["gh-moc-5"] as unknown as LoopItem;
    expect(li.excludedHosts).toEqual(["host-a"]);
    expect(li.startRejections).toBe(2);
  });
});
test("appendMissingResults repairs one deleted line and is then a no-op (C9)", async () => {
  await withTempDir(async (dir) => {
    const { ctx } = ctxFor(dir);
    await writeState(ctx.statePath, loopItem({ phase: "idle", session: null, requestId: null }));
    const redCi = {
      outcome: "red-ci",
      attempt: "failure",
      requestId: "req-000001",
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: "host-a",
      headSha: null,
      failingChecks: ["gates"],
      verdict: null,
      baseRace: false,
    } as const;
    await closeRound(ctx, item(), { ...redCi, requestId: "req-000001" });
    await closeRound(ctx, item(), { ...redCi, requestId: "req-000002" });
    const before = readFileSync(ctx.resultsPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(before).toHaveLength(2);
    // Simulate a crash between the L write and the result line write:
    // the last record has no line yet.
    await Bun.write(ctx.resultsPath, `${before[0] as string}\n`);
    expect(await appendMissingResults(ctx, [item()])).toBe(1);
    expect(await appendMissingResults(ctx, [item()])).toBe(0);
    const lines = readFileSync(ctx.resultsPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(before[1]);
  });
});

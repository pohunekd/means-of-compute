// Park slice tests (rows P1-P9): escalate, finalize, stall retry and
// block, the lost and operator parks, and the label journal.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../../contracts/v1/types.js";
import type { PendingUsage } from "../../src/ledger/types.js";
import { appendPending } from "../../src/ledger/store.js";
import { GitHubError } from "../../src/loop/github.js";
import type { LoopLog } from "../../src/loop/log.js";
import {
  advancePark,
  escalate,
  escalationMarker,
  parkLost,
  parkOperator,
  parkStall,
  unparkLost,
  type ParkContext,
} from "../../src/loop/park.js";
import { closeRound } from "../../src/loop/rounds.js";
import { readLoopState } from "../../src/loop/state.js";
import type { LoopItem } from "../../src/loop/types.js";
import { FakeGitHub } from "./fake-github.js";

const PREFERRED = "meta/muse-glimmer-30b";
const PROVIDER = "nvidia-build";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    schemaVersion: "v1",
    id: "gh-moc-5",
    repo: "example/demo-repo",
    title: "Item gh-moc-5",
    goal: "Goal of gh-moc-5",
    issue: 12,
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

function logged(): { log: LoopLog; events: string[] } {
  const events: string[] = [];
  return {
    events,
    log: {
      log(event): void {
        events.push(`${event.event}:${event.code ?? ""}:${event.detail ?? ""}`);
      },
      failed(): boolean {
        return false;
      },
      async close(): Promise<void> {},
    },
  };
}

function makeCtx(
  dir: string,
  fake: FakeGitHub,
  overrides: Partial<ParkContext> = {},
): { ctx: ParkContext; events: string[] } {
  const seen = logged();
  const statePath = join(dir, "loop-state.json");
  const ctx: ParkContext = {
    branchPrefix: "moc/",
    statePath,
    resultsPath: join(dir, "loop-results.jsonl"),
    storePath: join(dir, "work-items.json"),
    stall: { maxStagnantRounds: 3, maxRetries: 2 },
    log: seen.log,
    now: () => new Date("2026-10-28T00:00:01.000Z"),
    github: fake,
    factoryLogin: "factory-bot",
    ledgerPath: join(dir, "ledger.jsonl"),
    escalationLabel: "moc-escalation",
    readyLabel: "moc-ready",
    blockedLabel: "moc-blocked",
    maxRetries: 2,
    ...overrides,
  };
  fake.login = ctx.factoryLogin;
  return { ctx, events: seen.events };
}

async function writeLoopState(path: string, li: LoopItem): Promise<void> {
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

async function writeStore(path: string, entry: WorkItem): Promise<void> {
  await Bun.write(
    path,
    `${JSON.stringify({ schemaVersion: "v1", revision: 0, items: [entry], submissions: [] })}\n`,
  );
}

async function readItem(statePath: string): Promise<LoopItem> {
  const state = await readLoopState(statePath);
  return state.items["gh-moc-5"] as unknown as LoopItem;
}

function sessionUsage(): PendingUsage {
  return {
    entryId: "e1-session",
    kind: "session",
    workItemId: "gh-moc-5",
    finishedAt: "2026-10-26T10:40:00.000Z",
    startModel: PREFERRED,
    tokens: [
      {
        provider: "meta-api",
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

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-park-"));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

async function redRounds(ctx: ParkContext, entry: WorkItem, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const decision = await closeRound(ctx, entry, {
      outcome: "red-ci",
      attempt: "failure",
      requestId: null,
      model: PREFERRED,
      providerId: PROVIDER,
      hostAlias: null,
      headSha: null,
      failingChecks: ["gates"],
      verdict: null,
      baseRace: false,
    });
    if (index + 1 < count && decision.kind === "park") {
      throw new Error("parked before the third stagnant round");
    }
    if (index + 1 === count) {
      if (decision.kind !== "park") {
        throw new Error("expected a stall park decision");
      }
      await parkStall(ctx, entry, decision);
    }
  }
}

test("escalate posts once and the second call writes nothing (P1)", async () => {
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx, events } = makeCtx(dir, fake);
    const entry = item();
    await writeLoopState(ctx.statePath, loopItem());
    await writeStore(ctx.storePath, entry);
    const key = "stall:gh-moc-5:0";
    expect(await escalate(ctx, entry, key, "")).toBe("done");
    const posts = fake.callsOf("postComment");
    expect(posts).toHaveLength(1);
    const body = posts[0]?.args[2] as string;
    expect(posts[0]?.args[1] as number).toBe(12);
    expect(body.split("\n")[0]).toBe(escalationMarker(key));
    expect((await readItem(ctx.statePath)).escalations[0]).toMatchObject({
      key,
      posted: 12,
    });
    expect(fake.calls).toHaveLength(2);
    expect(await escalate(ctx, entry, key, "")).toBe("done");
    expect(fake.calls).toHaveLength(2);
    expect(events.some((line) => line.startsWith("escalation:stall:gh-moc-5:0"))).toBe(true);
  });
});

test("a factory marker is adopted and a foreign login posts (P2)", async () => {
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx } = makeCtx(dir, fake);
    const entry = item();
    const key = "stall:gh-moc-5:0";
    await writeLoopState(
      ctx.statePath,
      loopItem({
        escalations: [{ key, retry: 0, target: { issue: 12 }, posted: null }],
      }),
    );
    await writeStore(ctx.storePath, entry);
    fake.seedComment("example/demo-repo", 12, "factory-bot", `${escalationMarker(key)}\nold`);
    expect(await escalate(ctx, entry, key, "")).toBe("done");
    expect(fake.callsOf("postComment")).toHaveLength(0);
    expect((await readItem(ctx.statePath)).escalations[0]?.posted).toBe(12);
  });
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx } = makeCtx(dir, fake);
    const entry = item();
    const key = "stall:gh-moc-5:0";
    await writeLoopState(
      ctx.statePath,
      loopItem({
        escalations: [{ key, retry: 0, target: { issue: 12 }, posted: null }],
      }),
    );
    await writeStore(ctx.storePath, entry);
    fake.seedComment("example/demo-repo", 12, "other", `${escalationMarker(key)}\nold`);
    expect(await escalate(ctx, entry, key, "")).toBe("done");
    expect(fake.callsOf("postComment")).toHaveLength(1);
  });
});

test("a null issue creates one labelled issue and adopts it (P3)", async () => {
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx } = makeCtx(dir, fake);
    const entry = item({ issue: null });
    await writeLoopState(ctx.statePath, loopItem());
    await writeStore(ctx.storePath, entry);
    const key = "stall:gh-moc-5:0";
    expect(await escalate(ctx, entry, key, "")).toBe("done");
    const created = fake.callsOf("createIssue");
    expect(created).toHaveLength(1);
    expect(created[0]?.args[1]).toBe("Escalation (gh-moc-5)");
    expect(created[0]?.args[3]).toEqual(["moc-escalation"]);
    const posted = (await readItem(ctx.statePath)).escalations[0]?.posted;
    expect(typeof posted).toBe("number");
    await writeLoopState(ctx.statePath, loopItem());
    const before = fake.calls.length;
    expect(await escalate(ctx, entry, key, "")).toBe("done");
    expect(fake.callsOf("createIssue")).toHaveLength(1);
    expect(fake.calls.length).toBeGreaterThan(before);
  });
});

test("a failed post stays pending and retries (P4)", async () => {
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx, events } = makeCtx(dir, fake);
    const entry = item();
    await writeLoopState(ctx.statePath, loopItem());
    await writeStore(ctx.storePath, entry);
    fake.failNext("postComment", new GitHubError("unavailable", "postComment", "down"));
    expect(await escalate(ctx, entry, "stall:gh-moc-5:0", "")).toBe("pending");
    expect((await readItem(ctx.statePath)).escalations[0]?.posted).toBe(null);
    expect(events.some((line) => line.startsWith("github-error:unavailable"))).toBe(true);
    expect(await escalate(ctx, entry, "stall:gh-moc-5:0", "")).toBe("done");
  });
});

test("three stall parks retry twice then block with one ledger record (P5)", async () => {
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx } = makeCtx(dir, fake);
    const entry = item();
    await writeLoopState(ctx.statePath, loopItem({ round: 0, retry: 0 }));
    await writeStore(ctx.storePath, entry);
    await appendPending(ctx.ledgerPath, sessionUsage());
    await redRounds(ctx, entry, 3);
    let li = await readItem(ctx.statePath);
    expect(li.retry).toBe(1);
    expect(li.park).toBe(null);
    await redRounds(ctx, entry, 3);
    li = await readItem(ctx.statePath);
    expect(li.retry).toBe(2);
    await redRounds(ctx, entry, 3);
    li = await readItem(ctx.statePath);
    expect(li.park?.kind).toBe("blocked");
    expect(li.finalize).toEqual({ result: "blocked", done: true });
    const store = JSON.parse(await Bun.file(ctx.storePath).text()) as { items: WorkItem[] };
    expect(store.items[0]?.status).toBe("blocked");
    expect(store.items[0]?.statusReason).toBe("blocked: 2 retries used");
    expect(store.items[0]?.retryCount).toBe(2);
    const markers = new Set(
      fake.callsOf("postComment").map((call) => (call.args[2] as string).split("\n")[0]),
    );
    expect([...markers].sort()).toEqual([
      escalationMarker("stall:gh-moc-5:0"),
      escalationMarker("stall:gh-moc-5:1"),
      escalationMarker("stall:gh-moc-5:2"),
    ]);
    expect(fake.callsOf("editIssueLabels")).toHaveLength(1);
    expect(fake.callsOf("editIssueLabels")[0]?.args.slice(1)).toEqual([
      12,
      ["moc-blocked"],
      ["moc-ready"],
    ]);
  });
});

test("a broken ledger path stays pending, then finalizes when fixed (P6)", async () => {
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx } = makeCtx(dir, fake);
    const brokenParent = join(dir, "not-a-dir");
    await Bun.write(brokenParent, "blocking\n");
    const brokenCtx: ParkContext = { ...ctx, ledgerPath: join(brokenParent, "ledger.jsonl") };
    const blocked = loopItem({
      phase: "final",
      park: { kind: "blocked", reason: "blocked: 2 retries used", code: null },
      escalations: [{ key: "labels:gh-moc-5", retry: 2, target: { issue: 12 }, posted: 12 }],
      finalize: { result: "blocked", done: false },
      retry: 2,
    });
    await writeLoopState(brokenCtx.statePath, blocked);
    const blockedEntry = item({ issue: 12, retryCount: 2 });
    await writeStore(brokenCtx.storePath, {
      ...blockedEntry,
      status: "blocked",
      statusReason: "blocked: 2 retries used",
    });
    expect(await advancePark(brokenCtx, blockedEntry)).toBe("pending");
    let li = await readItem(brokenCtx.statePath);
    expect(li.finalize).toEqual({ result: "blocked", done: false });
    expect((await Bun.file(brokenCtx.storePath).json()) as { items: WorkItem[] }).toMatchObject({
      items: [{ status: "blocked" }],
    });
    await appendPending(ctx.ledgerPath, sessionUsage());
    const fixed: ParkContext = { ...brokenCtx, ledgerPath: ctx.ledgerPath };
    expect(await advancePark(fixed, blockedEntry)).toBe("done");
    li = await readItem(fixed.statePath);
    expect(li.finalize).toEqual({ result: "blocked", done: true });
  });
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx, events } = makeCtx(dir, fake);
    const entry = item();
    await writeLoopState(
      ctx.statePath,
      loopItem({
        phase: "final",
        park: { kind: "blocked", reason: "blocked: 2 retries used", code: null },
        escalations: [{ key: "labels:gh-moc-5", retry: 2, target: { issue: 12 }, posted: 12 }],
        finalize: { result: "blocked", done: false },
        retry: 2,
      }),
    );
    await writeStore(ctx.storePath, { ...entry, retryCount: 2 });
    expect(await advancePark(ctx, entry)).toBe("pending");
    expect(events.some((line) => line.startsWith("ledger-finalize-refused:"))).toBe(true);
    expect((await readItem(ctx.statePath)).finalize?.done).toBe(false);
  });
});

test("a failed label edit journals posted null and retries (P7)", async () => {
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx } = makeCtx(dir, fake);
    const entry = item();
    await writeLoopState(
      ctx.statePath,
      loopItem({
        phase: "final",
        park: { kind: "blocked", reason: "blocked: 2 retries used", code: null },
        finalize: { result: "blocked", done: true },
        retry: 2,
      }),
    );
    await writeStore(ctx.storePath, { ...entry, retryCount: 2 });
    fake.failNext("editIssueLabels", new GitHubError("unavailable", "editIssueLabels", "down"));
    expect(await advancePark(ctx, entry)).toBe("pending");
    expect((await readItem(ctx.statePath)).escalations[0]).toMatchObject({
      key: "labels:gh-moc-5",
      posted: null,
    });
    expect(await advancePark(ctx, entry)).toBe("done");
    expect(fake.callsOf("editIssueLabels")).toHaveLength(2);
    const before = fake.callsOf("editIssueLabels").length;
    expect(await advancePark(ctx, entry)).toBe("done");
    expect(await advancePark(ctx, entry)).toBe("done");
    expect(await advancePark(ctx, entry)).toBe("done");
    expect(fake.callsOf("editIssueLabels")).toHaveLength(before);
  });
});

test("a lost park waits and unparks queued on the next tick (P8)", async () => {
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx, events } = makeCtx(dir, fake);
    const entry = item();
    await writeLoopState(ctx.statePath, loopItem({ phase: "idle" }));
    await writeStore(ctx.storePath, entry);
    await parkLost(ctx, entry);
    let li = await readItem(ctx.statePath);
    expect(li.park?.kind).toBe("lost");
    const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
    expect(store.items[0]?.status).toBe("parked");
    expect(store.items[0]?.statusReason).toBe("session lost");
    expect(await advancePark(ctx, entry)).toBe("done");
    expect((await readItem(ctx.statePath)).park?.kind).toBe("lost");
    await unparkLost(ctx, entry);
    li = await readItem(ctx.statePath);
    expect(li.park).toBe(null);
    const reopened = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
    expect(reopened.items[0]?.status).toBe("queued");
    expect(events.some((line) => line.startsWith("unparked:"))).toBe(true);
    expect(reopened.items[0]?.stallRounds).toBe(0);
  });
});

test("an operator park holds while advancePark never unparks (P9)", async () => {
  await withTempDir(async (dir) => {
    const fake = new FakeGitHub();
    const { ctx } = makeCtx(dir, fake);
    const entry = item();
    await writeLoopState(
      ctx.statePath,
      loopItem({
        phase: "ci",
        session: { hostAlias: "host-a", providerId: PROVIDER, model: PREFERRED },
        requestId: "req-1",
      }),
    );
    await writeStore(ctx.storePath, entry);
    expect(await parkOperator(ctx, entry, "pull-closed")).toBe("done");
    const li = await readItem(ctx.statePath);
    expect(li.phase).toBe("idle");
    expect(li.requestId).toBe(null);
    expect(li.pull).toBe(null);
    expect(li.park).toMatchObject({ kind: "operator", reason: "operator: pull-closed" });
    const store = (await Bun.file(ctx.storePath).json()) as { items: WorkItem[] };
    expect(store.items[0]?.status).toBe("parked");
    expect(store.items[0]?.statusReason).toBe("operator: pull-closed");
    expect(fake.callsOf("postComment")[0]?.args[2] as string).toContain(
      escalationMarker("op:gh-moc-5:pull-closed"),
    );
    for (let index = 0; index < 10; index += 1) {
      expect(await advancePark(ctx, entry)).toBe("done");
      expect((await readItem(ctx.statePath)).park?.kind).toBe("operator");
    }
  });
});

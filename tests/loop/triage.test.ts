// Follow-up triage (#237): an auto decision appends Scope, DoD, Dependencies
// and Size to the filed body and flips the labels, so the next intake poll
// imports it; a hold posts one marked comment; a decided follow-up, a
// follow-up of a follow-up and a capped day send nothing to the model.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditFinding, AuditVerdict, WorkItem } from "../../contracts/v1/types.js";
import { writeVerdict } from "../../src/auditor/store.js";
import { readLedger } from "../../src/ledger/read.js";
import type { ModelRequest, SingleCallResult } from "../../src/providers/router.js";
import { findingFollowup } from "../../src/loop/followups.js";
import { createIntakeState, runIntake } from "../../src/loop/intake.js";
import type { LoopLog } from "../../src/loop/log.js";
import { initialLoopItem } from "../../src/loop/start.js";
import { createStubGitHub } from "../../src/loop/stub/github.js";
import { runTriage, triageMarker, type TriageContext } from "../../src/loop/triage.js";
import type { LoopItem } from "../../src/loop/types.js";
import { readWorkStore } from "../../src/work/store.js";

const REPO = "example/demo";
const SPARK = "muse-spark-1.3-contributor";
const FOLLOWUP_LABELS = ["factory:followup", "readiness:design-needed"];
const READY = ["factory:auto", "readiness:ready"];

function low(location: string, defect: string): AuditFinding {
  return { severity: "low", location, defect, scenario: "a reader", fixDirection: "reword it" };
}

function workItem(id: string, issue: number): WorkItem {
  return {
    schemaVersion: "v1",
    id,
    repo: REPO,
    title: `Item ${id}`,
    goal: "Goal",
    issue,
    dod: [{ id: "D1", text: "done", done: true }],
    dependencies: [],
    status: "done",
    statusReason: null,
    assignedHostAlias: null,
    branch: `moc/${id}`,
    pullNumber: 1,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 1, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
  };
}

function verdictOf(item: WorkItem, headSha: string, findings: AuditFinding[]): AuditVerdict {
  return {
    schemaVersion: "v1",
    repo: REPO,
    workItemId: item.id,
    pullNumber: 1,
    headSha,
    authorModels: ["meta/muse-glimmer-30b"],
    auditorModel: SPARK,
    counts: { high: 0, medium: 0, low: findings.length },
    findings,
  };
}

// A fixture factory: each source item is merged and final, its low findings
// are filed the way fileFindingFollowups files them, and every model call
// takes the next scripted reply.
function setup(dir: string, replies: string[], maxAutoPerDay: number) {
  const github = createStubGitHub({
    repo: REPO,
    originDir: join(dir, "origin.git"),
    baseBranch: "main",
    factoryLogin: "moc-factory",
    git: { PATH: process.env.PATH ?? "", timeoutMs: 30_000 },
    scratchDir: join(dir, "scratch"),
    ci: () => "success",
  });
  const verdictDir = join(dir, "verdicts");
  mkdirSync(verdictDir);
  const statePath = join(dir, "loop-state.json");
  const storePath = join(dir, "work-items.json");
  const items: WorkItem[] = [];
  const loopItems: Record<string, LoopItem> = {};
  async function merged(item: WorkItem, headSha: string, findings: AuditFinding[]) {
    const verdict = verdictOf(item, headSha, findings);
    await writeVerdict(verdictDir, verdict);
    const followups = [];
    for (const finding of findings) {
      const draft = findingFollowup(item, verdict, finding);
      const posted = await github.createIssue(REPO, draft.title, draft.body, FOLLOWUP_LABELS);
      followups.push({ key: draft.key, kind: "finding" as const, posted, body: draft.body });
    }
    items.push(item);
    loopItems[item.id] = {
      ...initialLoopItem(),
      phase: "final",
      round: 1,
      pull: { number: 1, headSha },
      finalize: { result: "success", done: true },
      followups: followups.map(({ key, kind, posted }) => ({ key, kind, posted })),
    };
    return followups;
  }
  async function persist(): Promise<void> {
    await Bun.write(
      storePath,
      `${JSON.stringify({ schemaVersion: "v1", revision: 0, items, submissions: [] })}\n`,
    );
    await Bun.write(
      statePath,
      `${JSON.stringify({
        schemaVersion: "v1",
        revision: 0,
        items: loopItems,
        resolvedApprovals: [],
        mergeHold: null,
        lastDigestDay: "2026-10-31",
      })}\n`,
    );
  }
  const calls: ModelRequest[] = [];
  const events: string[] = [];
  const log: LoopLog = {
    log(event): void {
      events.push(`${event.event}:${event.code ?? ""}:${event.detail ?? ""}`);
    },
    failed: () => false,
    close: () => Promise.resolve(),
  };
  const clock = { now: new Date("2026-11-01T00:01:00.000Z") };
  const ctx: TriageContext = {
    statePath,
    storePath,
    ledgerPath: join(dir, "ledger.jsonl"),
    verdictDir,
    github,
    factoryLogin: "moc-factory",
    followupLabels: FOLLOWUP_LABELS,
    intake: {
      enabled: true,
      optInLabel: "factory:auto",
      readyLabel: "readiness:ready",
      blockedLabel: "readiness:blocked",
      pollMs: 300_000,
      defaultModel: "meta/muse-glimmer-30b",
      maxGoalChars: 12_000,
    },
    maxItemBytes: 16_384,
    repos: [{ repo: REPO, checkoutDir: dir, idPrefix: "demo" }],
    auditor: {
      budget: { admit: () => Promise.resolve({ admit: true as const, line: "admitted: test" }) },
      call: (providerId: string, request: ModelRequest): Promise<SingleCallResult> => {
        calls.push(request);
        const content = replies.shift();
        if (content === undefined) {
          return Promise.reject(new Error("no scripted reply left"));
        }
        return Promise.resolve({
          providerId,
          model: SPARK,
          content,
          inputTokens: 900,
          outputTokens: 80,
        });
      },
    },
    triage: {
      enabled: true,
      providerId: "meta-api",
      model: SPARK,
      maxAutoPerDay,
      maxTextChars: 300,
      denyPatterns: ["/home/"],
    },
    log,
    now: () => clock.now,
  };
  return { github, ctx, calls, events, clock, merged, persist };
}

test("an auto decision is imported by the next intake poll and never re-sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-triage-"));
  try {
    const reply = JSON.stringify({
      decision: "auto",
      scope: ["Reword the note in src/add.ts:2 so it no longer pings @octocat or links #12."],
      dod: ["src/add.ts:2 has no mention and no issue link", "bun run gates prints rc=0"],
      size: "S",
    });
    const fx = setup(dir, [reply], 3);
    const [filed] = await fx.merged(workItem("gh-demo-7", 7), "a".repeat(40), [
      low("src/add.ts:2", "The note pings @octocat"),
    ]);
    await fx.persist();
    if (filed === undefined) {
      throw new Error("no follow-up filed");
    }

    await runTriage(fx.ctx, () => false);
    const appendix = [
      "",
      "## Scope",
      "",
      "1. `Reword the note in src/add.ts:2 so it no longer pings @octocat or links #12.`",
      "",
      "## DoD",
      "",
      "- D1: `src/add.ts:2 has no mention and no issue link`",
      "- D2: `bun run gates prints rc=0`",
      "",
      "## Dependencies",
      "",
      "None.",
      "",
      "## Size",
      "",
      "S",
      "",
    ].join("\n");
    const issue = fx.github.snapshot().issues.find((row) => row.number === filed.posted);
    expect(issue?.body).toBe(`${filed.body}${appendix}`);
    expect(issue?.labels).toEqual(["factory:followup", ...READY]);
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]?.messages[0]?.content).toContain(JSON.stringify("The note pings @octocat"));
    const ledger = await readLedger("test", fx.ctx.ledgerPath);
    expect(
      ledger.pending.map((entry) => [entry.kind, entry.workItemId, entry.tokens[0]?.source]),
    ).toEqual([["audit", "gh-demo-7", "auditor-usage"]]);
    expect(fx.events).toEqual([`triage:auto:${REPO}#${String(filed.posted)}`]);

    await runTriage(fx.ctx, () => false);
    expect(fx.calls).toHaveLength(1);

    // The stub files issues as author association NONE.
    const imported = await runIntake(
      {
        github: fx.github,
        storePath: fx.ctx.storePath,
        repos: fx.ctx.repos,
        intake: fx.ctx.intake,
        trustedAssociations: ["NONE"],
        maxItemBytes: fx.ctx.maxItemBytes,
        log: fx.ctx.log,
        now: fx.ctx.now,
      },
      createIntakeState(),
    );
    const id = `gh-demo-${String(filed.posted)}`;
    expect(imported).toEqual([id]);
    const item = (await readWorkStore(fx.ctx.storePath)).items.find((entry) => entry.id === id);
    expect(item?.dod).toEqual([
      { id: "D1", text: "`src/add.ts:2 has no mention and no issue link`", done: false },
      { id: "D2", text: "`bun run gates prints rc=0`", done: false },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the daily cap, the chain guard and a hold send each follow-up to the model at most once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-triage-"));
  try {
    const auto = JSON.stringify({
      decision: "auto",
      scope: ["Declare the return type of add in src/add.ts."],
      dod: ["add in src/add.ts declares number as its return type"],
      size: "S",
    });
    const hold = JSON.stringify({ decision: "hold", reason: "The fix needs an API choice." });
    const fx = setup(dir, [auto, hold], 1);
    const [first, second] = await fx.merged(workItem("gh-demo-7", 7), "a".repeat(40), [
      low("src/add.ts:2", "The return type is implicit"),
      low("src/add.ts:3", "The error is swallowed"),
    ]);
    if (first === undefined || second === undefined) {
      throw new Error("no follow-ups filed");
    }
    // The item imported from the first follow-up merged with a low finding.
    const [chained] = await fx.merged(
      workItem(`gh-demo-${String(first.posted)}`, first.posted),
      "b".repeat(40),
      [low("src/add.ts:4", "The name is unclear")],
    );
    await fx.persist();
    if (chained === undefined) {
      throw new Error("no chained follow-up filed");
    }
    const at = (number: number): string => `${REPO}#${String(number)}`;

    await runTriage(fx.ctx, () => false);
    expect(fx.calls).toHaveLength(1);
    expect(fx.events).toEqual([
      `triage:auto:${at(first.posted)}`,
      `triage-pending:capped:${at(second.posted)}`,
      `triage:hold-chain:${at(chained.posted)}`,
    ]);

    fx.clock.now = new Date("2026-11-02T00:01:00.000Z");
    await runTriage(fx.ctx, () => false);
    await runTriage(fx.ctx, () => false);
    expect(fx.calls).toHaveLength(2);
    expect(fx.events.slice(3)).toEqual([`triage:hold-model:${at(second.posted)}`]);
    const snapshot = fx.github.snapshot();
    const commentsOf = (number: number): string[] =>
      snapshot.comments.filter((row) => row.number === number).map((row) => row.body);
    expect(commentsOf(first.posted)).toEqual([]);
    expect(commentsOf(second.posted)).toEqual([
      [
        triageMarker(second.key),
        "Factory triage: hold (hold-model). The triage model gave this reason: `The fix needs an API choice.`",
        "",
        "The factory does not take this issue until a person adds `## Scope` and `## DoD` and sets the `factory:auto` and `readiness:ready` labels.",
        "",
      ].join("\n"),
    ]);
    expect(commentsOf(chained.posted)).toHaveLength(1);
    expect(commentsOf(chained.posted)[0]).toContain(
      `Its source work item gh-demo-${String(first.posted)} came from follow-up #${String(first.posted)}`,
    );
    for (const number of [second.posted, chained.posted]) {
      expect(snapshot.issues.find((row) => row.number === number)?.labels).toEqual(FOLLOWUP_LABELS);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Follow-ups (#17 D4, O7): the low findings of a merged verdict become
// issues that reference the verdict SHA. A GitHub error keeps the filing
// pending, a replay after a crash adopts the issue instead of filing it
// twice, and finding text with backticks and a mention stays fenced.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditVerdict, WorkItem } from "../../contracts/v1/types.js";
import { writeVerdict } from "../../src/auditor/store.js";
import { canonicalJson, sha256Hex } from "../../src/work/canonical.js";
import { fileFindingFollowups } from "../../src/loop/followups.js";
import { GitHubError } from "../../src/loop/github.js";
import type { LoopLog } from "../../src/loop/log.js";
import type { ParkContext } from "../../src/loop/park.js";
import { initialLoopItem } from "../../src/loop/start.js";
import { readLoopState } from "../../src/loop/state.js";
import { createStubGitHub } from "../../src/loop/stub/github.js";
import type { LoopItem } from "../../src/loop/types.js";

const REPO = "example/demo";
const HEAD = "64a00ad46e5f7a5ecaa3f18a6e39b9886ad8b46b";
const LABELS = ["factory:followup", "readiness:design-needed"];
const NOTE = "Uses ``` fences and pings @octocat in a note";

const ITEM: WorkItem = {
  schemaVersion: "v1",
  id: "gh-demo-1",
  repo: REPO,
  title: "Add two numbers",
  goal: "Sum two numbers",
  issue: 7,
  dod: [{ id: "D1", text: "add returns the sum", done: true }],
  dependencies: [],
  status: "done",
  statusReason: null,
  assignedHostAlias: null,
  branch: "moc/gh-demo-1",
  pullNumber: 1,
  modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 1, fallbackUsed: false },
  retryCount: 0,
  stallRounds: 0,
};

// The A8-4 stored verdict with two low findings at HEAD for pull 1.
const VERDICT: AuditVerdict = {
  schemaVersion: "v1",
  repo: REPO,
  workItemId: "gh-demo-1",
  pullNumber: 1,
  headSha: HEAD,
  authorModels: ["meta/muse-glimmer-30b"],
  auditorModel: "muse-spark-1.3-contributor",
  counts: { high: 0, medium: 0, low: 2 },
  findings: [
    {
      severity: "low",
      location: "src/add.ts:2",
      defect: NOTE,
      scenario: "a reader of the note",
      fixDirection: "reword the note",
    },
    {
      severity: "low",
      location: "src/add.ts:3",
      defect: "the return type is implicit",
      scenario: "a later refactor",
      fixDirection: "declare number",
    },
  ],
};

function keyOf(location: string, defect: string): string {
  return sha256Hex(canonicalJson({ repo: REPO, headSha: HEAD, location, defect })).slice(0, 16);
}

async function writeState(path: string, li: LoopItem): Promise<void> {
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

test("low findings of the merged verdict become issues once (D4, O7)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-followups-"));
  try {
    const verdictDir = join(dir, "verdicts");
    mkdirSync(verdictDir);
    await writeVerdict(verdictDir, VERDICT);
    const statePath = join(dir, "loop-state.json");
    await writeState(statePath, {
      ...initialLoopItem(),
      phase: "finalizing",
      pull: { number: 1, headSha: HEAD },
      finalize: { result: "success", done: true },
    });
    const stub = createStubGitHub({
      repo: REPO,
      originDir: join(dir, "origin.git"),
      baseBranch: "main",
      factoryLogin: "moc-factory",
      git: { PATH: process.env.PATH ?? "", timeoutMs: 30_000 },
      scratchDir: join(dir, "scratch"),
      ci: () => "success",
    });
    let failCreate = true;
    const github: typeof stub = {
      ...stub,
      createIssue: (repo, title, body, labels) => {
        if (failCreate) {
          failCreate = false;
          return Promise.reject(new GitHubError("unavailable", "createIssue", "createIssue: down"));
        }
        return stub.createIssue(repo, title, body, labels);
      },
    };
    const events: string[] = [];
    const log: LoopLog = {
      log(event): void {
        events.push(`${event.event}:${event.code ?? ""}:${event.detail ?? ""}`);
      },
      failed: () => false,
      close: () => Promise.resolve(),
    };
    const ctx: ParkContext = {
      branchPrefix: "moc/",
      statePath,
      resultsPath: join(dir, "loop-results.jsonl"),
      storePath: join(dir, "work-items.json"),
      stall: { maxStagnantRounds: 3, maxRetries: 2 },
      log,
      now: () => new Date("2026-10-29T10:00:00.000Z"),
      github,
      factoryLogin: "moc-factory",
      ledgerPath: join(dir, "ledger.jsonl"),
      escalationLabel: "factory:escalation",
      readyLabel: "readiness:ready",
      blockedLabel: "readiness:blocked",
      maxRetries: 2,
      followupLabels: LABELS,
      verdictDir,
    };
    const readItem = async (): Promise<LoopItem> =>
      (await readLoopState(statePath)).items["gh-demo-1"] as unknown as LoopItem;
    const first = keyOf("src/add.ts:2", NOTE);
    const second = keyOf("src/add.ts:3", "the return type is implicit");

    expect(await fileFindingFollowups(ctx, ITEM)).toBe("pending");
    expect(events).toEqual(["github-error:unavailable:createIssue"]);
    expect((await readItem()).followups).toEqual([{ key: first, kind: "finding", posted: null }]);
    expect(stub.snapshot().issues).toHaveLength(0);

    expect(await fileFindingFollowups(ctx, ITEM)).toBe("done");
    const issues = stub.snapshot().issues;
    expect(issues.map((issue) => issue.number)).toEqual([1, 2]);
    expect(issues.map((issue) => issue.title)).toEqual([
      "Follow-up (gh-demo-1): src/add.ts:2",
      "Follow-up (gh-demo-1): src/add.ts:3",
    ]);
    expect(issues.map((issue) => issue.body.split("\n")[0])).toEqual([
      `<!-- moc:followup:${first} -->`,
      `<!-- moc:followup:${second} -->`,
    ]);
    for (const issue of issues) {
      expect(issue.labels).toEqual(LABELS);
      expect(issue.body).toContain(
        `From the audit of ${REPO}#1 at ${HEAD} by muse-spark-1.3-contributor, severity low.`,
      );
      expect(issue.body.endsWith("\nRefs #7\n")).toBe(true);
      expect(issue.body.replace(/(`{3,})\n[\s\S]*?\n\1/g, "")).not.toContain("@");
    }
    expect(issues[0]?.body).toContain(`Defect:\n\`\`\`\`\n${NOTE}\n\`\`\`\`\n`);
    const filed = (await readItem()).followups;
    expect(filed).toEqual([
      { key: first, kind: "finding", posted: 1 },
      { key: second, kind: "finding", posted: 2 },
    ]);

    const li = await readItem();
    await writeState(statePath, {
      ...li,
      followups: li.followups.map((entry) =>
        entry.key === second ? { ...entry, posted: null } : entry,
      ),
    });
    expect(await fileFindingFollowups(ctx, ITEM)).toBe("done");
    expect(stub.snapshot().issues).toHaveLength(2);
    expect((await readItem()).followups).toEqual(filed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

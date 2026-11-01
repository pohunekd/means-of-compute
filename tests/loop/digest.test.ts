// Daily digest (O9): a new UTC day writes the previous day's digest once,
// with the merge, the running and parked items, the day's triage counts and
// the priced spend; a replay after a crash before the state write keeps the
// first bytes.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../../contracts/v1/types.js";
import { runDigest, type DigestContext } from "../../src/loop/digest.js";
import type { LoopLog } from "../../src/loop/log.js";
import { initialLoopItem } from "../../src/loop/start.js";
import { readLoopState } from "../../src/loop/state.js";
import type { LoopItem } from "../../src/loop/types.js";

const HEAD = "64a00ad46e5f7a5ecaa3f18a6e39b9886ad8b46b";
const SPARK = "muse-spark-1.3-contributor";

function item(id: string, overrides: Partial<WorkItem>): WorkItem {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo",
    title: `Item ${id}`,
    goal: "Goal text that never reaches the digest",
    issue: null,
    dod: [{ id: "D1", text: "done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: SPARK, attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
    ...overrides,
  };
}

// One usage record on meta-api (input $0.10, output $0.20 per 1M tokens).
function usage(workItemId: string, finishedAt: string, input: number, output: number): string {
  return JSON.stringify({
    schemaVersion: "v1",
    workItemId,
    finishedAt,
    tokens: [
      {
        provider: "meta-api",
        model: SPARK,
        inputTokens: input,
        outputTokens: output,
        requests: 1,
        source: "provider-usage",
      },
    ],
    sessionSeconds: [{ hostAlias: "host-a", seconds: 5, source: "dispatcher-clock" }],
    attempts: [{ model: SPARK, result: "success" }],
    retries: 0,
    humanInterventions: 0,
    result: "success",
  });
}

// A metered record with one billed call that reported no usage: it counts
// at the configured per-call bound.
function boundedUsage(workItemId: string, finishedAt: string): string {
  return JSON.stringify({
    schemaVersion: "v1",
    workItemId,
    finishedAt,
    tokens: [
      {
        provider: "meta-api",
        model: SPARK,
        inputTokens: 1_000_000,
        outputTokens: 0,
        requests: 2,
        unmeasuredRequests: 1,
        source: "meter-proxy",
      },
    ],
    sessionSeconds: [{ hostAlias: "host-a", seconds: 5, source: "dispatcher-clock" }],
    attempts: [{ model: SPARK, result: "success" }],
    retries: 0,
    humanInterventions: 0,
    result: "success",
  });
}

async function writeState(
  path: string,
  items: Record<string, LoopItem>,
  day: string,
): Promise<void> {
  await Bun.write(
    path,
    `${JSON.stringify({
      schemaVersion: "v1",
      revision: 0,
      items,
      resolvedApprovals: [],
      mergeHold: null,
      lastDigestDay: day,
    })}\n`,
  );
}

test("a new day writes the previous day's digest once (O9)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-digest-"));
  try {
    const digestDir = join(dir, "digest");
    mkdirSync(digestDir);
    const merged: LoopItem = {
      ...initialLoopItem(),
      phase: "final",
      round: 1,
      pull: { number: 1, headSha: HEAD },
      finalize: { result: "success", done: true },
      rounds: [
        {
          round: 0,
          retry: 0,
          requestId: "gh-demo-1:0",
          model: SPARK,
          providerId: "meta-api",
          hostAlias: "host-a",
          attempt: "success",
          outcome: "merged",
          headSha: HEAD,
          failingChecks: [],
          verdict: { auditorModel: "meta/muse-glimmer-30b", high: 0, medium: 0, low: 0 },
          newlyMet: ["D1"],
          at: "2026-10-28T12:00:00.000Z",
          baseRace: false,
        },
      ],
      followups: [
        {
          key: "0123456789abcdef",
          kind: "finding",
          posted: 9,
          triage: {
            decision: "hold",
            code: "hold-model",
            at: "2026-10-28T00:05:00.000Z",
            appendix: null,
            comment: "<!-- moc:triage:0123456789abcdef -->",
            done: true,
          },
        },
      ],
    };
    const running: LoopItem = {
      ...initialLoopItem(),
      phase: "running",
      requestId: "gh-demo-2:0",
      session: { hostAlias: "host-b", providerId: "meta-api", model: SPARK },
    };
    const statePath = join(dir, "loop-state.json");
    await writeState(statePath, { "gh-demo-1": merged, "gh-demo-2": running }, "2026-10-28");
    const storePath = join(dir, "work-items.json");
    await Bun.write(
      storePath,
      `${JSON.stringify({
        schemaVersion: "v1",
        revision: 0,
        items: [
          item("gh-demo-1", { status: "done", branch: "moc/gh-demo-1", pullNumber: 1 }),
          item("gh-demo-2", { status: "running", assignedHostAlias: "host-b" }),
          item("gh-demo-3", {
            status: "parked",
            statusReason: "stalled: 3 rounds without a newly met DoD item",
          }),
        ],
        submissions: [],
      })}\n`,
    );
    const resultsPath = join(dir, "loop-results.jsonl");
    await Bun.write(
      resultsPath,
      `${JSON.stringify({
        schemaVersion: "v1",
        key: "gh-demo-1:0",
        at: "2026-10-28T12:00:00.000Z",
        workItemId: "gh-demo-1",
        repo: "example/demo",
        round: 0,
        retry: 0,
        model: SPARK,
        providerId: "meta-api",
        hostAlias: "host-a",
        outcome: "merged",
        routingResult: "success",
      })}\n`,
    );
    const ledgerPath = join(dir, "ledger.jsonl");
    await Bun.write(
      ledgerPath,
      `${usage("gh-demo-1", "2026-10-28T09:00:00.000Z", 1_000_000, 500_000)}\n${boundedUsage("gh-demo-9", "2026-10-27T09:00:00.000Z")}\n`,
    );
    const events: string[] = [];
    const log: LoopLog = {
      log(event): void {
        events.push(`${event.event}:${event.detail ?? ""}`);
      },
      failed: () => false,
      close: () => Promise.resolve(),
    };
    const ctx: DigestContext = {
      statePath,
      storePath,
      resultsPath,
      ledgerPath,
      digestDir,
      providersDir: "config/providers",
      nvidiaProviderId: "nvidia-build",
      spendBounds: {
        auditCall: { inputTokens: 262144, outputTokens: 65536 },
        meterCall: { inputTokens: 16777216, outputTokens: 65536 },
      },
      log,
      now: () => new Date("2026-10-29T08:00:00.000Z"),
    };
    const expected = [
      "# Factory digest 2026-10-28 (UTC)",
      "",
      "## Merged",
      "",
      `- gh-demo-1: PR #1, head ${HEAD.slice(0, 12)}, model ${SPARK}`,
      "",
      "## Running",
      "",
      "- gh-demo-2: running, phase running, round 0",
      "",
      "## Parked and blocked",
      "",
      "- gh-demo-3: stalled: 3 rounds without a newly met DoD item",
      "",
      "## Follow-up triage",
      "",
      "- auto 0, hold 1, skip 0",
      "",
      "## Spend",
      "",
      "- Day: $0.2000",
      "- Total: $1.9908 (upper bound for unmeasured calls of 1 items)",
      "",
    ].join("\n");

    await runDigest(ctx);
    const target = join(digestDir, "2026-10-28.md");
    expect(readFileSync(target, "utf8")).toBe(expected);
    expect(events).toEqual(["digest-written:2026-10-28"]);
    expect((await readLoopState(statePath)).lastDigestDay).toBe("2026-10-29");

    const state = await readLoopState(statePath);
    await writeState(statePath, state.items as unknown as Record<string, LoopItem>, "2026-10-28");
    await Bun.write(ledgerPath, "");
    await runDigest(ctx);
    expect(readFileSync(target, "utf8")).toBe(expected);
    expect(events).toEqual(["digest-written:2026-10-28"]);
    expect((await readLoopState(statePath)).lastDigestDay).toBe("2026-10-29");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

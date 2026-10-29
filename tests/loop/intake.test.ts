// Intake smoke (W2 with A8): one ready, trusted issue with a closed
// dependency becomes a queued work item; an untrusted author and an open
// dependency are skipped with their codes, and a later poll adds nothing.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkStore } from "../../src/work/store.js";
import { createIntakeState, runIntake, type IntakeContext } from "../../src/loop/intake.js";
import type { LoopLog } from "../../src/loop/log.js";
import { createStubGitHub } from "../../src/loop/stub/github.js";

const REPO = "example/demo";
const READY = ["factory:auto", "readiness:ready"];

test("a ready trusted issue becomes a queued item once (W2, A8)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-intake-"));
  try {
    const github = createStubGitHub({
      repo: REPO,
      originDir: join(dir, "origin.git"),
      baseBranch: "main",
      factoryLogin: "moc-factory",
      git: { PATH: process.env.PATH ?? "", timeoutMs: 30_000 },
      scratchDir: join(dir, "scratch"),
      ci: () => "success",
    });
    const seed = { labels: READY, authorAssociation: "MEMBER", state: "open" } as const;
    github.seedIssue({ ...seed, title: "Old work", body: "Done.", labels: [], state: "closed" });
    github.seedIssue({ ...seed, title: "Open work", body: "Pending.", labels: [] });
    const body =
      "Build the widget.\n\n## DoD\n- D1: The widget renders.\n- D2: The widget has a test.\n\n## Dependencies\n- #1\n";
    github.seedIssue({ ...seed, title: "Add the widget", body });
    github.seedIssue({ ...seed, title: "Untrusted", body, authorAssociation: "NONE" });
    github.seedIssue({
      ...seed,
      title: "Blocked",
      body: "Wait.\n\n## DoD\n- D1: Waits.\n\n## Dependencies\n- #2\n",
    });
    const storePath = join(dir, "work-items.json");
    await Bun.write(
      storePath,
      `${JSON.stringify({ schemaVersion: "v1", revision: 0, items: [], submissions: [] })}\n`,
    );
    const events: string[] = [];
    const log: LoopLog = {
      log(event): void {
        events.push(
          `${event.event}:${event.code ?? ""}:${event.workItemId ?? ""}:${event.detail ?? ""}`,
        );
      },
      failed: () => false,
      close: () => Promise.resolve(),
    };
    let now = Date.parse("2026-10-29T10:00:00.000Z");
    const ctx: IntakeContext = {
      github,
      storePath,
      repos: [{ repo: REPO, checkoutDir: dir, idPrefix: "moc" }],
      intake: {
        enabled: true,
        optInLabel: "factory:auto",
        readyLabel: "readiness:ready",
        blockedLabel: "readiness:blocked",
        pollMs: 300_000,
        defaultModel: "meta/muse-glimmer-30b",
        maxGoalChars: 12_000,
      },
      trustedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
      maxItemBytes: 16_384,
      log,
      now: () => new Date(now),
    };
    const state = createIntakeState();
    expect(await runIntake(ctx, state)).toEqual(["gh-moc-3"]);
    expect(events).toEqual([
      "intake-skip:open-dependency::example/demo#5",
      "intake-skip:untrusted-author::example/demo#4",
      "intake-import::gh-moc-3:example/demo#3",
    ]);
    expect((await readWorkStore(storePath)).items).toEqual([
      {
        schemaVersion: "v1",
        id: "gh-moc-3",
        repo: REPO,
        title: "Add the widget",
        goal: body,
        issue: 3,
        dod: [
          { id: "D1", text: "The widget renders.", done: false },
          { id: "D2", text: "The widget has a test.", done: false },
        ],
        dependencies: [],
        status: "queued",
        statusReason: null,
        assignedHostAlias: null,
        branch: null,
        pullNumber: null,
        modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
        retryCount: 0,
        stallRounds: 0,
      },
    ]);
    expect(await runIntake(ctx, state)).toEqual([]);
    expect(events).toHaveLength(3);
    now += 300_000;
    expect(await runIntake(ctx, state)).toEqual([]);
    expect((await readWorkStore(storePath)).items).toHaveLength(1);
    expect(events.filter((line) => line.startsWith("intake-import:"))).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

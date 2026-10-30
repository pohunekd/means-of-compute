import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createSubmitWorkTool } from "../../src/mcp/submit.js";
import { place } from "../../src/placement/place.js";
import { loadPlacementConfig } from "../../src/placement/config.js";
import { isPlacementDecision, isAuditVerdict } from "../../contracts/v1/validate.js";
import type { HostCapacity } from "../../contracts/v1/types.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { BudgetGate } from "../../src/budget/gate.js";
import { readLedger, authorModelsOf } from "../../src/ledger/read.js";
import { runAudit } from "../../src/auditor/audit.js";
import { createReadOnlyGit } from "../../src/auditor/git.js";
import { loadAuditorConfig } from "../../src/auditor/config.js";
import { makeTempRepo } from "../auditor/temp-repo.js";
import { applyTestEnv } from "../auditor/test-env.js";
import { startLoopback } from "../../src/providers/loopback.js";
import { resetProvidersCache } from "../../src/providers/config.js";
import { callProviderOnce } from "../../src/providers/router.js";
import { verdictCheck, markerMatches, mergeStep } from "../../src/loop/merge-rule.js";
import { parseMarkerLine } from "../../src/auditor/verdict.js";

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

const nowFn = () => new Date("2026-10-30T10:00:00.000Z");

const item = {
  schemaVersion: "v1" as const,
  id: "smoke-1",
  repo: "example/demo-repo",
  title: "Smoke test item",
  goal: "Smoke critical path",
  issue: null,
  dod: [{ id: "D1", text: "D1", done: false }],
  dependencies: [],
  status: "queued" as const,
  statusReason: null,
  assignedHostAlias: null,
  branch: null,
  pullNumber: null,
  modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
  retryCount: 0,
  stallRounds: 0,
};

function configOf(registryPath: string) {
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

test("smoke: idle host, clean audit, merge rule ready", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "smoke-"));
  let loopback: { port: number; stop: () => void } | null = null;
  let restoreEnv: (() => void) | null = null;
  try {
    // temp work config
    const workConfigPath = join(tmpDir, "work.json");
    const workJson = await Bun.file("tests/fixtures/mcp/demo/work.json").text();
    const workObj = JSON.parse(workJson) as Record<string, unknown>;
    workObj.storePath = join(tmpDir, "work-store.json");
    await Bun.write(workConfigPath, JSON.stringify(workObj));

    // 1. submit_work
    const submitTool = createSubmitWorkTool({
      workConfigPath,
      dispatcherConfigPath: "tests/fixtures/mcp/demo/dispatcher.json",
      auditorConfigPath: "tests/fixtures/mcp/demo/auditor.json",
      approvalsConfigPath: "tests/fixtures/mcp/demo/approvals.json",
    });
    const submitOutcome = await submitTool.run({ items: [item] }, { caller: "smoke", now: nowFn });
    const payload = submitOutcome.payload as {
      ok: boolean;
      itemIds?: readonly string[];
      replayed?: boolean;
    };
    expect(payload.ok).toBe(true);
    expect(payload.itemIds).toEqual(["smoke-1"]);
    expect(payload.replayed).toBe(false);

    // placement
    const placementConfig = await loadPlacementConfig("config/placement.json");
    const idleHost = JSON.parse(
      await Bun.file("contracts/v1/fixtures/host-capacity.json").text(),
    ) as HostCapacity;
    const busyHost = JSON.parse(
      await Bun.file("contracts/v1/fixtures/host-capacity-busy.json").text(),
    ) as HostCapacity;
    const decision = place(item, [idleHost, busyHost], [], placementConfig);
    expect(isPlacementDecision(decision)).toBe(true);
    expect(decision.chosenHostAlias).toBe("desktop");
    expect(decision.reason.startsWith("desktop is ")).toBe(true);
    expect(decision.reason.endsWith(" inside its policy window, 0/2 agents running")).toBe(true);
    const laptopCandidate = decision.candidates.find((c) => c.hostAlias === "laptop-a");
    expect(laptopCandidate?.excluded).toBe(true);
    expect(laptopCandidate?.reason).toBe("excluded: not idle (user input 40 seconds ago)");

    // dispatcher
    const ledgerPath = join(tmpDir, "ledger.jsonl");
    const registryPath = join(tmpDir, "registry.json");
    const control = createMemoryPort();
    const dispatcher = createDispatcher({
      port: control.port,
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: nowFn,
      sleep: () => Promise.resolve(),
      log: () => {},
      settleUsage: () => Promise.resolve(null),
    });
    const startResult = await dispatcher.start(
      item,
      decision,
      { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" },
      "Smoke brief.",
    );
    expect(startResult.kind).toBe("started");
    if (startResult.kind !== "started") throw new Error("not started");
    expect(startResult.handle.hostAlias).toBe("desktop");
    control.complete(startResult.handle.sessionId, {
      state: "finished",
      usage: null,
      detail: "exited 0",
    });
    const watchResult = await dispatcher.watch(startResult.request.requestId);
    expect(watchResult.result.state).toBe("finished");
    expect(watchResult.attempt).toBe("success");

    // ledger author models
    const contents = await readLedger("test", ledgerPath);
    const models = authorModelsOf(contents, "smoke-1");
    expect(models).toEqual(["meta/muse-glimmer-30b"]);

    // loopback for audit
    loopback = await startLoopback("tests/auditor/recordings/clean.json");
    restoreEnv = applyTestEnv();
    process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
    resetProvidersCache();

    const repo = await makeTempRepo();
    await mkdir(join(tmpDir, "verdicts"), { recursive: true });
    const auditorBase = await loadAuditorConfig("config/auditor.json");
    const auditorConfig = { ...auditorBase, verdictDir: join(tmpDir, "verdicts") };

    const auditInput = {
      item,
      repoDir: repo.dir,
      ref: "demo-good",
      baseRef: "main",
      pullNumber: 1,
      phaseCritical: false,
      authorModels: models,
    };
    const auditDeps = {
      config: auditorConfig,
      git: createReadOnlyGit(repo.dir),
      budget: GATE,
      call: callProviderOnce,
      ledgerPath,
      now: nowFn,
    };
    const auditOutcome = await runAudit(auditInput, auditDeps);
    expect(auditOutcome.kind).toBe("verdict");
    if (auditOutcome.kind !== "verdict") throw new Error("no verdict");
    const verdict = auditOutcome.verdict;
    expect(isAuditVerdict(verdict)).toBe(true);
    expect(verdict.headSha).toBe(repo.goodSha);
    expect(verdict.auditorModel).toBe("muse-spark-1.3-contributor");
    expect(verdict.counts).toEqual({ high: 0, medium: 0, low: 0 });

    const check = verdictCheck([verdict], 1, repo.goodSha, models);
    expect(check.kind).toBe("clean");

    if (typeof auditOutcome.comment !== "string") throw new Error("no comment");
    const markerLine = auditOutcome.comment.split("\n")[0] ?? "";
    const marker = parseMarkerLine(markerLine);
    if (!marker) throw new Error("marker parse failed");
    expect(markerMatches([marker], "example/demo-repo", 1, repo.goodSha, verdict)).toBe(true);

    const mergeResult = mergeStep({
      view: {
        state: "OPEN",
        headRefOid: repo.goodSha,
        baseRefName: "main",
        isDraft: false,
        mergeCommit: null,
      },
      headSha: repo.goodSha,
      baseBranch: "main",
      ci: "green",
      verdict: check,
      markerOk: true,
      mergeMode: "by-rule",
      approved: false,
    });
    expect(mergeResult).toEqual({ kind: "ready" });
  } finally {
    if (restoreEnv) restoreEnv();
    if (loopback) loopback.stop();
    // cleanup temp dir is OS managed
  }
}, 120_000);

test("smoke: only a busy host gets no placement", async () => {
  const placementConfig = await loadPlacementConfig("config/placement.json");
  const busyHost = JSON.parse(
    await Bun.file("contracts/v1/fixtures/host-capacity-busy.json").text(),
  ) as HostCapacity;
  const decision = place(item, [busyHost], [], placementConfig);
  expect(isPlacementDecision(decision)).toBe(true);
  expect(decision.chosenHostAlias).toBeNull();
  expect(decision.reason).toBe("no eligible host: 1 of 1 excluded");
  expect(decision.candidates.length).toBe(1);
  const candidate = decision.candidates[0];
  if (!candidate) throw new Error("missing candidate");
  expect(candidate.excluded).toBe(true);
}, 120_000);

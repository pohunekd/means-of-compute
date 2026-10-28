// Phase-critical merge audit tests (D1a, D1b, D2, M-W1 to M-W3): with
// the opt-in, [glimmer, spark] work is audited by Wonder; without it,
// the same authors refuse. Wonder spend reaches the ledger priced by the
// descriptor. Two loopbacks run (Wonder plus one shared general stub),
// so a stub request count proves which providers were reached.
// Mutations: selectAuditor in step 7; mergeAuditor appended to the
// general list; provider meta-api for the Wonder call; inputPer1M 0.4;
// selectMergeAuditor falling back; a dropped step 1 check; a retried
// ProviderError.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLoopback } from "../../src/providers/loopback.js";
import type { LoopbackRequest } from "../../src/providers/loopback.js";
import { runAudit, auditExitCode } from "../../src/auditor/audit.js";
import { AuditModelError } from "../../src/auditor/reply.js";
import type { AuditInput } from "../../src/auditor/audit-types.js";
import { loadAuditorConfig } from "../../src/auditor/config.js";
import { createReadOnlyGit } from "../../src/auditor/git.js";
import { callProviderOnce } from "../../src/providers/router.js";
import { costOfRecord } from "../../src/budget/cost.js";
import { loadPricingForIds } from "../../src/budget/pricing.js";
import { readLedger, spendEntriesOf } from "../../src/ledger/read.js";
import { PROVIDERS_DIR } from "../../src/providers/paths.js";
import { demoItem, makeTempRepo, removeTempRepo } from "./temp-repo.js";
import { admittingGate, applyTestEnv, refusingGate } from "./test-env.js";

const GLIMMER = "meta/muse-glimmer-30b";
const SPARK = "muse-spark-1.3-contributor";
const WONDER = "muse-wonder-1.0";

interface MergeSetup {
  readonly repoDir: string;
  readonly verdictDir: string;
  readonly ledgerPath: string;
  readonly cleanupFiles: () => void;
  readonly counting: typeof callProviderOnce;
  readonly requestCount: () => number;
}

async function setupMergeCase(prefix: string): Promise<MergeSetup> {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), prefix));
  const verdictDir = join(workdir, "verdicts");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  let requests = 0;
  const counting: typeof callProviderOnce = async (providerId, request) => {
    requests += 1;
    return callProviderOnce(providerId, request);
  };
  return {
    repoDir: repo.dir,
    verdictDir,
    ledgerPath,
    cleanupFiles: () => {
      removeTempRepo(repo.dir);
      rmSync(workdir, { recursive: true, force: true });
    },
    counting,
    requestCount: () => requests,
  };
}

interface MergeRun {
  readonly outcome: Awaited<ReturnType<typeof runAudit>> | { readonly error: unknown };
  readonly setup: MergeSetup;
  readonly wonderRequests: () => readonly LoopbackRequest[];
  readonly generalRequests: () => number;
  readonly cleanup: () => void;
}

async function runMergeCase(options: {
  readonly recording: string;
  readonly phaseCritical: boolean;
  readonly pullNumber: number | null;
  readonly authorModels: readonly string[];
  readonly gate: "admit" | "refuse";
}): Promise<MergeRun> {
  const setup = await setupMergeCase("auditor-merge-");
  const restoreEnv = applyTestEnv();
  const wonder = await startLoopback(options.recording);
  const general = await startLoopback("tests/auditor/recordings/clean.json");
  process.env.PROVIDER_META_WONDER_BASE_URL = `http://127.0.0.1:${String(wonder.port)}`;
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(general.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(general.port)}`;
  const cleanup = (): void => {
    void wonder.stop();
    void general.stop();
    restoreEnv();
    setup.cleanupFiles();
  };
  try {
    const config = await loadAuditorConfig();
    const gate =
      options.gate === "admit" ? admittingGate(process.cwd()) : refusingGate(process.cwd());
    let outcome: Awaited<ReturnType<typeof runAudit>> | { readonly error: unknown };
    try {
      outcome = await runAudit(
        {
          item: demoItem("demo-good") as unknown as AuditInput["item"],
          repoDir: setup.repoDir,
          ref: "demo-good",
          baseRef: "main",
          pullNumber: options.pullNumber,
          phaseCritical: options.phaseCritical,
          authorModels: [...options.authorModels],
        },
        {
          config: { ...config, verdictDir: setup.verdictDir },
          git: createReadOnlyGit(setup.repoDir),
          budget: gate,
          call: setup.counting,
          ledgerPath: setup.ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      outcome = { error };
    }
    return {
      outcome,
      setup,
      wonderRequests: () => wonder.requests(),
      generalRequests: () => general.requests().length,
      cleanup,
    };
  } catch (error: unknown) {
    cleanup();
    throw error;
  }
}

function expectRefused(
  outcome: Awaited<ReturnType<typeof runAudit>> | { readonly error: unknown },
): string {
  if (!("kind" in outcome) || outcome.kind !== "refused") {
    throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
  }
  return outcome.reason;
}

test("D1a: phase-critical [G, S] is audited by Wonder (mutation: selectAuditor in step 7)", async () => {
  const run = await runMergeCase({
    recording: "tests/auditor/recordings/wonder-clean.json",
    phaseCritical: true,
    pullNumber: 99,
    authorModels: [GLIMMER, SPARK],
    gate: "admit",
  });
  try {
    const { outcome } = run;
    if (!("kind" in outcome) || outcome.kind !== "verdict") {
      throw new Error(`expected a verdict, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.verdict.auditorModel).toBe(WONDER);
    expect(outcome.comment?.split("\n")[0]).toContain(`:auditor=${WONDER}:`);
    expect(run.wonderRequests()).toHaveLength(1);
    expect(run.generalRequests()).toBe(0);
    const body = JSON.parse(run.wonderRequests()[0]?.body ?? "{}") as { model?: unknown };
    expect(body.model).toBe(WONDER);
  } finally {
    run.cleanup();
  }
});

test("D1b: without the opt-in [G, S] refuses 3 (mutation: mergeAuditor appended to the general list)", async () => {
  const run = await runMergeCase({
    recording: "tests/auditor/recordings/wonder-clean.json",
    phaseCritical: false,
    pullNumber: 99,
    authorModels: [GLIMMER, SPARK],
    gate: "refuse",
  });
  try {
    // The refusing gate proves selection fired first: zero requests and
    // the selection reason, not the budget reason.
    const reason = expectRefused(run.outcome);
    expect(reason).toBe("no eligible auditor: every configured auditor model authored w9-demo");
    expect(run.wonderRequests()).toHaveLength(0);
    expect(run.generalRequests()).toBe(0);
  } finally {
    run.cleanup();
  }
});

test("D2: Wonder spend is ledgered and priced by the descriptor (mutation: provider meta-api)", async () => {
  const run = await runMergeCase({
    recording: "tests/auditor/recordings/wonder-clean.json",
    phaseCritical: true,
    pullNumber: 99,
    authorModels: [GLIMMER, SPARK],
    gate: "admit",
  });
  try {
    const { outcome } = run;
    if (!("kind" in outcome) || outcome.kind !== "verdict") {
      throw new Error(`expected a verdict, got ${JSON.stringify(outcome)}`);
    }
    const contents = await readLedger("Audit ledger", run.setup.ledgerPath);
    const pending = contents.pending.filter((entry) => entry.kind === "audit");
    expect(pending).toHaveLength(1);
    const entry = pending[0];
    if (entry === undefined) {
      throw new Error("expected one pending audit entry");
    }
    expect(entry.kind).toBe("audit");
    expect(entry.startModel).toBe(WONDER);
    expect(entry.tokens).toEqual([
      {
        provider: "meta-wonder",
        model: WONDER,
        inputTokens: 50000,
        outputTokens: 8000,
        requests: 1,
        source: "auditor-usage",
      },
    ]);
    // 0.05 M x $4 plus 0.008 M x $20: the exact worked number in 4.
    const pricing = await loadPricingForIds(PROVIDERS_DIR, ["meta-wonder"]);
    expect(costOfRecord(spendEntriesOf(contents)[0] as never, pricing)).toBe(360000000n);
  } finally {
    run.cleanup();
  }
});

test("M-W1: Wonder among the authors refuses 3 with no fallback (mutation: fall back to selectAuditor)", async () => {
  const run = await runMergeCase({
    recording: "tests/auditor/recordings/wonder-clean.json",
    phaseCritical: true,
    pullNumber: 99,
    authorModels: [GLIMMER, WONDER],
    gate: "admit",
  });
  try {
    const reason = expectRefused(run.outcome);
    expect(reason).toBe(`no eligible auditor: merge auditor ${WONDER} authored w9-demo`);
    expect(run.wonderRequests()).toHaveLength(0);
    expect(run.generalRequests()).toBe(0);
  } finally {
    run.cleanup();
  }
});

test("M-W2: phase-critical without a pull number is exit 2 (mutation: drop the step 1 check)", async () => {
  const run = await runMergeCase({
    recording: "tests/auditor/recordings/wonder-clean.json",
    phaseCritical: true,
    pullNumber: null,
    authorModels: [GLIMMER],
    gate: "admit",
  });
  try {
    const { outcome } = run;
    if (!("error" in outcome)) {
      throw new Error(`expected a throw, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toBe("phase-critical audit needs a pull request");
    expect(auditExitCode(outcome.error)).toBe(2);
    expect(run.wonderRequests()).toHaveLength(0);
    expect(run.generalRequests()).toBe(0);
  } finally {
    run.cleanup();
  }
});

test("M-W3: a Wonder 429 is exit 4 with no fallback and no ledger entry (mutation: retry with callWithFallback)", async () => {
  const run = await runMergeCase({
    recording: "tests/auditor/recordings/wonder-429.json",
    phaseCritical: true,
    pullNumber: 99,
    authorModels: [GLIMMER],
    gate: "admit",
  });
  try {
    const { outcome } = run;
    if (!("error" in outcome)) {
      throw new Error(`expected a throw, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.error).toBeInstanceOf(AuditModelError);
    expect(auditExitCode(outcome.error)).toBe(4);
    expect(run.wonderRequests()).toHaveLength(1);
    expect(run.generalRequests()).toBe(0);
    const contents = await readLedger("Audit ledger", run.setup.ledgerPath);
    expect(contents.pending.filter((entry) => entry.kind === "audit")).toHaveLength(0);
  } finally {
    run.cleanup();
  }
});

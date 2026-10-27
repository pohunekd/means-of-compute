// Guard tests (L1, L2, L4): the empty-author and refused-budget rules
// stop the run before any model call; an item without DoD fails
// isWorkItem with exit 2 in the library as in the CLI; an unknown
// 40-hex sha fails in rev-parse with its message. Env keys are restored
// in finally and the budget gate is a stub (L3).
// Mutations: authors.length < 0; false && !admission.admit.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLoopback } from "../../src/providers/loopback.js";
import { runAudit, auditExitCode } from "../../src/auditor/audit.js";
import type { AuditInput } from "../../src/auditor/audit-types.js";
import { loadAuditorConfig } from "../../src/auditor/config.js";
import { createReadOnlyGit } from "../../src/auditor/git.js";
import { callProviderOnce } from "../../src/providers/router.js";
import { demoItem, makeTempRepo, removeTempRepo } from "./temp-repo.js";
import { applyTestEnv, refusingGate } from "./test-env.js";

async function setupGuardCase(prefix: string): Promise<{
  readonly repoDir: string;
  readonly verdictDir: string;
  readonly ledgerPath: string;
  readonly cleanupFiles: () => void;
}> {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), prefix));
  const verdictDir = join(workdir, "verdicts");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  return {
    repoDir: repo.dir,
    verdictDir,
    ledgerPath,
    cleanupFiles: () => {
      removeTempRepo(repo.dir);
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

test("empty authorModels refuses 3 with zero model calls (mutation: authors.length < 0)", async () => {
  const setup = await setupGuardCase("auditor-noauthors-");
  const restoreEnv = applyTestEnv();
  const cleanup = (): void => {
    restoreEnv();
    setup.cleanupFiles();
  };
  let requests = 0;
  const counting: typeof callProviderOnce = async (providerId, request) => {
    requests += 1;
    return callProviderOnce(providerId, request);
  };
  try {
    const config = await loadAuditorConfig();
    const outcome = await runAudit(
      {
        item: demoItem("demo-good") as unknown as AuditInput["item"],
        repoDir: setup.repoDir,
        ref: "demo-good",
        baseRef: "main",
        pullNumber: 99,
        authorModels: [],
      },
      {
        config: { ...config, verdictDir: setup.verdictDir },
        git: createReadOnlyGit(setup.repoDir),
        budget: refusingGate(process.cwd()),
        call: counting,
        ledgerPath: setup.ledgerPath,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
      },
    );
    expect(outcome.kind).toBe("refused");
    expect(requests).toBe(0);
  } finally {
    cleanup();
  }
});

test("refused budget admits nothing and makes zero model calls (mutation: false && !admission.admit)", async () => {
  const setup = await setupGuardCase("auditor-refusedbudget-");
  const restoreEnv = applyTestEnv();
  const server = await startLoopback("tests/auditor/recordings/clean.json");
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  const cleanup = (): void => {
    void server.stop();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    restoreEnv();
    setup.cleanupFiles();
  };
  let requests = 0;
  const counting: typeof callProviderOnce = async (providerId, request) => {
    requests += 1;
    return callProviderOnce(providerId, request);
  };
  try {
    const config = await loadAuditorConfig();
    const outcome = await runAudit(
      {
        item: demoItem("demo-good") as unknown as AuditInput["item"],
        repoDir: setup.repoDir,
        ref: "demo-good",
        baseRef: "main",
        pullNumber: 99,
        authorModels: ["meta/muse-glimmer-30b"],
      },
      {
        config: { ...config, verdictDir: setup.verdictDir },
        git: createReadOnlyGit(setup.repoDir),
        budget: refusingGate(process.cwd()),
        call: counting,
        ledgerPath: setup.ledgerPath,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
      },
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("budget");
    }
    expect(requests).toBe(0);
  } finally {
    cleanup();
  }
});

test("L2: an item without DoD fails isWorkItem with exit 2", async () => {
  const setup = await setupGuardCase("auditor-nodod-lib-");
  const restoreEnv = applyTestEnv();
  const cleanup = (): void => {
    restoreEnv();
    setup.cleanupFiles();
  };
  try {
    const config = await loadAuditorConfig();
    const item = {
      ...(demoItem("demo-good") as unknown as AuditInput["item"]),
      dod: [],
    };
    let code = 0;
    try {
      await runAudit(
        {
          item,
          repoDir: setup.repoDir,
          ref: "demo-good",
          baseRef: "main",
          pullNumber: 99,
          authorModels: ["meta/muse-glimmer-30b"],
        },
        {
          config: { ...config, verdictDir: setup.verdictDir },
          git: createReadOnlyGit(setup.repoDir),
          budget: refusingGate(process.cwd()),
          call: callProviderOnce,
          ledgerPath: setup.ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      code = auditExitCode(error);
    }
    expect(code).toBe(2);
  } finally {
    cleanup();
  }
});

test("L4: an unknown 40-hex sha exits 2 with the rev-parse message", async () => {
  const setup = await setupGuardCase("auditor-unknownsha-");
  const restoreEnv = applyTestEnv();
  const cleanup = (): void => {
    restoreEnv();
    setup.cleanupFiles();
  };
  try {
    const config = await loadAuditorConfig();
    let code = 0;
    let message = "";
    try {
      await runAudit(
        {
          item: demoItem("demo-good") as unknown as AuditInput["item"],
          repoDir: setup.repoDir,
          ref: "0000000000000000000000000000000000000000",
          baseRef: "main",
          pullNumber: 99,
          authorModels: ["meta/muse-glimmer-30b"],
        },
        {
          config: { ...config, verdictDir: setup.verdictDir },
          git: createReadOnlyGit(setup.repoDir),
          budget: refusingGate(process.cwd()),
          call: callProviderOnce,
          ledgerPath: setup.ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      code = auditExitCode(error);
      message = error instanceof Error ? error.message : String(error);
    }
    expect(code).toBe(2);
    expect(message).toContain("cannot resolve 0000000000000000000000000000000000000000");
  } finally {
    cleanup();
  }
});

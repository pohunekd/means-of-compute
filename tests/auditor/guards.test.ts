// Guard tests (L1, L2, L4): the empty-author and refused-budget rules
// stop the run before any model call; an item without DoD fails
// isWorkItem with exit 2 in the library as in the CLI; an unknown
// 40-hex sha fails in rev-parse with its message.
// Mutations: authors.length < 0; false && !admission.admit.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLoopback } from "../../src/providers/loopback.js";
import { resetProvidersCache } from "../../src/providers/config.js";
import { createCliBudgetGate } from "../../src/budget/gate.js";
import { runAudit, auditExitCode } from "../../src/auditor/audit.js";
import type { AuditInput } from "../../src/auditor/audit-types.js";
import { loadAuditorConfig } from "../../src/auditor/config.js";
import { createReadOnlyGit } from "../../src/auditor/git.js";
import { callProviderOnce } from "../../src/providers/router.js";
import { demoItem, makeTempRepo, removeTempRepo } from "./temp-repo.js";

const AUDITOR_ENV = {
  NVIDIA_API_KEY: "test",
  META_API_KEY: "test",
  LOCAL_MODEL_BASE_URL: "http://localhost:1234/v1",
};

// A budget gate command that refuses like the real check: the refused
// line plus rc 3.
function refusingGate(): { command: string[]; timeoutMs: number } {
  return {
    command: [
      "bun",
      "-e",
      'console.log("refused: test refuse (today $0.00, total $0.00, nvidia requests today 0)"); process.exit(3);',
    ],
    timeoutMs: 30000,
  };
}

test("empty authorModels refuses 3 with zero model calls (mutation: authors.length < 0)", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-noauthors-"));
  const verdictDir = join(workdir, "verdicts");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  for (const [key, value] of Object.entries(AUDITOR_ENV)) {
    process.env[key] = value;
  }
  resetProvidersCache();
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
        repoDir: repo.dir,
        ref: "demo-good",
        baseRef: "main",
        pullNumber: 99,
        authorModels: [],
      },
      {
        config: { ...config, verdictDir },
        git: createReadOnlyGit(repo.dir),
        budget: createCliBudgetGate({ ...refusingGate(), cwd: process.cwd() }),
        call: counting,
        ledgerPath,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
      },
    );
    expect(outcome.kind).toBe("refused");
    expect(requests).toBe(0);
  } finally {
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("refused budget admits nothing and makes zero model calls (mutation: false && !admission.admit)", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-refusedbudget-"));
  const verdictDir = join(workdir, "verdicts");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  for (const [key, value] of Object.entries(AUDITOR_ENV)) {
    process.env[key] = value;
  }
  resetProvidersCache();
  let requests = 0;
  const counting: typeof callProviderOnce = async (providerId, request) => {
    requests += 1;
    return callProviderOnce(providerId, request);
  };
  const server = await startLoopback("tests/auditor/recordings/clean.json");
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  try {
    const config = await loadAuditorConfig();
    const outcome = await runAudit(
      {
        item: demoItem("demo-good") as unknown as AuditInput["item"],
        repoDir: repo.dir,
        ref: "demo-good",
        baseRef: "main",
        pullNumber: 99,
        authorModels: ["meta/muse-glimmer-30b"],
      },
      {
        config: { ...config, verdictDir },
        git: createReadOnlyGit(repo.dir),
        budget: createCliBudgetGate({ ...refusingGate(), cwd: process.cwd() }),
        call: counting,
        ledgerPath,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
      },
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("budget");
    }
    expect(requests).toBe(0);
  } finally {
    void server.stop();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("L2: an item without DoD fails isWorkItem with exit 2", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-nodod-lib-"));
  const verdictDir = join(workdir, "verdicts");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  for (const [key, value] of Object.entries(AUDITOR_ENV)) {
    process.env[key] = value;
  }
  resetProvidersCache();
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
          repoDir: repo.dir,
          ref: "demo-good",
          baseRef: "main",
          pullNumber: 99,
          authorModels: ["meta/muse-glimmer-30b"],
        },
        {
          config: { ...config, verdictDir },
          git: createReadOnlyGit(repo.dir),
          budget: createCliBudgetGate({ ...refusingGate(), cwd: process.cwd() }),
          call: callProviderOnce,
          ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      code = auditExitCode(error);
    }
    expect(code).toBe(2);
  } finally {
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("L4: an unknown 40-hex sha exits 2 with the rev-parse message", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-unknownsha-"));
  const verdictDir = join(workdir, "verdicts");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  for (const [key, value] of Object.entries(AUDITOR_ENV)) {
    process.env[key] = value;
  }
  resetProvidersCache();
  try {
    const config = await loadAuditorConfig();
    let code = 0;
    let message = "";
    try {
      await runAudit(
        {
          item: demoItem("demo-good") as unknown as AuditInput["item"],
          repoDir: repo.dir,
          ref: "0000000000000000000000000000000000000000",
          baseRef: "main",
          pullNumber: 99,
          authorModels: ["meta/muse-glimmer-30b"],
        },
        {
          config: { ...config, verdictDir },
          git: createReadOnlyGit(repo.dir),
          budget: createCliBudgetGate({ ...refusingGate(), cwd: process.cwd() }),
          call: callProviderOnce,
          ledgerPath,
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
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

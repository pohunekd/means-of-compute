// Audit run tests through the loopback stub and a temp git repo.
// D1 (clean) and D2 (defect) plus the same-sha, empty-reply and bad-location
// guards of the test matrix. Each test names the mutation that must fail it.
// Env keys are restored in finally and the budget gate is a stub, so no
// test touches the checkout's logs/ or leaks keys (L3).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLoopback } from "../../src/providers/loopback.js";
import { runAudit, auditExitCode } from "../../src/auditor/audit.js";
import type { AuditInput } from "../../src/auditor/audit-types.js";
import { loadAuditorConfig } from "../../src/auditor/config.js";
import { createReadOnlyGit } from "../../src/auditor/git.js";
import { callProviderOnce } from "../../src/providers/router.js";
import { isAuditVerdict } from "../../contracts/v1/validate.js";
import { demoItem, makeTempRepo, removeTempRepo } from "./temp-repo.js";
import { admittingGate, applyTestEnv } from "./test-env.js";

function loopbackEnv(port: number): void {
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(port)}`;
}

function clearLoopbackEnv(): void {
  delete process.env.PROVIDER_META_API_BASE_URL;
  delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
}

interface LibrarySetup {
  readonly repoDir: string;
  readonly verdictDir: string;
  readonly ledgerPath: string;
  readonly cleanupFiles: () => void;
  readonly counting: typeof callProviderOnce;
  readonly requestCount: () => number;
}

async function setupLibraryCase(prefix: string): Promise<LibrarySetup> {
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

async function runCase(
  branch: "demo-good" | "demo-bad",
  recording: string,
): Promise<{
  readonly outcome: Awaited<ReturnType<typeof runAudit>>;
  readonly verdictDir: string;
  readonly ledgerPath: string;
  readonly cleanup: () => void;
}> {
  const setup = await setupLibraryCase("auditor-run-");
  const restoreEnv = applyTestEnv();
  const server = await startLoopback(recording);
  loopbackEnv(server.port);
  const cleanup = (): void => {
    void server.stop();
    clearLoopbackEnv();
    restoreEnv();
    setup.cleanupFiles();
  };
  try {
    const config = await loadAuditorConfig();
    const outcome = await runAudit(
      {
        item: demoItem(branch) as unknown as AuditInput["item"],
        repoDir: setup.repoDir,
        ref: branch,
        baseRef: "main",
        pullNumber: 99,
        authorModels: ["meta/muse-glimmer-30b"],
      },
      {
        config: { ...config, verdictDir: setup.verdictDir },
        git: createReadOnlyGit(setup.repoDir),
        budget: admittingGate(process.cwd()),
        call: setup.counting,
        ledgerPath: setup.ledgerPath,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
      },
    );
    return { outcome, verdictDir: setup.verdictDir, ledgerPath: setup.ledgerPath, cleanup };
  } catch (error: unknown) {
    cleanup();
    throw error;
  }
}

test("clean branch gets a SHA-bound clean verdict (mutation: bind the marker to the ref name)", async () => {
  const { outcome, verdictDir, ledgerPath, cleanup } = await runCase(
    "demo-good",
    "tests/auditor/recordings/clean.json",
  );
  try {
    if (outcome.kind !== "verdict") {
      throw new Error(`expected a verdict, got refusal: ${outcome.reason}`);
    }
    expect(isAuditVerdict(outcome.verdict)).toBe(true);
    expect(outcome.verdict.counts).toEqual({ high: 0, medium: 0, low: 0 });
    const marker = outcome.comment?.split("\n")[0];
    expect(marker).toContain(outcome.verdict.headSha);
    expect(marker).toContain("high=0:medium=0");
    expect(marker).not.toContain("demo-good@");
    const stored: unknown = await Bun.file(
      join(verdictDir, "w9-demo", `${outcome.verdict.headSha}.json`),
    ).json();
    expect(isAuditVerdict(stored)).toBe(true);
    const ledger = await Bun.file(ledgerPath).text();
    expect(ledger).toContain('"kind":"audit"');
    expect(ledger).toContain('"source":"auditor-usage"');
  } finally {
    cleanup();
  }
});

test("defect branch gets a high finding with path:line evidence (mutation: take counts from the model)", async () => {
  const { outcome, cleanup } = await runCase("demo-bad", "tests/auditor/recordings/defect.json");
  try {
    if (outcome.kind !== "verdict") {
      throw new Error(`expected a verdict, got refusal: ${outcome.reason}`);
    }
    expect(outcome.verdict.counts.high).toBe(1);
    expect(outcome.comment).toContain("src/add.ts:2");
    expect(outcome.comment?.split("\n")[0]).toContain(":high=1:");
  } finally {
    cleanup();
  }
});

interface ErrorRun {
  readonly code: number;
  readonly ledger: string;
  readonly requests: number;
  readonly verdictDir: string;
  readonly cleanup: () => void;
}

// Runs one audit against a recording (or no server for a refused
// connection) and reports the exit code, the ledger text, the model
// call count and the verdict dir.
async function runErrorCase(prefix: string, recording: string | null): Promise<ErrorRun> {
  const setup = await setupLibraryCase(prefix);
  const restoreEnv = applyTestEnv();
  const server = recording === null ? null : await startLoopback(recording);
  if (server !== null) {
    loopbackEnv(server.port);
  } else {
    // No loopback server listens here: the connection is refused before
    // any response, so nothing was billed and nothing is recorded.
    process.env.PROVIDER_META_API_BASE_URL = "http://127.0.0.1:9";
    process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = "http://127.0.0.1:9";
  }
  const cleanup = (): void => {
    if (server !== null) {
      void server.stop();
    }
    clearLoopbackEnv();
    restoreEnv();
    setup.cleanupFiles();
  };
  try {
    const config = await loadAuditorConfig();
    let code = 0;
    try {
      await runAudit(
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
          budget: admittingGate(process.cwd()),
          call: setup.counting,
          ledgerPath: setup.ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      code = auditExitCode(error);
    }
    const ledger = await Bun.file(setup.ledgerPath).text();
    return {
      code,
      ledger,
      requests: setup.requestCount(),
      verdictDir: setup.verdictDir,
      cleanup,
    };
  } catch (error: unknown) {
    cleanup();
    throw error;
  }
}

test("empty reply exits 4 with no verdict but recorded usage (mutation: treat empty as No findings)", async () => {
  const run = await runErrorCase("auditor-empty-", "tests/auditor/recordings/empty.json");
  try {
    expect(run.code).toBe(4);
    expect(await readdir(join(run.verdictDir, "w9-demo")).catch(() => [] as string[])).toEqual([]);
    expect(run.ledger).toContain('"kind":"audit"');
  } finally {
    run.cleanup();
  }
});

test("bad location exits 4 with no verdict (mutation: drop the invalid finding)", async () => {
  const run = await runErrorCase("auditor-badloc-", "tests/auditor/recordings/bad-location.json");
  try {
    expect(run.code).toBe(4);
    expect(await readdir(join(run.verdictDir, "w9-demo")).catch(() => [] as string[])).toEqual([]);
  } finally {
    run.cleanup();
  }
});

test("200 with null content exits 4 and keeps the billed tokens (mutation: append only on success)", async () => {
  const run = await runErrorCase("auditor-nullcontent-", "tests/auditor/recordings/null-content.json");
  try {
    expect(run.code).toBe(4);
    expect(run.requests).toBe(1);
    expect(run.ledger).toContain('"kind":"audit"');
    expect(run.ledger).toContain('"inputTokens":140');
    expect(run.ledger).toContain('"outputTokens":3');
    expect(run.ledger).toContain('"requests":1');
  } finally {
    run.cleanup();
  }
});

test("200 with a non-JSON body exits 4 with null tokens and requests 1", async () => {
  const run = await runErrorCase("auditor-nonjson-", "tests/auditor/recordings/non-json.json");
  try {
    expect(run.code).toBe(4);
    expect(run.requests).toBe(1);
    expect(run.ledger).toContain('"kind":"audit"');
    expect(run.ledger).toContain('"inputTokens":null');
    expect(run.ledger).toContain('"outputTokens":null');
    expect(run.ledger).toContain('"requests":1');
  } finally {
    run.cleanup();
  }
});

test("closed connection exits 4 with no ledger entry", async () => {
  const run = await runErrorCase("auditor-closed-", null);
  try {
    expect(run.code).toBe(4);
    expect(run.ledger).toBe("");
  } finally {
    run.cleanup();
  }
});

test("work item without DoD exits 2: the library and the CLI share isWorkItem", async () => {
  const setup = await setupLibraryCase("auditor-nodod-");
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
          budget: admittingGate(process.cwd()),
          call: callProviderOnce,
          ledgerPath: setup.ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      code = auditExitCode(error);
    }
    expect(code).toBe(2);
    const files = await Array.fromAsync(new Bun.Glob("**/*.json").scan({ cwd: setup.verdictDir }));
    expect(files).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("second audit at one sha refuses 3 (mutation: overwrite the stored verdict)", async () => {
  const setup = await setupLibraryCase("auditor-twice-");
  const restoreEnv = applyTestEnv();
  const server = await startLoopback("tests/auditor/recordings/clean.json");
  loopbackEnv(server.port);
  const cleanup = (): void => {
    void server.stop();
    clearLoopbackEnv();
    restoreEnv();
    setup.cleanupFiles();
  };
  try {
    const config = await loadAuditorConfig();
    const input: AuditInput = {
      item: demoItem("demo-good") as unknown as AuditInput["item"],
      repoDir: setup.repoDir,
      ref: "demo-good",
      baseRef: "main",
      pullNumber: 99,
      authorModels: ["meta/muse-glimmer-30b"],
    };
    const deps = {
      config: { ...config, verdictDir: setup.verdictDir },
      git: createReadOnlyGit(setup.repoDir),
      budget: admittingGate(process.cwd()),
      call: callProviderOnce,
      ledgerPath: setup.ledgerPath,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
    };
    const first = await runAudit(input, deps);
    if (first.kind !== "verdict") {
      throw new Error(`first audit refused: ${first.reason}`);
    }
    const second = await runAudit(input, deps);
    if (second.kind !== "refused" || !second.reason.includes(first.verdict.headSha)) {
      throw new Error(`expected a same-sha refusal, got ${JSON.stringify(second)}`);
    }
  } finally {
    cleanup();
  }
});

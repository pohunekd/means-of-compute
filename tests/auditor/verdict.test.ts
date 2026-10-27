// Audit run tests through the loopback stub and a temp git repo.
// D1 (clean) and D2 (defect) plus the same-sha, empty-reply and bad-location
// guards of the test matrix. Each test names the mutation that must fail it.
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
import { isAuditVerdict } from "../../contracts/v1/validate.js";
import { demoItem, makeTempRepo, removeTempRepo } from "./temp-repo.js";

const AUDITOR_ENV = {
  NVIDIA_API_KEY: "test",
  META_API_KEY: "test",
  LOCAL_MODEL_BASE_URL: "http://localhost:1234/v1",
};

interface RunResult {
  readonly outcome: Awaited<ReturnType<typeof runAudit>>;
  readonly verdictDir: string;
  readonly ledgerPath: string;
  readonly cleanup: () => void;
  readonly requestCount: () => number;
}

async function runCase(
  branch: "demo-good" | "demo-bad",
  recording: string,
  pull: number | null = 99,
): Promise<RunResult> {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-run-"));
  const verdictDir = join(workdir, "verdicts");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  for (const [key, value] of Object.entries(AUDITOR_ENV)) {
    process.env[key] = value;
  }
  resetProvidersCache();
  let requests = 0;
  const counting = async (
    providerId: string,
    request: Parameters<typeof callProviderOnce>[1],
  ): Promise<Awaited<ReturnType<typeof callProviderOnce>>> => {
    requests += 1;
    return callProviderOnce(providerId, request);
  };
  const server = await startLoopback(recording);
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_WONDER_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  const stop = (): void => {
    void server.stop();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.PROVIDER_WONDER_BASE_URL;
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  };
  try {
    const config = await loadAuditorConfig();
    const input: AuditInput = {
      item: demoItem(branch) as unknown as AuditInput["item"],
      repoDir: repo.dir,
      ref: branch,
      baseRef: "main",
      pullNumber: pull,
      authorModels: ["meta/muse-glimmer-30b"],
    };
    const outcome = await runAudit(input, {
      config: { ...config, verdictDir },
      git: createReadOnlyGit(repo.dir),
      budget: createCliBudgetGate({
        command: ["bun", "src/budget/check.ts"],
        timeoutMs: 30000,
        cwd: process.cwd(),
      }),
      call: counting,
      ledgerPath,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
    });
    return { outcome, verdictDir, ledgerPath, cleanup: stop, requestCount: () => requests };
  } catch (error: unknown) {
    stop();
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

test("empty reply exits 4 with no verdict but recorded usage (mutation: treat empty as No findings)", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-empty-"));
  const verdictDir = join(workdir, "verdicts");
  const { mkdir, readdir } = await import("node:fs/promises");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  for (const [key, value] of Object.entries(AUDITOR_ENV)) {
    process.env[key] = value;
  }
  resetProvidersCache();
  const server = await startLoopback("tests/auditor/recordings/empty.json");
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_WONDER_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  try {
    const config = await loadAuditorConfig();
    let code = 0;
    try {
      await runAudit(
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
          budget: createCliBudgetGate({
            command: ["bun", "src/budget/check.ts"],
            timeoutMs: 30000,
            cwd: process.cwd(),
          }),
          call: callProviderOnce,
          ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      code = auditExitCode(error);
    }
    expect(code).toBe(4);
    expect(await readdir(join(verdictDir, "w9-demo")).catch(() => [] as string[])).toEqual([]);
    expect(await Bun.file(ledgerPath).text()).toContain('"kind":"audit"');
  } finally {
    void server.stop();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.PROVIDER_WONDER_BASE_URL;
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("bad location exits 4 with no verdict (mutation: drop the invalid finding)", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-badloc-"));
  const verdictDir = join(workdir, "verdicts");
  const { mkdir, readdir } = await import("node:fs/promises");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  for (const [key, value] of Object.entries(AUDITOR_ENV)) {
    process.env[key] = value;
  }
  resetProvidersCache();
  const server = await startLoopback("tests/auditor/recordings/bad-location.json");
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_WONDER_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  try {
    const config = await loadAuditorConfig();
    let code = 0;
    try {
      await runAudit(
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
          budget: createCliBudgetGate({
            command: ["bun", "src/budget/check.ts"],
            timeoutMs: 30000,
            cwd: process.cwd(),
          }),
          call: callProviderOnce,
          ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      code = auditExitCode(error);
    }
    expect(code).toBe(4);
    expect(await readdir(join(verdictDir, "w9-demo")).catch(() => [] as string[])).toEqual([]);
  } finally {
    void server.stop();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.PROVIDER_WONDER_BASE_URL;
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("200 with null content exits 4 and keeps the billed tokens (mutation: append only on success)", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-nullcontent-"));
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
  const server = await startLoopback("tests/auditor/recordings/null-content.json");
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_WONDER_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  try {
    const config = await loadAuditorConfig();
    let code = 0;
    try {
      await runAudit(
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
          budget: createCliBudgetGate({
            command: ["bun", "src/budget/check.ts"],
            timeoutMs: 30000,
            cwd: process.cwd(),
          }),
          call: counting,
          ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      code = auditExitCode(error);
    }
    expect(code).toBe(4);
    expect(requests).toBe(1);
    const ledger = await Bun.file(ledgerPath).text();
    expect(ledger).toContain('"kind":"audit"');
    expect(ledger).toContain('"inputTokens":140');
    expect(ledger).toContain('"outputTokens":3');
    expect(ledger).toContain('"requests":1');
  } finally {
    void server.stop();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.PROVIDER_WONDER_BASE_URL;
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("200 with a non-JSON body exits 4 with null tokens and requests 1", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-nonjson-"));
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
  const server = await startLoopback("tests/auditor/recordings/non-json.json");
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_WONDER_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  try {
    const config = await loadAuditorConfig();
    let code = 0;
    try {
      await runAudit(
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
          budget: createCliBudgetGate({
            command: ["bun", "src/budget/check.ts"],
            timeoutMs: 30000,
            cwd: process.cwd(),
          }),
          call: counting,
          ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      code = auditExitCode(error);
    }
    expect(code).toBe(4);
    expect(requests).toBe(1);
    const ledger = await Bun.file(ledgerPath).text();
    expect(ledger).toContain('"kind":"audit"');
    expect(ledger).toContain('"inputTokens":null');
    expect(ledger).toContain('"outputTokens":null');
    expect(ledger).toContain('"requests":1');
  } finally {
    void server.stop();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.PROVIDER_WONDER_BASE_URL;
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("closed connection exits 4 with no ledger entry", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-closed-"));
  const verdictDir = join(workdir, "verdicts");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  for (const [key, value] of Object.entries(AUDITOR_ENV)) {
    process.env[key] = value;
  }
  resetProvidersCache();
  // No loopback server listens here: the connection is refused before
  // any response, so nothing was billed and nothing is recorded.
  process.env.PROVIDER_META_API_BASE_URL = "http://127.0.0.1:9";
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = "http://127.0.0.1:9";
  process.env.PROVIDER_WONDER_BASE_URL = "http://127.0.0.1:9";
  try {
    const config = await loadAuditorConfig();
    let code = 0;
    try {
      await runAudit(
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
          budget: createCliBudgetGate({
            command: ["bun", "src/budget/check.ts"],
            timeoutMs: 30000,
            cwd: process.cwd(),
          }),
          call: callProviderOnce,
          ledgerPath,
          now: () => new Date("2026-10-27T10:00:00.000Z"),
        },
      );
    } catch (error: unknown) {
      code = auditExitCode(error);
    }
    expect(code).toBe(4);
    const ledger = await Bun.file(ledgerPath).text();
    expect(ledger).toBe("");
  } finally {
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.PROVIDER_WONDER_BASE_URL;
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("work item without DoD refuses 3 with no verdict (no DoD, no audit)", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-nodod-"));
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
    const outcome = await runAudit(
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
        budget: createCliBudgetGate({
          command: ["bun", "src/budget/check.ts"],
          timeoutMs: 30000,
          cwd: process.cwd(),
        }),
        call: callProviderOnce,
        ledgerPath,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
      },
    );
    expect(outcome.kind).toBe("refused");
    const files = await Array.fromAsync(new Bun.Glob("**/*.json").scan({ cwd: verdictDir }));
    expect(files).toHaveLength(0);
  } finally {
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("second audit at one sha refuses 3 (mutation: overwrite the stored verdict)", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-twice-"));
  const verdictDir = join(workdir, "verdicts");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  for (const [key, value] of Object.entries(AUDITOR_ENV)) {
    process.env[key] = value;
  }
  resetProvidersCache();
  const server = await startLoopback("tests/auditor/recordings/clean.json");
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_WONDER_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  try {
    const config = await loadAuditorConfig();
    const input: AuditInput = {
      item: demoItem("demo-good") as unknown as AuditInput["item"],
      repoDir: repo.dir,
      ref: "demo-good",
      baseRef: "main",
      pullNumber: 99,
      authorModels: ["meta/muse-glimmer-30b"],
    };
    const deps = {
      config: { ...config, verdictDir },
      git: createReadOnlyGit(repo.dir),
      budget: createCliBudgetGate({
        command: ["bun", "src/budget/check.ts"],
        timeoutMs: 30000,
        cwd: process.cwd(),
      }),
      call: callProviderOnce,
      ledgerPath,
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
    void server.stop();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.PROVIDER_WONDER_BASE_URL;
    resetProvidersCache();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

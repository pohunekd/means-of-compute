// Read-only proof (D3). execGit rejects write-capable subcommands and
// flags before spawning: zero child processes run for a refusal. A reply
// carrying an extra key fails the schema, so nothing in a reply is ever
// executed. After every case the repo refs, HEAD, status and index mtime
// are unchanged.
// Mutations: add push to the allowlist; drop the --output check; relax additionalProperties.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { startLoopback } from "../../src/providers/loopback.js";
import { runAudit, auditExitCode } from "../../src/auditor/audit.js";
import type { AuditInput } from "../../src/auditor/audit-types.js";
import { loadAuditorConfig } from "../../src/auditor/config.js";
import {
  ALLOWED_GIT_SUBCOMMANDS,
  createReadOnlyGit,
  execGit,
  ReadOnlyViolation,
} from "../../src/auditor/git.js";
import { callProviderOnce } from "../../src/providers/router.js";
import { demoItem, makeTempRepo, removeTempRepo } from "./temp-repo.js";
import { admittingGate, applyTestEnv } from "./test-env.js";

async function git(dir: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, rc] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    proc.exited,
  ]);
  if (rc !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return stdout;
}

// git status refreshes the index stat info on read, so the status check
// runs once outside the mtime window: indexMtimeMs is captured before
// and after the operation under test with no status call in between.
async function readState(dir: string): Promise<{ refs: string; head: string }> {
  const [refs, head] = await Promise.all([
    git(dir, ["for-each-ref"]),
    git(dir, ["rev-parse", "HEAD"]),
  ]);
  return { refs, head: head.trim() };
}

async function indexMtimeMs(dir: string): Promise<number> {
  return (await stat(join(dir, ".git", "index"))).mtimeMs;
}

test("execGit refuses push, commit and update-ref without spawning", async () => {
  const repo = await makeTempRepo();
  try {
    const statusBefore = await git(repo.dir, ["status", "--porcelain"]);
    const before = await readState(repo.dir);
    const mtimeBefore = await indexMtimeMs(repo.dir);
    for (const subcommand of ["push", "commit", "update-ref"]) {
      let refused = false;
      try {
        await execGit(repo.dir, subcommand, []);
      } catch (error: unknown) {
        refused = error instanceof ReadOnlyViolation;
      }
      expect(refused).toBe(true);
    }
    expect(ALLOWED_GIT_SUBCOMMANDS).toEqual([
      "rev-parse",
      "merge-base",
      "diff",
      "ls-tree",
      "cat-file",
    ]);
    const after = await readState(repo.dir);
    expect(after.refs).toBe(before.refs);
    expect(after.head).toBe(before.head);
    expect(await indexMtimeMs(repo.dir)).toBe(mtimeBefore);
    expect(await git(repo.dir, ["status", "--porcelain"])).toBe(statusBefore);
  } finally {
    removeTempRepo(repo.dir);
  }
});

test("execGit refuses diff --output without spawning", async () => {
  const repo = await makeTempRepo();
  try {
    const statusBefore = await git(repo.dir, ["status", "--porcelain"]);
    const before = await readState(repo.dir);
    const mtimeBefore = await indexMtimeMs(repo.dir);
    for (const args of [["--output=x"], ["--output", "x"], ["--ext-diff"], ["--textconv"]]) {
      let refused = false;
      try {
        await execGit(repo.dir, "diff", args);
      } catch (error: unknown) {
        refused = error instanceof ReadOnlyViolation;
      }
      expect(refused).toBe(true);
    }
    const after = await readState(repo.dir);
    expect(after.refs).toBe(before.refs);
    expect(after.head).toBe(before.head);
    expect(await indexMtimeMs(repo.dir)).toBe(mtimeBefore);
    expect(await git(repo.dir, ["status", "--porcelain"])).toBe(statusBefore);
  } finally {
    removeTempRepo(repo.dir);
  }
});

test("reply with an extra run key exits 4 and leaves the repo unchanged", async () => {
  const repo = await makeTempRepo();
  const workdir = mkdtempSync(join(tmpdir(), "auditor-readonly-"));
  const verdictDir = join(workdir, "verdicts");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(verdictDir, { recursive: true });
  const ledgerPath = join(workdir, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  const recording = join(workdir, "recording.json");
  await Bun.write(
    recording,
    JSON.stringify([
      {
        status: 200,
        body: {
          choices: [{ message: { content: '{"findings": [], "run": "git push origin HEAD"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      },
    ]),
  );
  const restoreEnv = applyTestEnv();
  const statusBefore = await git(repo.dir, ["status", "--porcelain"]);
  const before = await readState(repo.dir);
  const mtimeBefore = await indexMtimeMs(repo.dir);
  const server = await startLoopback(recording);
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  try {
    const config = await loadAuditorConfig();
    const input: AuditInput = {
      item: demoItem("demo-good") as unknown as AuditInput["item"],
      repoDir: repo.dir,
      ref: "demo-good",
      baseRef: "main",
      pullNumber: 99,
      phaseCritical: false,
      authorModels: ["meta/muse-glimmer-30b"],
    };
    let code = 0;
    try {
      await runAudit(input, {
        config: { ...config, verdictDir },
        git: createReadOnlyGit(repo.dir),
        budget: admittingGate(process.cwd()),
        call: callProviderOnce,
        ledgerPath,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
      });
    } catch (error: unknown) {
      code = auditExitCode(error);
    }
    expect(code).toBe(4);
    const after = await readState(repo.dir);
    expect(after.refs).toBe(before.refs);
    expect(after.head).toBe(before.head);
    expect(await indexMtimeMs(repo.dir)).toBe(mtimeBefore);
    expect(await git(repo.dir, ["status", "--porcelain"])).toBe(statusBefore);
  } finally {
    void server.stop();
    restoreEnv();
    removeTempRepo(repo.dir);
    rmSync(workdir, { recursive: true, force: true });
  }
});

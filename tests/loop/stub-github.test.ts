// Stub GitHub tests (PR 4 matrix rows L22-L22e): the stub answers from a
// sandbox origin.git, with live tips, real merges and a shared counter.
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, revParse, type GitDeps } from "../../src/loop/git.js";
import { GitHubError } from "../../src/loop/github.js";
import { casUpdateRef, createStubGitHub, type StubCi } from "../../src/loop/stub/github.js";

const GIT_ENV = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function git(dir: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    env: GIT_ENV,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout as ReadableStream).text();
  const stderr = await new Response(proc.stderr as ReadableStream).text();
  const rc = await proc.exited;
  if (rc !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${String(rc)}: ${stderr}`);
  }
  return stdout;
}

// Sandbox origin with a main line plus a seed clone that creates branches.
async function makeSandbox() {
  const root = await mkdtemp(join(tmpdir(), "stub-github-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const scratchDir = join(root, "scratch");
  await git(root, ["init", "--bare", origin]);
  await git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "clone",
    origin,
    seed,
  ]);
  await git(seed, ["config", "user.name", "fixture"]);
  await git(seed, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(seed, "f.txt"), "main line\n", "utf8");
  await git(seed, ["add", "f.txt"]);
  await git(seed, ["commit", "-m", "main1"]);
  await git(seed, ["branch", "-M", "main"]);
  await git(seed, ["push", "origin", "main"]);
  return {
    root,
    origin,
    seed,
    scratchDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function pushEmpty(seed: string, branch: string, from = "main"): Promise<void> {
  await git(seed, ["checkout", "-B", branch, from]);
  await git(seed, ["commit", "--allow-empty", "-m", branch]);
  await git(seed, ["push", "origin", branch]);
}

function stubOptions(
  origin: string,
  scratchDir: string,
  ci: (sha: string) => StubCi = () => "success",
) {
  const gitDeps: GitDeps = { PATH: GIT_ENV.PATH, timeoutMs: 30000 };
  return {
    repo: "factory/demo",
    originDir: origin,
    baseBranch: "main",
    factoryLogin: "factory",
    git: gitDeps,
    scratchDir,
    ci,
  };
}

describe("stub github", () => {
  test("L22b: main commits stay green while heads follow the callback", async () => {
    const sandbox = await makeSandbox();
    try {
      const stub = createStubGitHub(
        stubOptions(sandbox.origin, sandbox.scratchDir, () => "failure"),
      );
      await pushEmpty(sandbox.seed, "moc/demo-a");
      const base = (await git(sandbox.seed, ["rev-parse", "main"])).trim();
      const head = (await git(sandbox.seed, ["rev-parse", "moc/demo-a"])).trim();
      const mainRuns = await stub.checkRuns("factory/demo", base);
      expect(mainRuns).toHaveLength(1);
      expect(mainRuns[0]).toMatchObject({
        name: "gates",
        status: "completed",
        conclusion: "success",
      });
      const headRuns = await stub.checkRuns("factory/demo", head);
      expect(headRuns).toHaveLength(1);
      expect(headRuns[0]).toMatchObject({ conclusion: "failure" });
      const pending = createStubGitHub(
        stubOptions(sandbox.origin, sandbox.scratchDir, () => "pending"),
      );
      expect(await pending.checkRuns("factory/demo", head)).toEqual([]);
      expect(await pending.viewerLogin()).toBe("factory");
    } finally {
      await sandbox.cleanup();
    }
  });

  test("L22c: branch tips move and the merge records both shas", async () => {
    const sandbox = await makeSandbox();
    try {
      const stub = createStubGitHub(stubOptions(sandbox.origin, sandbox.scratchDir));
      await pushEmpty(sandbox.seed, "moc/demo-b");
      const first = (await git(sandbox.seed, ["rev-parse", "moc/demo-b"])).trim();
      const pull = await stub.createPull("factory/demo", "moc/demo-b", "main", "t", "b");
      expect((await stub.pullsForBranch("factory/demo", "moc/demo-b"))[0]?.headRefOid).toBe(first);
      expect((await stub.viewPull("factory/demo", pull)).headRefOid).toBe(first);
      const baseBefore = await stub.baseSha("factory/demo", "main");
      await git(sandbox.seed, ["checkout", "moc/demo-b"]);
      await git(sandbox.seed, ["commit", "--allow-empty", "-m", "moc/demo-b second"]);
      await git(sandbox.seed, ["push", "origin", "moc/demo-b"]);
      const second = (await git(sandbox.seed, ["rev-parse", "moc/demo-b"])).trim();
      expect(second).not.toBe(first);
      expect((await stub.pullsForBranch("factory/demo", "moc/demo-b"))[0]?.headRefOid).toBe(second);
      await stub.mergePull("factory/demo", pull, second);
      const view = await stub.viewPull("factory/demo", pull);
      expect(view.state).toBe("MERGED");
      expect(view.headRefOid).toBe(second);
      const baseAfter = await stub.baseSha("factory/demo", "main");
      expect(baseAfter).not.toBe(baseBefore);
      expect(view.mergeCommit).toBe(baseAfter);
      const parents = await stub.commitParents("factory/demo", baseAfter);
      expect(parents).toEqual([baseBefore, second]);
    } finally {
      await sandbox.cleanup();
    }
  });

  test("L22M5: a stale head is rejected; unknown refs are GitHubError", async () => {
    const sandbox = await makeSandbox();
    try {
      const stub = createStubGitHub(stubOptions(sandbox.origin, sandbox.scratchDir));
      await pushEmpty(sandbox.seed, "moc/demo-c");
      const first = (await git(sandbox.seed, ["rev-parse", "moc/demo-c"])).trim();
      const pull = await stub.createPull("factory/demo", "moc/demo-c", "main", "t", "b");
      const baseBefore = await stub.baseSha("factory/demo", "main");
      await git(sandbox.seed, ["checkout", "moc/demo-c"]);
      await git(sandbox.seed, ["commit", "--allow-empty", "-m", "moc/demo-c second"]);
      await git(sandbox.seed, ["push", "origin", "moc/demo-c"]);
      const moved = (await git(sandbox.seed, ["rev-parse", "moc/demo-c"])).trim();
      expect(moved).not.toBe(first);
      const failed = await stub
        .mergePull("factory/demo", pull, first)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(GitHubError);
      expect((failed as GitHubError).kind).toBe("rejected");
      expect(await stub.baseSha("factory/demo", "main")).toBe(baseBefore);
      await stub.mergePull("factory/demo", pull, moved);
      expect(await stub.baseSha("factory/demo", "main")).not.toBe(baseBefore);
    } finally {
      await sandbox.cleanup();
    }
  });

  test("L22d: issues, labels, comments and one counter round-trip", async () => {
    const sandbox = await makeSandbox();
    try {
      const stub = createStubGitHub(stubOptions(sandbox.origin, sandbox.scratchDir));
      await pushEmpty(sandbox.seed, "moc/demo-d");
      const pull = await stub.createPull("factory/demo", "moc/demo-d", "main", "t", "b");
      expect(pull).toBe(1);
      const issue = await stub.createIssue("factory/demo", "titled", "first line\nrest", [
        "a",
        "b",
      ]);
      expect(issue).toBe(2);
      await stub.editIssueLabels("factory/demo", issue, ["c"], ["a"]);
      const found = await stub.factoryIssues("factory/demo", "c");
      expect(found).toEqual([{ number: issue, first: "first line" }]);
      expect(await stub.factoryIssues("factory/demo", "a")).toEqual([]);
      await stub.postComment("factory/demo", issue, "hello\nworld");
      expect(await stub.commentFirstLines("factory/demo", issue)).toEqual([
        { login: "factory", first: "hello" },
      ]);
      let wrong: unknown = null;
      try {
        await stub.postComment("x/y", issue, "hi");
      } catch (error: unknown) {
        wrong = error;
      }
      expect(wrong).toBeInstanceOf(GitHubError);
      expect((wrong as GitHubError).kind).toBe("rejected");
      const snapshot = stub.snapshot();
      expect(snapshot.pulls.map((row) => row.number)).toEqual([1]);
      expect(snapshot.issues.map((row) => row.number)).toEqual([2]);
    } finally {
      await sandbox.cleanup();
    }
  });

  test("L22e: a stale old ref is rejected and the ref keeps its value", async () => {
    const sandbox = await makeSandbox();
    try {
      const options = stubOptions(sandbox.origin, sandbox.scratchDir);
      const stub = createStubGitHub(options);
      await pushEmpty(sandbox.seed, "moc/demo-e");
      const pull = await stub.createPull("factory/demo", "moc/demo-e", "main", "t", "b");
      const head = await revParse(options.originDir, options.git, "refs/heads/moc/demo-e");
      await stub.mergePull("factory/demo", pull, head);
      const moved = await revParse(options.originDir, options.git, "refs/heads/main");
      const stale = await casUpdateRef(
        options.originDir,
        options.git,
        "refs/heads/main",
        head,
        head,
      ).catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(GitHubError);
      expect((stale as GitHubError).kind).toBe("rejected");
      expect(await revParse(options.originDir, options.git, "refs/heads/main")).toBe(moved);
      await casUpdateRef(options.originDir, options.git, "refs/heads/main", head, moved);
      expect(await revParse(options.originDir, options.git, "refs/heads/main")).toBe(head);
    } finally {
      await sandbox.cleanup();
    }
  });

  test("L22M5b: unknown refs are GitHubError rejected", async () => {
    const sandbox = await makeSandbox();
    try {
      const options = stubOptions(sandbox.origin, sandbox.scratchDir);
      const stub = createStubGitHub(options);
      await pushEmpty(sandbox.seed, "moc/demo-f");
      await stub.createPull("factory/demo", "moc/demo-f", "main", "t", "b");
      const unknownSha = "0123456789012345678901234567890123456789";
      const runs = await stub
        .checkRuns("factory/demo", unknownSha)
        .catch((error: unknown) => error);
      expect(runs).toBeInstanceOf(GitHubError);
      expect((runs as GitHubError).kind).toBe("rejected");
      await git(sandbox.seed, ["push", "origin", ":refs/heads/moc/demo-f"]);
      const view = await stub.viewPull("factory/demo", 1).catch((error: unknown) => error);
      expect(view).toBeInstanceOf(GitHubError);
      expect((view as GitHubError).kind).toBe("rejected");
      const base = await stub.baseSha("factory/demo", "nope").catch((error: unknown) => error);
      expect(base).toBeInstanceOf(GitHubError);
      expect((base as GitHubError).kind).toBe("rejected");
    } finally {
      await sandbox.cleanup();
    }
  });

  test("L22M7: a relative stub scratch dir throws before any use", async () => {
    const sandbox = await makeSandbox();
    try {
      let failed: unknown = null;
      try {
        createStubGitHub({
          ...stubOptions(sandbox.origin, sandbox.scratchDir),
          scratchDir: "scratch/x",
        });
      } catch (error: unknown) {
        failed = error;
      }
      expect(failed).toBeInstanceOf(GitError);
      expect((failed as GitError).message).toContain("scratchDir");
      expect((failed as GitError).message).toContain("absolute");
    } finally {
      await sandbox.cleanup();
    }
  });

  test("S1: a slow scratch cleanup never changes the merge outcome", async () => {
    const sandbox = await makeSandbox();
    // A fake git that sleeps past the stub timeout on `worktree remove`.
    const realLine = (
      await (async (): Promise<string> => {
        const proc = Bun.spawn(["sh", "-c", "command -v git"], {
          stdout: "pipe",
          stderr: "ignore",
          stdin: "ignore",
        });
        const text = await new Response(proc.stdout as ReadableStream).text();
        await proc.exited;
        return (text.split("\n")[0] ?? "/usr/bin/git").trim();
      })()
    ).replace(/\/git$/, "");
    const fakeDir = await mkdtemp(join(tmpdir(), "fake-stub-git-"));
    await writeFile(
      join(fakeDir, "git"),
      `#!/bin/sh\nREAL_GIT="${realLine}/git"\n` +
        'for a in "$@"; do\n  if [ "$a" = "remove" ]; then\n    sleep 3\n  fi\ndone\n' +
        'exec "$REAL_GIT" "$@"\n',
      "utf8",
    );
    await chmod(join(fakeDir, "git"), 0o755);
    try {
      const options = {
        ...stubOptions(sandbox.origin, sandbox.scratchDir),
        git: { PATH: `${fakeDir}:${realLine}`, timeoutMs: 1500 },
      };
      const stub = createStubGitHub(options);
      // Case (a): an open, mergeable pull resolves even though the
      // scratch cleanup times out, and the base ref moves to the commit.
      await pushEmpty(sandbox.seed, "moc/demo-s1");
      const head = await revParse(options.originDir, options.git, "refs/heads/moc/demo-s1");
      const pull = await stub.createPull("factory/demo", "moc/demo-s1", "main", "t", "b");
      await stub.mergePull("factory/demo", pull, head);
      const view = await stub.viewPull("factory/demo", pull);
      expect(view.state).toBe("MERGED");
      expect(view.mergeCommit).not.toBeNull();
      expect(await revParse(options.originDir, options.git, "refs/heads/main")).toBe(
        view.mergeCommit as string,
      );
      // Case (b): a conflicting pull rejects as rejected, never unavailable.
      await git(sandbox.seed, ["checkout", "-b", "moc/demo-s1b", "main~0"]);
      await writeFile(join(sandbox.seed, "f.txt"), "branch line\n", "utf8");
      await git(sandbox.seed, ["add", "f.txt"]);
      await git(sandbox.seed, ["commit", "-m", "branch change"]);
      await git(sandbox.seed, ["push", "origin", "moc/demo-s1b"]);
      await git(sandbox.seed, ["checkout", "main"]);
      await git(sandbox.seed, ["fetch", "origin"]);
      await git(sandbox.seed, ["reset", "--hard", "origin/main"]);
      await writeFile(join(sandbox.seed, "f.txt"), "main line\nchanged on main\n", "utf8");
      await git(sandbox.seed, ["add", "f.txt"]);
      await git(sandbox.seed, ["commit", "-m", "main change"]);
      await git(sandbox.seed, ["push", "origin", "main"]);
      const conflictHead = await revParse(
        options.originDir,
        options.git,
        "refs/heads/moc/demo-s1b",
      );
      const conflict = await stub.createPull("factory/demo", "moc/demo-s1b", "main", "t", "b");
      const failed = await stub
        .mergePull("factory/demo", conflict, conflictHead)
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(GitHubError);
      expect((failed as GitHubError).kind).toBe("rejected");
    } finally {
      await rm(fakeDir, { recursive: true, force: true });
      await sandbox.cleanup();
    }
  }, 15_000);

  test("T1: a leftover of the pull scratch path is cleared before the add", async () => {
    const sandbox = await makeSandbox();
    try {
      const options = stubOptions(sandbox.origin, sandbox.scratchDir);
      const stub = createStubGitHub(options);
      const porch = async (): Promise<string> =>
        git(options.originDir, ["worktree", "list", "--porcelain"]);
      // Case (a): a registered worktree at the pull's scratch path.
      await pushEmpty(sandbox.seed, "moc/demo-t1a");
      const headA = await revParse(options.originDir, options.git, "refs/heads/moc/demo-t1a");
      const pullA = await stub.createPull("factory/demo", "moc/demo-t1a", "main", "t", "b");
      const wtA = join(sandbox.scratchDir, `stub-merge-${String(pullA)}`);
      await git(options.originDir, ["worktree", "add", "--detach", wtA, "main"]);
      expect(await porch()).toContain(wtA);
      await stub.mergePull("factory/demo", pullA, headA);
      expect((await stub.viewPull("factory/demo", pullA)).state).toBe("MERGED");
      expect(await porch()).not.toContain(wtA);
      // Case (b): the leftover directory is gone but stays registered.
      await pushEmpty(sandbox.seed, "moc/demo-t1b");
      const headB = await revParse(options.originDir, options.git, "refs/heads/moc/demo-t1b");
      const pullB = await stub.createPull("factory/demo", "moc/demo-t1b", "main", "t", "b");
      const wtB = join(sandbox.scratchDir, `stub-merge-${String(pullB)}`);
      await git(options.originDir, ["worktree", "add", "--detach", wtB, "main"]);
      await rm(wtB, { recursive: true, force: true });
      expect(await porch()).toContain(wtB);
      await stub.mergePull("factory/demo", pullB, headB);
      expect((await stub.viewPull("factory/demo", pullB)).state).toBe("MERGED");
      expect(await porch()).not.toContain(wtB);
    } finally {
      await sandbox.cleanup();
    }
  }, 15_000);
});

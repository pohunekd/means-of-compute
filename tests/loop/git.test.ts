// Git runner tests (PR 4 matrix rows L23a-L23m): real git in temp repos,
// J4 line shapes, branch checks, ancestry and the full trial lifecycle.
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitError,
  fetchRefs,
  isAncestor,
  parseLsRemote,
  remoteBranchSha,
  revParse,
  trialMerge,
  type GitDeps,
  type TrialInput,
} from "../../src/loop/git.js";

const trackedPids: number[] = [];

afterEach(() => {
  for (const pid of trackedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
});

async function waitGone(pid: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    if (Date.now() - start > 2000) {
      return false;
    }
    await Bun.sleep(25);
  }
}

// A fake git on PATH execs the real git except for the faked subcommand
// named inside the script; the name argument only documents the test.
async function fakeGitDir(
  realPath: string,
  subcommand: string,
  script: string,
): Promise<{ dir: string; fakePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), `fake-git-${subcommand}-`));
  await writeFile(join(dir, "git"), `#!/bin/sh\nREAL_GIT="${realPath}/git"\n${script}\n`, "utf8");
  await chmod(join(dir, "git"), 0o755);
  return { dir, fakePath: `${dir}:${realPath}` };
}

async function realGitPath(): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", "command -v git"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const text = await new Response(proc.stdout as ReadableStream).text();
  await proc.exited;
  const line = text.split("\n")[0] ?? "";
  const slash = line.lastIndexOf("/");
  return slash > 0 ? line.slice(0, slash) : "/usr/bin";
}

const GIT_PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const GIT_ENV = {
  PATH: GIT_PATH,
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

interface Repos {
  readonly root: string;
  readonly origin: string;
  readonly seed: string;
  readonly factory: string;
  readonly deps: GitDeps;
}

// Bare origin with a main branch, a seed working clone and a factory
// clone that the runner calls into. `-c user...` names a local author.
async function makeRepos(): Promise<Repos & { readonly cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "git-runner-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const factory = join(root, "factory");
  await mkdir(origin, { recursive: true });
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
  await git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "clone",
    origin,
    factory,
  ]);
  await git(factory, ["config", "user.name", "fixture"]);
  await git(factory, ["config", "user.email", "fixture@example.invalid"]);
  await git(factory, ["fetch", "origin"]);
  return {
    root,
    origin,
    seed,
    factory,
    deps: { PATH: GIT_PATH, timeoutMs: 30000 },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function worktreeCount(dir: string): Promise<number> {
  const out = await git(dir, ["worktree", "list"]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

function baseTrial(
  factory: string,
  root: string,
  baseSha: string,
  headSha: string,
  steps: readonly (readonly string[])[],
  extra?: Partial<TrialInput>,
): TrialInput {
  return {
    dir: factory,
    scratchDir: join(root, "scratch"),
    id: "demo-a",
    baseSha,
    headSha,
    steps,
    timeoutMs: 30000,
    PATH: GIT_PATH,
    HOME: tmpdir(),
    ...extra,
  };
}

// Push a new empty-commit branch from the seed and fetch it to factory.
async function pushBranch(repos: Repos, branch: string): Promise<{ base: string; head: string }> {
  await git(repos.seed, ["checkout", "-B", branch, "main"]);
  await git(repos.seed, ["commit", "--allow-empty", "-m", branch]);
  await git(repos.seed, ["push", "origin", branch]);
  await fetchRefs(repos.factory, repos.deps, [
    "+refs/heads/main:refs/remotes/origin/main",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  const base = (await git(repos.factory, ["rev-parse", "refs/remotes/origin/main"])).trim();
  const head = (await git(repos.factory, ["rev-parse", `refs/remotes/origin/${branch}`])).trim();
  return { base, head };
}

describe("git runner", () => {
  test("L23a: remoteBranchSha resolves, misses and fails on a bad origin", async () => {
    const repos = await makeRepos();
    try {
      const expected = await git(repos.factory, ["rev-parse", "refs/remotes/origin/main"]);
      const sha = await remoteBranchSha(repos.factory, repos.deps, "main");
      expect(sha).toBe(expected.trim());
      expect(await remoteBranchSha(repos.factory, repos.deps, "moc/none")).toBeNull();
      await git(repos.factory, ["remote", "set-url", "origin", "/nonexistent/x.git"]);
      const failed = await remoteBranchSha(repos.factory, repos.deps, "main").catch(
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(GitError);
      expect((failed as GitError).kind).toBe("failed");
      expect((failed as GitError).rc).toBe(128);
    } finally {
      await repos.cleanup();
    }
  }, 15_000);

  test("L23b: the parser copies the J4 line and rejects two lines", () => {
    const sha = "1b696e9e0bd87fd6da79f6bca202f79e97e2a613";
    expect(parseLsRemote(`${sha}\trefs/heads/moc/demo-a\n`, "moc/demo-a")).toBe(sha);
    expect(parseLsRemote("", "moc/none")).toBeNull();
    const two = `${sha}\trefs/heads/moc/demo-a\n${sha}\trefs/heads/moc/demo-b\n`;
    let seen: unknown = null;
    try {
      parseLsRemote(two, "moc/demo-a");
    } catch (error: unknown) {
      seen = error;
    }
    expect(seen).toBeInstanceOf(GitError);
    expect((seen as GitError).kind).toBe("invalid-output");
    let other: unknown = null;
    try {
      parseLsRemote(`${sha}\trefs/heads/other\n`, "moc/demo-a");
    } catch (error: unknown) {
      other = error;
    }
    expect(other).toBeInstanceOf(GitError);
    expect((other as GitError).kind).toBe("invalid-output");
    let bad: unknown = null;
    try {
      parseLsRemote(`${"z".repeat(40)}\trefs/heads/moc/demo-a\n`, "moc/demo-a");
    } catch (error: unknown) {
      bad = error;
    }
    expect(bad).toBeInstanceOf(GitError);
    expect((bad as GitError).kind).toBe("invalid-output");
  }, 15_000);

  test("L23c: revParse reads and isAncestor maps rc 0, 1 and 128", async () => {
    const repos = await makeRepos();
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const parsed = await revParse(repos.factory, repos.deps, "refs/remotes/origin/moc/demo-a");
      expect(parsed).toBe(head);
      expect(await isAncestor(repos.factory, repos.deps, base, head)).toBe(true);
      expect(await isAncestor(repos.factory, repos.deps, head, base)).toBe(false);
      const failed = await revParse(repos.factory, repos.deps, "refs/remotes/origin/nope").catch(
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(GitError);
      expect((failed as GitError).kind).toBe("failed");
      expect((failed as GitError).rc).toBe(128);
      const bad = await isAncestor(
        repos.factory,
        repos.deps,
        "0123456789012345678901234567890123456789",
        head,
      ).catch((error: unknown) => error);
      expect(bad).toBeInstanceOf(GitError);
      expect((bad as GitError).kind).toBe("failed");
    } finally {
      await repos.cleanup();
    }
  }, 15_000);

  test("L23d: a clean head passes and leaves one worktree entry", async () => {
    const repos = await makeRepos();
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const trial = baseTrial(repos.factory, repos.root, base, head, [
        [process.execPath, "-e", "process.exit(0)"],
      ]);
      const result = await trialMerge(trial);
      expect(result).toEqual({ passed: true, cleanupFailed: false });
      const wt = join(trial.scratchDir, trial.id);
      const seen = await stat(wt).catch((error: unknown) => error);
      expect(seen).toBeInstanceOf(Error);
      expect((seen as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect(await worktreeCount(repos.factory)).toBe(1);
    } finally {
      await repos.cleanup();
    }
  }, 15_000);

  test("L23e: conflict and unknown head fail as written", async () => {
    const repos = await makeRepos();
    try {
      await git(repos.seed, ["checkout", "main"]);
      await writeFile(join(repos.seed, "f.txt"), "main line\nmain2\n", "utf8");
      await git(repos.seed, ["commit", "-am", "main2"]);
      await git(repos.seed, ["push", "origin", "main"]);
      await git(repos.seed, ["checkout", "-B", "moc/demo-c", "main~1"]);
      await writeFile(join(repos.seed, "f.txt"), "main line\nbranch\n", "utf8");
      await git(repos.seed, ["commit", "-am", "branch"]);
      await git(repos.seed, ["push", "origin", "moc/demo-c"]);
      await fetchRefs(repos.factory, repos.deps, [
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/moc/demo-c:refs/remotes/origin/moc/demo-c",
      ]);
      const base = await revParse(repos.factory, repos.deps, "refs/remotes/origin/main");
      const head = await revParse(repos.factory, repos.deps, "refs/remotes/origin/moc/demo-c");
      const conflicted = await trialMerge(
        baseTrial(repos.factory, repos.root, base, head, [], { id: "demo-c" }),
      );
      expect(conflicted).toEqual({
        passed: false,
        reason: "conflict",
        step: null,
        rc: 1,
        cleanupFailed: false,
      });
      expect(await worktreeCount(repos.factory)).toBe(1);
      const unknown = await trialMerge(
        baseTrial(repos.factory, repos.root, base, "0123456789012345678901234567890123456789", [], {
          id: "demo-x",
        }),
      ).catch((error: unknown) => error);
      expect(unknown).toBeInstanceOf(GitError);
      expect((unknown as GitError).kind).toBe("failed");
      expect(await worktreeCount(repos.factory)).toBe(1);
      // A merge rc 1 without the conflict line is a failure, not a conflict.
      const realDir = await realGitPath();
      const fake = await fakeGitDir(
        realDir,
        "merge",
        `for a in "$@"; do\n  if [ "$a" = "merge" ]; then\n    echo "error: Your local changes to the following files would be overwritten by merge:" >&2\n    exit 1\n  fi\ndone\nexec "$REAL_GIT" "$@"`,
      );
      try {
        const notConflict = await trialMerge(
          baseTrial(repos.factory, repos.root, base, head, [], {
            id: "demo-fake",
            PATH: fake.fakePath,
          }),
        ).catch((error: unknown) => error);
        expect(notConflict).toBeInstanceOf(GitError);
        expect((notConflict as GitError).kind).toBe("failed");
        const wt = join(repos.root, "scratch", "demo-fake");
        const gone = await stat(wt).catch((error: unknown) => error);
        expect((gone as NodeJS.ErrnoException).code).toBe("ENOENT");
        expect(await worktreeCount(repos.factory)).toBe(1);
      } finally {
        await rm(fake.dir, { recursive: true, force: true });
      }
    } finally {
      await repos.cleanup();
    }
  }, 15_000);

  test("L23f: a failing step stops the rest", async () => {
    const repos = await makeRepos();
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const root = await mkdtemp(join(tmpdir(), "trial-steps-"));
      const marker = join(root, "second-ran");
      const result = await trialMerge(
        baseTrial(repos.factory, repos.root, base, head, [
          [process.execPath, "-e", "process.exit(3)"],
          [
            process.execPath,
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
          ],
        ]),
      );
      expect(result).toEqual({
        passed: false,
        reason: "step-failed",
        step: 0,
        rc: 3,
        cleanupFailed: false,
      });
      expect(
        await Bun.file(marker)
          .exists()
          .catch(() => false),
      ).toBe(false);
      await rm(root, { recursive: true, force: true });
    } finally {
      await repos.cleanup();
    }
  }, 15_000);

  test("L23g: a hanging step times out", async () => {
    const repos = await makeRepos();
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const pidFile = join(repos.root, "step.pid");
      const gcFile = join(repos.root, "gc.pid");
      await writeFile(
        join(repos.root, "step-hang.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
          `require("node:child_process").execSync(` +
          `\"sh -c 'sleep 30 & echo \\$! > ${gcFile}; wait'\", { stdio: "ignore" });\n`,
        "utf8",
      );
      const result = await trialMerge(
        baseTrial(
          repos.factory,
          repos.root,
          base,
          head,
          [[process.execPath, join(repos.root, "step-hang.js")]],
          { id: "demo-slow", timeoutMs: 3000 },
        ),
      );
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.reason).toBe("timeout");
        expect(result.step).toBe(0);
      }
      const pid = Number(await readFile(pidFile, "utf8"));
      trackedPids.push(pid);
      expect(await waitGone(pid)).toBe(true);
      const gcPid = Number(await readFile(gcFile, "utf8"));
      trackedPids.push(gcPid);
      expect(await waitGone(gcPid)).toBe(true);
      expect(await worktreeCount(repos.factory)).toBe(1);
    } finally {
      await repos.cleanup();
    }
  }, 15_000);

  test("L23h: a leftover path is cleaned, a bad id throws", async () => {
    const repos = await makeRepos();
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const scratchDir = join(repos.root, "scratch");
      await mkdir(join(scratchDir, "demo-a"), { recursive: true });
      await writeFile(join(scratchDir, "demo-a", "junk.txt"), "junk\n", "utf8");
      const trial = baseTrial(repos.factory, repos.root, base, head, [
        [process.execPath, "-e", "process.exit(0)"],
      ]);
      const result = await trialMerge(trial);
      expect(result).toEqual({ passed: true, cleanupFailed: false });
      expect(await worktreeCount(repos.factory)).toBe(1);
      await mkdir(join(repos.root, "x", "keep"), { recursive: true });
      const bad = await trialMerge({ ...trial, id: "../x" }).catch((error: unknown) => error);
      expect(bad).toBeInstanceOf(GitError);
      const keep = await stat(join(repos.root, "x", "keep")).catch((error: unknown) => error);
      expect((keep as { isDirectory(): boolean }).isDirectory()).toBe(true);
    } finally {
      await repos.cleanup();
    }
  }, 15_000);

  test("L23j: a fetch that holds the pipes still fails fast and kills the group", async () => {
    const repos = await makeRepos();
    const realDir = await realGitPath();
    const pidFile = join(repos.root, "sleep.pid");
    const gcFile = join(repos.root, "gc-fetch.pid");
    const fake = await fakeGitDir(
      realDir,
      "fetch",
      `for a in "$@"; do\n  if [ "$a" = "fetch" ]; then\n    sleep 30 > /dev/null 2>&1 &\n    echo $! > ${pidFile}\n    setsid sleep 30 &\n    echo $! > ${gcFile}\n    wait\n  fi\ndone\nexec "$REAL_GIT" "$@"`,
    );
    try {
      const start = Date.now();
      const failed = await fetchRefs(repos.factory, { PATH: fake.fakePath, timeoutMs: 300 }, [
        "+refs/heads/main:refs/remotes/origin/main",
      ]).catch((error: unknown) => error);
      const elapsed = Date.now() - start;
      expect(failed).toBeInstanceOf(GitError);
      expect((failed as GitError).kind).toBe("timeout");
      expect(elapsed).toBeLessThan(2000);
      const pid = Number(await readFile(pidFile, "utf8"));
      trackedPids.push(pid);
      expect(await waitGone(pid)).toBe(true);
      const gcPid = Number(await readFile(gcFile, "utf8"));
      trackedPids.push(gcPid);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await repos.cleanup();
    }
  }, 15_000);

  test("L23k: a step that cannot spawn is step-failed and still cleans up", async () => {
    const repos = await makeRepos();
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const trial = baseTrial(repos.factory, repos.root, base, head, [["moc-no-such-binary", "x"]]);
      const result = await trialMerge(trial);
      expect(result).toEqual({
        passed: false,
        reason: "step-failed",
        step: 0,
        rc: null,
        cleanupFailed: false,
      });
      const wt = join(trial.scratchDir, trial.id);
      const gone = await stat(wt).catch((error: unknown) => error);
      expect((gone as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect(await worktreeCount(repos.factory)).toBe(1);
    } finally {
      await repos.cleanup();
    }
  }, 15_000);

  test("L23l: one deadline covers the merge", async () => {
    const repos = await makeRepos();
    const realDir = await realGitPath();
    const fake = await fakeGitDir(
      realDir,
      "worktree",
      `for a in "$@"; do\n  if [ "$a" = "merge" ]; then\n    sleep 0.6\n  elif [ "$a" = "worktree" ]; then\n    case "$*" in\n      *" add "*) sleep 0.6;;\n    esac\n  fi\ndone\nexec "$REAL_GIT" "$@"`,
    );
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const trial = baseTrial(
        repos.factory,
        repos.root,
        base,
        head,
        [[process.execPath, "-e", "process.exit(0)"]],
        { id: "demo-deadline", timeoutMs: 1000, PATH: fake.fakePath },
      );
      const t0 = Date.now();
      const result = await trialMerge(trial);
      expect(result).toEqual({
        passed: false,
        reason: "timeout",
        step: null,
        rc: null,
        cleanupFailed: false,
      });
      expect(Date.now() - t0).toBeLessThan(2 * trial.timeoutMs + 1000);
      const gone = await stat(join(trial.scratchDir, trial.id)).catch((error: unknown) => error);
      expect((gone as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect(await worktreeCount(repos.factory)).toBe(1);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await repos.cleanup();
    }
  }, 15_000);

  test("L23n: a slow step 1 or step 2 reports timeout", async () => {
    const repos = await makeRepos();
    const realDir = await realGitPath();
    const revFake = await fakeGitDir(
      realDir,
      "rev-parse",
      `for a in "$@"; do\n  if [ "$a" = "rev-parse" ]; then\n    sleep 3\n  fi\ndone\nexec "$REAL_GIT" "$@"`,
    );
    const pruneFake = await fakeGitDir(
      realDir,
      "worktree-prune",
      `MARKER="$(dirname "$0")/spent"\nfor a in "$@"; do\n  if [ "$a" = "prune" ] && [ ! -e "$MARKER" ]; then\n    touch "$MARKER"\n    sleep 3\n  fi\ndone\nexec "$REAL_GIT" "$@"`,
    );
    const removeFake = await fakeGitDir(
      realDir,
      "worktree-remove",
      `MARKER="$(dirname "$0")/spent"\nfor a in "$@"; do\n  if [ "$a" = "remove" ] && [ ! -e "$MARKER" ]; then\n    touch "$MARKER"\n    sleep 3\n  fi\ndone\nexec "$REAL_GIT" "$@"`,
    );
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const noTrial = async (extra: Partial<TrialInput>): Promise<TrialResult> =>
        trialMerge(
          baseTrial(repos.factory, repos.root, base, head, [], {
            id: "demo-n",
            timeoutMs: 1000,
            ...extra,
          }),
        );
      // A step-2 rev-parse past the deadline resolves, never rejects.
      const revSlow = await noTrial({ PATH: revFake.fakePath });
      expect(revSlow).toEqual({
        passed: false,
        reason: "timeout",
        step: null,
        rc: null,
        cleanupFailed: false,
      });
      // An absent path whose step-1 prune hangs resolves to timeout.
      const pruneSlow = await noTrial({ PATH: pruneFake.fakePath });
      expect(pruneSlow).toEqual({
        passed: false,
        reason: "timeout",
        step: null,
        rc: null,
        cleanupFailed: false,
      });
      // A leftover path whose step-1 remove hangs resolves to timeout.
      const scratchDir = join(repos.root, "scratch");
      await mkdir(join(scratchDir, "demo-n"), { recursive: true });
      const removeSlow = await noTrial({ PATH: removeFake.fakePath });
      expect(removeSlow).toEqual({
        passed: false,
        reason: "timeout",
        step: null,
        rc: null,
        cleanupFailed: false,
      });
    } finally {
      await rm(revFake.dir, { recursive: true, force: true });
      await rm(pruneFake.dir, { recursive: true, force: true });
      await rm(removeFake.dir, { recursive: true, force: true });
      await repos.cleanup();
    }
  }, 15_000);

  test("L23o: a hanging merge ends within two budgets", async () => {
    const repos = await makeRepos();
    const realDir = await realGitPath();
    const fake = await fakeGitDir(
      realDir,
      "worktree-merge",
      `for a in "$@"; do\n  if [ "$a" = "merge" ]; then\n    sleep 10\n  elif [ "$a" = "remove" ] || [ "$a" = "prune" ]; then\n    sleep 5\n  fi\ndone\nexec "$REAL_GIT" "$@"`,
    );
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const t0 = Date.now();
      const result = await trialMerge(
        baseTrial(repos.factory, repos.root, base, head, [], {
          id: "demo-o",
          timeoutMs: 2000,
          PATH: fake.fakePath,
        }),
      );
      const elapsed = Date.now() - t0;
      expect(result.reason ?? "passed").toBe("timeout");
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.step).toBeNull();
        expect(result.rc).toBeNull();
      }
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await repos.cleanup();
    }
  }, 15_000);

  test("L23m: a relative scratch dir throws before any removal", async () => {
    const repos = await makeRepos();
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const trial = baseTrial(repos.factory, repos.root, base, head, [], {
        scratchDir: "logs/trial",
      });
      const failed = await trialMerge(trial).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(GitError);
      expect((failed as GitError).kind).toBe("failed");
      expect((failed as GitError).rc).toBeNull();
      expect((failed as GitError).message).toContain("scratchDir");
      expect((failed as GitError).message).toContain("absolute");
      const created = await stat(join(repos.factory, "logs", "trial")).catch(
        (error: unknown) => error,
      );
      expect((created as NodeJS.ErrnoException).code).toBe("ENOENT");
    } finally {
      await repos.cleanup();
    }
  }, 15_000);

  test("L4: a failing step-6 remove still reports the passing result", async () => {
    const repos = await makeRepos();
    const realDir = await realGitPath();
    const fake = await fakeGitDir(
      realDir,
      "worktree-remove",
      `for a in "$@"; do\n  if [ "$a" = "remove" ]; then\n    echo "fake: cannot remove" >&2\n    exit 1\n  fi\ndone\nexec "$REAL_GIT" "$@"`,
    );
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const trial = baseTrial(
        repos.factory,
        repos.root,
        base,
        head,
        [[process.execPath, "-e", "process.exit(0)"]],
        { id: "demo-l4", PATH: fake.fakePath },
      );
      const result = await trialMerge(trial);
      expect(result).toEqual({ passed: true, cleanupFailed: true });
      expect(await worktreeCount(repos.factory)).toBe(1);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await repos.cleanup();
    }
  }, 15_000);

  test("L23i: trial steps see only PATH and HOME", async () => {
    const repos = await makeRepos();
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      process.env["MOC_GITHUB_TOKEN"] = "probe-token";
      const out = await mkdtemp(join(tmpdir(), "trial-env-"));
      const dump = join(out, "env.json");
      const result = await trialMerge(
        baseTrial(repos.factory, repos.root, base, head, [
          [
            process.execPath,
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(Object.keys(process.env).sort()))`,
          ],
        ]),
      );
      expect(result).toEqual({ passed: true, cleanupFailed: false });
      const keys = JSON.parse(await Bun.file(dump).text()) as string[];
      expect(keys).toContain("PATH");
      expect(keys).toContain("HOME");
      expect(keys).not.toContain("GH_TOKEN");
      expect(keys).not.toContain("MOC_GITHUB_TOKEN");
      expect(keys.some((key) => key.startsWith("GIT_"))).toBe(false);
      expect(keys.some((key) => key.startsWith("MOC_"))).toBe(false);
      delete process.env["MOC_GITHUB_TOKEN"];
      await rm(out, { recursive: true, force: true });
    } finally {
      delete process.env["MOC_GITHUB_TOKEN"];
      await repos.cleanup();
    }
  }, 15_000);
});

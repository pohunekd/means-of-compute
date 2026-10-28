// Git runner tests (PR 4 matrix rows L23a-L23i): real git in temp repos,
// J4 line shapes, branch checks, ancestry and the full trial lifecycle.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  });

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
  });

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
  });

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
      expect(
        await Bun.file(wt)
          .exists()
          .catch(() => false),
      ).toBe(false);
      expect(await worktreeCount(repos.factory)).toBe(1);
    } finally {
      await repos.cleanup();
    }
  });

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
    } finally {
      await repos.cleanup();
    }
  });

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
  });

  test("L23g: a hanging step times out", async () => {
    const repos = await makeRepos();
    try {
      const { base, head } = await pushBranch(repos, "moc/demo-a");
      const result = await trialMerge(
        baseTrial(
          repos.factory,
          repos.root,
          base,
          head,
          [[process.execPath, "-e", "setInterval(() => {}, 1000)"]],
          { id: "demo-slow", timeoutMs: 400 },
        ),
      );
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.reason).toBe("timeout");
        expect(result.step).toBe(0);
      }
    } finally {
      await repos.cleanup();
    }
  });

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
      const bad = await trialMerge({ ...trial, id: "../x" }).catch((error: unknown) => error);
      expect(bad).toBeInstanceOf(GitError);
    } finally {
      await repos.cleanup();
    }
  });

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
  });
});

// Local git runner: fetch, branch checks, ancestry and trial merges run
// through one spawner with a fixed env, a bounded wait and no shell.
import { rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export type GitErrorKind = "failed" | "timeout" | "invalid-output";

export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly step: string;
  readonly rc: number | null;
  readonly detail?: string;
  constructor(
    kind: GitErrorKind,
    step: string,
    message: string,
    rc: number | null,
    detail?: string,
  ) {
    super(message);
    this.name = "GitError";
    this.kind = kind;
    this.step = step;
    this.rc = rc;
    this.detail = detail;
  }
}

export interface GitDeps {
  readonly PATH: string;
  readonly timeoutMs: number;
}

export interface TrialInput {
  readonly dir: string;
  readonly scratchDir: string;
  readonly id: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly steps: readonly (readonly string[])[];
  readonly timeoutMs: number;
  readonly PATH: string;
  readonly HOME: string;
}

export type TrialResult =
  | { readonly passed: true; readonly cleanupFailed: boolean }
  | {
      readonly passed: false;
      readonly reason: "conflict" | "step-failed" | "timeout";
      readonly step: number | null;
      readonly rc: number | null;
      readonly cleanupFailed: boolean;
    };

const ALLOWED = new Set(["fetch", "ls-remote", "rev-parse", "merge-base", "worktree", "merge"]);
const CONFLICT_LINE = "Automatic merge failed; fix conflicts and then commit the result.";

// The same 6-line cut as the gh port: at most max bytes, never split a char.
function utf8Prefix(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) {
    return text;
  }
  let end = max;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

interface GitOutput {
  readonly rc: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GitSpawn {
  readonly argv: readonly string[];
  readonly allowed: string | undefined;
}

// `-c key value` pairs sit before `-C <dir>`; find the subcommand after them.
function splitGitArgs(args: readonly string[]): GitSpawn {
  let index = 0;
  while (args[index] === "-c") {
    index += 3;
  }
  return { argv: args, allowed: args[index] };
}

async function runGit(
  dir: string,
  deps: GitDeps,
  step: string,
  args: readonly string[],
): Promise<GitOutput> {
  return runGitAt([], dir, deps, step, args);
}

async function runGitAt(
  prefix: readonly string[],
  dir: string,
  deps: GitDeps,
  step: string,
  args: readonly string[],
): Promise<GitOutput> {
  const { argv, allowed } = splitGitArgs(args);
  if (allowed === undefined || !ALLOWED.has(allowed)) {
    throw new GitError("failed", step, `${step}: blocked subcommand`, null);
  }
  const proc = Bun.spawn(["git", ...prefix, "-C", dir, ...argv], {
    env: {
      PATH: deps.PATH,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // The child already exited; the timeout error below carries the failure.
    }
  }, deps.timeoutMs);
  try {
    const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
    const stderrPromise = new Response(proc.stderr as ReadableStream).text();
    const rc = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (state.timedOut) {
      throw new GitError("timeout", step, `${step}: timed out`, null);
    }
    return { rc, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function detailOf(stderr: string): string {
  return utf8Prefix(stderr, 300);
}

export async function fetchRefs(
  dir: string,
  deps: GitDeps,
  refspecs: readonly string[],
): Promise<void> {
  const step = "fetchRefs";
  const { rc, stderr } = await runGit(dir, deps, step, [
    "fetch",
    "--no-tags",
    "origin",
    ...refspecs,
  ]);
  if (rc !== 0) {
    throw new GitError(
      "failed",
      step,
      `${step}: git fetch exited ${String(rc)}`,
      rc,
      detailOf(stderr),
    );
  }
}

export function parseLsRemote(stdout: string, branch: string): string | null {
  if (stdout === "") {
    return null;
  }
  const expected = `refs/heads/${branch}`;
  // ls-remote prints one TAB-separated line per ref plus one LF.
  const match = /^([0-9a-f]{40})\t([^\n]*)\n$/.exec(stdout);
  const sha = match?.[1];
  if (match === null || sha === undefined || match[2] !== expected) {
    throw new GitError(
      "invalid-output",
      "remoteBranchSha",
      "remoteBranchSha: bad ls-remote line",
      0,
    );
  }
  return sha;
}

export async function remoteBranchSha(
  dir: string,
  deps: GitDeps,
  branch: string,
): Promise<string | null> {
  const step = "remoteBranchSha";
  const { rc, stdout, stderr } = await runGit(dir, deps, step, [
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ]);
  if (rc !== 0) {
    throw new GitError(
      "failed",
      step,
      `${step}: git ls-remote exited ${String(rc)}`,
      rc,
      detailOf(stderr),
    );
  }
  return parseLsRemote(stdout, branch);
}

export async function revParse(dir: string, deps: GitDeps, ref: string): Promise<string> {
  const step = "revParse";
  const { rc, stdout, stderr } = await runGit(dir, deps, step, [
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]);
  if (rc !== 0) {
    throw new GitError(
      "failed",
      step,
      `${step}: git rev-parse exited ${String(rc)}`,
      rc,
      detailOf(stderr),
    );
  }
  const match = /^([0-9a-f]{40})\n$/.exec(stdout);
  const sha = match?.[1];
  if (match === null || sha === undefined) {
    throw new GitError("invalid-output", step, `${step}: rev-parse gave no sha`, rc);
  }
  return sha;
}

export async function isAncestor(
  dir: string,
  deps: GitDeps,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const step = "isAncestor";
  const { rc, stderr } = await runGit(dir, deps, step, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (rc === 0) {
    return true;
  }
  if (rc === 1) {
    return false;
  }
  throw new GitError(
    "failed",
    step,
    `${step}: git merge-base exited ${String(rc)}`,
    rc,
    detailOf(stderr),
  );
}

interface TrialStepResult {
  readonly done: boolean;
  readonly failed: TrialResult | null;
}

// J2 step 1 guard: only the named id directory inside the scratch dir may go.
function checkWorktreePath(wt: string, scratchDir: string, id: string): void {
  if (id === "" || id === "." || id === ".." || basename(id) !== id) {
    throw new GitError("failed", "trialMerge", "trialMerge: bad worktree id", null);
  }
  if (wt !== `${scratchDir}/${id}` && wt !== join(resolve(scratchDir), id)) {
    throw new GitError(
      "failed",
      "trialMerge",
      "trialMerge: worktree escapes the scratch dir",
      null,
    );
  }
  if (resolve(wt) !== join(resolve(scratchDir), id)) {
    throw new GitError(
      "failed",
      "trialMerge",
      "trialMerge: worktree escapes the scratch dir",
      null,
    );
  }
}

async function removePath(wt: string, scratchDir: string, id: string): Promise<void> {
  checkWorktreePath(wt, scratchDir, id);
  await rm(wt, { recursive: true, force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// One deadline covers steps 3 to 5: a running step is killed at the deadline.
async function runTrialStep(
  argv: readonly string[],
  wt: string,
  env: { readonly PATH: string; readonly HOME: string },
  deadline: number,
): Promise<{ readonly rc: number; readonly timedOut: boolean }> {
  const proc = Bun.spawn([...argv], { cwd: wt, env, stdin: "ignore" });
  const wait = proc.exited.then(
    (rc) => ({ rc, timedOut: false as const }),
    () => ({ rc: -1, timedOut: false as const }),
  );
  const delay = Math.max(0, deadline - Date.now());
  const timeout = new Promise<{ readonly rc: number; readonly timedOut: boolean }>(
    (resolvePromise) => {
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The step already exited; the race below picks the exit.
        }
        resolvePromise({ rc: -1, timedOut: true });
      }, delay);
    },
  );
  return Promise.race([wait, timeout]);
}

export async function trialMerge(input: TrialInput): Promise<TrialResult> {
  const step = "trialMerge";
  // Join without normalization so the J2 guard sees a bad id.
  const wt = `${input.scratchDir}/${input.id}`;
  const start = Date.now();
  const deadline = start + input.timeoutMs;
  const gitDeps: GitDeps = { PATH: input.PATH, timeoutMs: input.timeoutMs };
  let cleanupFailed = false;
  const markCleanupFailed = (): void => {
    cleanupFailed = true;
  };

  // Leftover recovery before any other work.
  checkWorktreePath(wt, input.scratchDir, input.id);
  if (await pathExists(wt)) {
    const leftover = await runGit(input.dir, gitDeps, step, ["worktree", "remove", "--force", wt]);
    if (leftover.rc !== 0 && leftover.rc !== 128) {
      throw new GitError(
        "failed",
        step,
        `${step}: leftover remove exited ${String(leftover.rc)}`,
        leftover.rc,
        detailOf(leftover.stderr),
      );
    }
    await removePath(wt, input.scratchDir, input.id);
    const pruned = await runGit(input.dir, gitDeps, step, ["worktree", "prune"]);
    if (pruned.rc !== 0) {
      throw new GitError(
        "failed",
        step,
        `${step}: worktree prune exited ${String(pruned.rc)}`,
        pruned.rc,
        detailOf(pruned.stderr),
      );
    }
  }

  async function cleanupWorktree(): Promise<void> {
    try {
      await runGit(input.dir, gitDeps, step, ["worktree", "remove", "--force", wt]);
    } catch {
      markCleanupFailed();
    }
    try {
      if (await pathExists(wt)) {
        await removePath(wt, input.scratchDir, input.id);
        await runGit(input.dir, gitDeps, step, ["worktree", "prune"]);
      }
    } catch {
      markCleanupFailed();
    }
  }

  // Steps 2 to 4 run under cleanup: a GitError still removes the worktree.
  let conflict: { readonly rc: number } | null = null;
  try {
    // A bad head ref fails here, before the merge (H4).
    await revParse(input.dir, gitDeps, input.headSha);
    const added = await runGit(input.dir, gitDeps, step, [
      "worktree",
      "add",
      "--detach",
      wt,
      input.baseSha,
    ]);
    if (added.rc !== 0) {
      throw new GitError(
        "failed",
        step,
        `${step}: worktree add exited ${String(added.rc)}`,
        added.rc,
        detailOf(added.stderr),
      );
    }
    const merged = await runGitAt(
      ["-c", "user.name=moc-trial", "-c", "user.email=trial@example.invalid"],
      wt,
      gitDeps,
      step,
      ["merge", "--no-ff", "--no-edit", input.headSha],
    );
    if (merged.rc === 1 && merged.stdout.split("\n").includes(CONFLICT_LINE)) {
      conflict = { rc: merged.rc };
    } else if (merged.rc !== 0) {
      throw new GitError(
        "failed",
        step,
        `${step}: merge exited ${String(merged.rc)}`,
        merged.rc,
        detailOf(merged.stderr),
      );
    }
  } catch (error: unknown) {
    await cleanupWorktree();
    throw error;
  }
  if (conflict !== null) {
    await cleanupWorktree();
    return { passed: false, reason: "conflict", step: null, rc: conflict.rc, cleanupFailed };
  }

  const trialSteps: TrialStepResult = await (async (): Promise<TrialStepResult> => {
    for (let index = 0; index < input.steps.length; index += 1) {
      const argv = input.steps[index];
      if (argv === undefined) {
        continue;
      }
      const outcome = await runTrialStep(
        argv,
        wt,
        { PATH: input.PATH, HOME: input.HOME },
        deadline,
      );
      if (outcome.timedOut) {
        return {
          done: false,
          failed: { passed: false, reason: "timeout", step: index, rc: null, cleanupFailed: false },
        };
      }
      if (outcome.rc !== 0) {
        return {
          done: false,
          failed: {
            passed: false,
            reason: "step-failed",
            step: index,
            rc: outcome.rc,
            cleanupFailed: false,
          },
        };
      }
    }
    return { done: true, failed: null };
  })();
  await cleanupWorktree();
  if (!trialSteps.done && trialSteps.failed !== null) {
    return { ...trialSteps.failed, cleanupFailed };
  }
  return { passed: true, cleanupFailed };
}

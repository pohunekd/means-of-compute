// Local git runner: fetch, branch checks, ancestry and trial merges run
// through one spawner with a fixed env, a bounded wait and no shell.
import { rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

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

// The identity flags travel in the spawn prefix, so args[0] is the subcommand.
function splitGitArgs(args: readonly string[]): GitSpawn {
  return { argv: args, allowed: args[0] };
}

async function runGit(
  dir: string,
  deps: GitDeps,
  step: string,
  args: readonly string[],
): Promise<GitOutput> {
  return runGitAt([], dir, deps, step, args, deps.timeoutMs);
}

function requireAbsoluteDir(field: string, step: string, value: string): void {
  if (!isAbsolute(value)) {
    throw new GitError("failed", step, `${step}: ${field} must be absolute`, null);
  }
}

type ReaderResult =
  { done: false; value: Uint8Array } | { done: true; value: Uint8Array | undefined };

async function collectReader(reader: {
  read(): Promise<ReaderResult>;
  releaseLock(): void;
}): Promise<string> {
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runGitAt(
  prefix: readonly string[],
  dir: string,
  deps: GitDeps,
  step: string,
  args: readonly string[],
  timeoutMs: number,
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
    detached: true,
  });
  const outReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const errReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const outText = collectReader(outReader);
  const errText = collectReader(errReader);
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // The child already exited; the timeout error below carries the failure.
    }
    void outReader.cancel().catch(() => {
      // The pipe already closed; the collected chunks carry the output.
    });
    void errReader.cancel().catch(() => {
      // The pipe already closed; the collected chunks carry the output.
    });
  }, timeoutMs);
  try {
    const rc = await proc.exited;
    const timedOut = state.timedOut;
    const [stdout, stderr] = timedOut ? ["", ""] : await Promise.all([outText, errText]);
    if (timedOut) {
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

class TrialTimeout extends Error {
  constructor() {
    super("trialMerge: deadline hit");
    this.name = "TrialTimeout";
  }
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

// A trial step runs in its own process group; at the deadline the group dies.
async function runTrialStep(
  argv: readonly string[],
  wt: string,
  env: { readonly PATH: string; readonly HOME: string },
  timeoutMs: number,
): Promise<{ readonly type: "exit"; readonly rc: number } | { readonly type: "timeout" }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], { cwd: wt, env, stdin: "ignore", detached: true });
  } catch {
    return { type: "exit", rc: -2 };
  }
  const current = proc;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = current.exited.then(
    (rc) => ({ type: "exit" as const, rc }),
    () => ({ type: "exit" as const, rc: -1 }),
  );
  const timeout = new Promise<{ readonly type: "timeout" }>((resolvePromise) => {
    timer = setTimeout(() => {
      try {
        process.kill(-current.pid, "SIGKILL");
      } catch {
        // The step already exited; the race below picks the exit.
      }
      resolvePromise({ type: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([wait, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Remaining budget of the single trial deadline, never negative.
function deadlineTimeout(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

export async function trialMerge(input: TrialInput): Promise<TrialResult> {
  const step = "trialMerge";
  // Join without normalization so the J2 guard sees a bad id.
  requireAbsoluteDir("dir", step, input.dir);
  requireAbsoluteDir("scratchDir", step, input.scratchDir);
  const wt = `${input.scratchDir}/${input.id}`;
  // The J2 guard runs before any git call, spawn or removal, so a bad id
  // throws before the try and never reaches step 6.
  checkWorktreePath(wt, input.scratchDir, input.id);
  // One deadline, set at entry, covers steps 1 to 5.
  const deadline = Date.now() + input.timeoutMs;
  let cleanupFailed = false;

  async function checkedRunGit(
    dir: string,
    timeoutMs: number,
    args: readonly string[],
  ): Promise<GitOutput> {
    try {
      return await runGit(dir, { PATH: input.PATH, timeoutMs }, step, args);
    } catch (error: unknown) {
      if (error instanceof GitError && error.kind === "timeout") {
        throw new TrialTimeout();
      }
      throw error;
    }
  }

  async function mergeCall(): Promise<GitOutput> {
    const budget = deadlineTimeout(deadline);
    try {
      return await runGitAt(
        ["-c", "user.name=moc-trial", "-c", "user.email=trial@example.invalid"],
        wt,
        { PATH: input.PATH, timeoutMs: budget },
        step,
        ["merge", "--no-ff", "--no-edit", input.headSha],
        budget,
      );
    } catch (error: unknown) {
      if (error instanceof GitError && error.kind === "timeout") {
        throw new TrialTimeout();
      }
      throw error;
    }
  }

  // Step 1 (leftover recovery and the absent-path prune) runs on the main
  // deadline: a deadline hit resolves to the timeout result, never a throw.
  async function step1(): Promise<void> {
    checkWorktreePath(wt, input.scratchDir, input.id);
    if (await pathExists(wt)) {
      const leftover = await checkedRunGit(input.dir, deadlineTimeout(deadline), [
        "worktree",
        "remove",
        "--force",
        wt,
      ]);
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
      const pruned = await checkedRunGit(input.dir, deadlineTimeout(deadline), [
        "worktree",
        "prune",
      ]);
      if (pruned.rc !== 0) {
        throw new GitError(
          "failed",
          step,
          `${step}: worktree prune exited ${String(pruned.rc)}`,
          pruned.rc,
          detailOf(pruned.stderr),
        );
      }
    } else {
      const pruned = await checkedRunGit(input.dir, deadlineTimeout(deadline), [
        "worktree",
        "prune",
      ]);
      if (pruned.rc !== 0) {
        cleanupFailed = true;
      }
    }
  }

  async function step6(started: number): Promise<void> {
    // Step 6 cleanup shares one budget that starts when step 6 starts.
    const cleanupDeadline = started + input.timeoutMs;
    const budget = (): number => deadlineTimeout(cleanupDeadline);
    const seen = await pathExists(wt);
    try {
      if (seen) {
        const removed = await runGit(input.dir, { PATH: input.PATH, timeoutMs: budget() }, step, [
          "worktree",
          "remove",
          "--force",
          wt,
        ]);
        // rc 128 means no registered worktree (a plain leftover dir);
        // the fallback below removes the path and prunes.
        if (removed.rc !== 0 && removed.rc !== 128) {
          cleanupFailed = true;
        }
      } else {
        const pruned = await runGit(input.dir, { PATH: input.PATH, timeoutMs: budget() }, step, [
          "worktree",
          "prune",
        ]);
        if (pruned.rc !== 0) {
          cleanupFailed = true;
        }
      }
    } catch {
      cleanupFailed = true;
    }
    try {
      if (await pathExists(wt)) {
        await removePath(wt, input.scratchDir, input.id);
        const pruned = await runGit(input.dir, { PATH: input.PATH, timeoutMs: budget() }, step, [
          "worktree",
          "prune",
        ]);
        if (pruned.rc !== 0) {
          cleanupFailed = true;
        }
      }
    } catch {
      cleanupFailed = true;
    }
  }

  async function step2(): Promise<
    | { readonly kind: "added-failed"; readonly addedRc: number; readonly addedStderr: string }
    | { readonly kind: "merged"; readonly merged: GitOutput }
    | { readonly kind: "timeout" }
  > {
    const revDeps: GitDeps = { PATH: input.PATH, timeoutMs: deadlineTimeout(deadline) };
    try {
      await revParse(input.dir, revDeps, input.headSha);
    } catch (error: unknown) {
      if (error instanceof GitError && error.kind === "timeout") {
        return { kind: "timeout" };
      }
      throw error;
    }
    const added = await checkedRunGit(input.dir, deadlineTimeout(deadline), [
      "worktree",
      "add",
      "--detach",
      wt,
      input.baseSha,
    ]);
    if (added.rc !== 0) {
      return { kind: "added-failed", addedRc: added.rc, addedStderr: added.stderr };
    }
    return { kind: "merged", merged: await mergeCall() };
  }

  type TrialOutcome =
    | { readonly passed: true }
    | {
        readonly passed: false;
        readonly reason: "conflict" | "step-failed" | "timeout";
        readonly step: number | null;
        readonly rc: number | null;
      };

  // Steps 1 to 5 run inside one try; step 6 cleanup runs after and the
  // result is built last so the cleanup flag reaches the caller (the
  // return object is assembled after step 6 finishes).
  let outcome: TrialOutcome;
  try {
    // A bad head ref fails here, before the merge (H4).
    await step1();
    const second = await step2();
    if (second.kind === "timeout") {
      outcome = { passed: false, reason: "timeout", step: null, rc: null };
    } else if (second.kind === "added-failed") {
      throw new GitError(
        "failed",
        step,
        `${step}: worktree add exited ${String(second.addedRc)}`,
        second.addedRc,
        detailOf(second.addedStderr),
      );
    } else {
      const merged = second.merged;
      if (merged.rc === 1 && merged.stdout.split("\n").includes(CONFLICT_LINE)) {
        outcome = {
          passed: false,
          reason: "conflict",
          step: null,
          rc: merged.rc,
        };
      } else if (merged.rc !== 0) {
        throw new GitError(
          "failed",
          step,
          `${step}: merge exited ${String(merged.rc)}`,
          merged.rc,
          detailOf(merged.stderr),
        );
      } else {
        let stepOutcome: TrialOutcome = { passed: true };
        for (let index = 0; index < input.steps.length; index += 1) {
          const argv = input.steps[index];
          if (argv === undefined) {
            continue;
          }
          const ran = await runTrialStep(
            argv,
            wt,
            { PATH: input.PATH, HOME: input.HOME },
            deadlineTimeout(deadline),
          );
          if (ran.type === "timeout") {
            stepOutcome = { passed: false, reason: "timeout", step: index, rc: null };
            break;
          }
          if (ran.rc === -2) {
            stepOutcome = { passed: false, reason: "step-failed", step: index, rc: null };
            break;
          }
          if (ran.rc !== 0) {
            stepOutcome = {
              passed: false,
              reason: "step-failed",
              step: index,
              rc: ran.rc,
            };
            break;
          }
        }
        outcome = stepOutcome;
      }
    }
  } catch (error: unknown) {
    if (error instanceof TrialTimeout) {
      outcome = { passed: false, reason: "timeout", step: null, rc: null };
    } else {
      await step6(Date.now());
      throw error;
    }
  }
  await step6(Date.now());
  if (outcome.passed) {
    return { passed: true, cleanupFailed };
  }
  return { ...outcome, cleanupFailed };
}

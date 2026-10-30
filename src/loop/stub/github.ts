// In-memory GitHub stub over a sandbox origin.git: PRs, issues and
// comments live in maps while refs and merges run real git commands.
import { rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { GitError, isAncestor, revParse, type GitDeps } from "../git.js";
import {
  GitHubError,
  utf8Prefix,
  type CheckAnnotation,
  type CheckRun,
  type CommentFirstLine,
  type GitHubPort,
  type IssueFirstLine,
  type IntakeIssue,
  type PullRow,
  type PullView,
} from "../github.js";

export type StubCi = "success" | "failure" | "pending";

export interface StubGitHubOptions {
  readonly repo: string;
  readonly originDir: string;
  readonly baseBranch: string;
  readonly factoryLogin: string;
  readonly git: GitDeps;
  readonly scratchDir: string;
  readonly ci: (sha: string) => StubCi;
  readonly annotations?: (checkRunId: number) => readonly CheckAnnotation[];
}

export interface StubGitHubSnapshot {
  readonly pulls: readonly {
    number: number;
    head: string;
    base: string;
    title: string;
    body: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    mergedHead: string | null;
    mergeCommit: string | null;
  }[];
  readonly issues: readonly {
    number: number;
    title: string;
    body: string;
    labels: readonly string[];
  }[];
  readonly comments: readonly { number: number; login: string; body: string }[];
}

interface StubPull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedHead: string | null;
  mergeCommit: string | null;
}

interface StubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  authorAssociation: string;
  state: "open" | "closed";
}
export interface StubIssueSeed {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly authorAssociation: string;
  readonly state: "open" | "closed";
}

interface StubComment {
  number: number;
  login: string;
  body: string;
}

const EXTRA_ALLOWED = new Set(["update-ref", "rev-list"]);

interface StubGitOutput {
  readonly rc: number;
  readonly stdout: string;
  readonly stderr: string;
}

// A git failure maps to the port kinds: unknown ref or sha is rejected,
// any other failure is unavailable. The original message goes to detail.
function mapGitError(step: string, error: unknown): GitHubError {
  if (error instanceof GitError) {
    const kind = error.kind === "failed" && error.rc === 128 ? "rejected" : "unavailable";
    return new GitHubError(kind, step, `${step}: ${error.message}`, error.message);
  }
  throw error;
}

// The stub allowlist adds update-ref and rev-list next to the leaf set.
// The identity flags travel in the prefix, so args[0] is the subcommand.
async function runStubGit(
  dir: string,
  deps: GitDeps,
  step: string,
  args: readonly string[],
  prefix: readonly string[] = [],
): Promise<StubGitOutput> {
  const sub = args[0];
  const leaf = new Set(["fetch", "ls-remote", "rev-parse", "merge-base", "worktree", "merge"]);
  if (sub === undefined || (!leaf.has(sub) && !EXTRA_ALLOWED.has(sub))) {
    throw new GitHubError("rejected", step, `${step}: blocked subcommand`);
  }
  const proc = Bun.spawn(["git", ...prefix, "-C", dir, ...args], {
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
  const outStream = proc.stdout as ReadableStream<Uint8Array>;
  const errStream = proc.stderr as ReadableStream<Uint8Array>;
  const outReader = outStream.getReader();
  const errReader = errStream.getReader();
  const outText = collectStubReader(outReader);
  const errText = collectStubReader(errReader);
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
  }, deps.timeoutMs);
  try {
    const rc = await proc.exited;
    const timedOut = state.timedOut;
    const [stdout, stderr] = timedOut ? ["", ""] : await Promise.all([outText, errText]);
    if (timedOut) {
      throw new GitHubError("unavailable", step, `${step}: timed out`);
    }
    return { rc, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

type ReaderResult =
  { done: false; value: Uint8Array } | { done: true; value: Uint8Array | undefined };

async function collectStubReader(reader: {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function casUpdateRef(
  originDir: string,
  git: GitDeps,
  ref: string,
  next: string,
  old: string,
): Promise<void> {
  const { rc, stderr } = await runStubGit(originDir, git, "mergePull", [
    "update-ref",
    ref,
    next,
    old,
  ]);
  if (rc !== 0) {
    throw new GitHubError(
      "rejected",
      "mergePull",
      `mergePull: update-ref exited ${String(rc)}`,
      utf8Prefix(stderr, 300),
    );
  }
}

export function createStubGitHub(options: StubGitHubOptions): GitHubPort & {
  seedIssue(seed: StubIssueSeed): number;
  snapshot(): StubGitHubSnapshot;
} {
  if (!isAbsolute(options.originDir)) {
    throw new GitError(
      "failed",
      "createStubGitHub",
      "createStubGitHub: originDir must be absolute",
      null,
    );
  }
  if (!isAbsolute(options.scratchDir)) {
    throw new GitError(
      "failed",
      "createStubGitHub",
      "createStubGitHub: scratchDir must be absolute",
      null,
    );
  }
  let next = 1;
  let checkId = 0;
  const pulls = new Map<number, StubPull>();
  const issues = new Map<number, StubIssue>();
  const comments = new Map<number, StubComment[]>();

  function requireRepo(step: string, repo: string): void {
    if (repo !== options.repo) {
      throw new GitHubError("rejected", step, `${step}: unknown repo`);
    }
  }

  function requirePull(step: string, pull: number): StubPull {
    const row = pulls.get(pull);
    if (row === undefined) {
      throw new GitHubError("rejected", step, `${step}: unknown pull`);
    }
    return row;
  }

  function requireIssue(step: string, issue: number): StubIssue {
    const row = issues.get(issue);
    if (row === undefined) {
      throw new GitHubError("rejected", step, `${step}: unknown issue`);
    }
    return row;
  }

  function snapshot(): StubGitHubSnapshot {
    const ordered = [...pulls.values()].sort((a, b) => a.number - b.number);
    const orderedIssues = [...issues.values()].sort((a, b) => a.number - b.number);
    const orderedComments: StubComment[] = [];
    for (const number of [...comments.keys()].sort((a, b) => a - b)) {
      for (const comment of comments.get(number) ?? []) {
        orderedComments.push({ ...comment });
      }
    }
    return {
      pulls: ordered.map((pull) => ({
        number: pull.number,
        head: pull.head,
        base: pull.base,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        mergedHead: pull.mergedHead,
        mergeCommit: pull.mergeCommit,
      })),
      issues: orderedIssues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels],
      })),
      comments: orderedComments,
    };
  }

  function viewerLogin(): Promise<string> {
    return Promise.resolve(options.factoryLogin);
  }

  async function checkRuns(repo: string, sha: string): Promise<readonly CheckRun[]> {
    requireRepo("checkRuns", repo);
    const baseRef = `refs/heads/${options.baseBranch}`;
    try {
      if (await isAncestor(options.originDir, options.git, sha, baseRef)) {
        checkId += 1;
        return [{ id: checkId, name: "gates", status: "completed", conclusion: "success" }];
      }
    } catch (error: unknown) {
      throw mapGitError("checkRuns", error);
    }
    const outcome = options.ci(sha);
    if (outcome === "pending") {
      return [];
    }
    checkId += 1;
    return [{ id: checkId, name: "gates", status: "completed", conclusion: outcome }];
  }

  async function checkAnnotations(
    repo: string,
    checkRunId: number,
  ): Promise<readonly CheckAnnotation[]> {
    requireRepo("checkAnnotations", repo);
    await Promise.resolve();
    return options.annotations?.(checkRunId) ?? [];
  }

  async function commentFirstLines(
    repo: string,
    number: number,
  ): Promise<readonly CommentFirstLine[]> {
    requireRepo("commentFirstLines", repo);
    await Promise.resolve();
    if (!pulls.has(number) && !issues.has(number)) {
      throw new GitHubError("rejected", "commentFirstLines", "commentFirstLines: unknown number");
    }
    return (comments.get(number) ?? []).map((comment) => ({
      login: comment.login,
      first: comment.body.split("\n")[0] ?? "",
    }));
  }

  async function postComment(repo: string, number: number, body: string): Promise<void> {
    requireRepo("postComment", repo);
    await Promise.resolve();
    if (!pulls.has(number) && !issues.has(number)) {
      throw new GitHubError("rejected", "postComment", "postComment: unknown number");
    }
    const list = comments.get(number) ?? [];
    list.push({ number, login: options.factoryLogin, body });
    comments.set(number, list);
  }

  async function liveHead(step: string, branch: string): Promise<string> {
    try {
      return await revParse(options.originDir, options.git, `refs/heads/${branch}`);
    } catch (error: unknown) {
      throw mapGitError(step, error);
    }
  }

  async function pullsForBranch(repo: string, branch: string): Promise<readonly PullRow[]> {
    requireRepo("pullsForBranch", repo);
    const rows: PullRow[] = [];
    for (const pull of [...pulls.values()].sort((a, b) => a.number - b.number)) {
      if (pull.head !== branch) {
        continue;
      }
      const headRefOid =
        pull.state === "MERGED"
          ? (pull.mergedHead as string)
          : await liveHead("pullsForBranch", branch);
      rows.push({
        number: pull.number,
        state: pull.state,
        headRefOid,
        baseRefName: pull.base,
        isDraft: false,
        isCrossRepository: false,
        authorLogin: options.factoryLogin,
        bodyFirstLine: pull.body.split("\n")[0] as string,
      });
    }
    return rows;
  }

  async function createPull(
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<number> {
    requireRepo("createPull", repo);
    try {
      await liveHead("createPull", head);
    } catch (error: unknown) {
      if (error instanceof GitHubError && error.kind === "rejected") {
        throw new GitHubError("rejected", "createPull", "createPull: unknown branch");
      }
      throw error;
    }
    const number = next;
    next += 1;
    pulls.set(number, {
      number,
      head,
      base,
      title,
      body,
      state: "OPEN",
      mergedHead: null,
      mergeCommit: null,
    });
    return number;
  }

  async function viewPull(repo: string, pull: number): Promise<PullView> {
    requireRepo("viewPull", repo);
    const row = requirePull("viewPull", pull);
    const headRefOid =
      row.state === "MERGED" ? (row.mergedHead as string) : await liveHead("viewPull", row.head);
    return {
      state: row.state,
      headRefOid,
      baseRefName: row.base,
      isDraft: false,
      mergeCommit: row.mergeCommit,
    };
  }

  async function mergePull(repo: string, pull: number, headSha: string): Promise<void> {
    requireRepo("mergePull", repo);
    const row = requirePull("mergePull", pull);
    if (row.state !== "OPEN") {
      throw new GitHubError("rejected", "mergePull", "mergePull: pull is not open");
    }
    const live = await liveHead("mergePull", row.head);
    if (live !== headSha) {
      throw new GitHubError("rejected", "mergePull", "mergePull: head moved");
    }
    let old: string;
    try {
      old = await revParse(options.originDir, options.git, `refs/heads/${row.base}`);
    } catch (error: unknown) {
      throw mapGitError("mergePull", error);
    }
    const wt = join(options.scratchDir, `stub-merge-${String(pull)}`);
    // Best effort, like `trialMerge` step 1: this block clears a leftover
    // of this pull's own scratch path, and `worktree add` below decides
    // the outcome; its failure stays `rejected`.
    try {
      await runStubGit(options.originDir, options.git, "mergePull", [
        "worktree",
        "remove",
        "--force",
        wt,
      ]);
    } catch {
      // Ignored: the add below decides the outcome.
    }
    try {
      if (await pathExists(wt)) {
        await rm(wt, { recursive: true, force: true });
      }
    } catch {
      // Ignored: the add below decides the outcome.
    }
    try {
      await runStubGit(options.originDir, options.git, "mergePull", ["worktree", "prune"]);
    } catch {
      // Ignored: the add below decides the outcome.
    }
    const added = await runStubGit(options.originDir, options.git, "mergePull", [
      "worktree",
      "add",
      "--detach",
      wt,
      old,
    ]);
    if (added.rc !== 0) {
      throw new GitHubError("rejected", "mergePull", "mergePull: worktree add failed");
    }
    try {
      const merged = await runStubGit(
        wt,
        options.git,
        "mergePull",
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          `Merge pull request #${String(pull)} from ${row.head}`,
          headSha,
        ],
        ["-c", "user.name=moc-demo", "-c", "user.email=demo@example.invalid"],
      );
      if (merged.rc !== 0) {
        throw new GitHubError("rejected", "mergePull", "mergePull: merge conflict");
      }
      const parsed = await runStubGit(wt, options.git, "mergePull", [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ]);
      if (parsed.rc !== 0) {
        throw new GitHubError("rejected", "mergePull", "mergePull: rev-parse failed");
      }
      const nextSha = parsed.stdout.trim();
      await casUpdateRef(options.originDir, options.git, `refs/heads/${row.base}`, nextSha, old);
      row.state = "MERGED";
      row.mergedHead = headSha;
      row.mergeCommit = nextSha;
    } finally {
      // Best effort: the scratch worktree is sandbox state, so cleanup
      // after the merge never replaces the call's outcome, and the next
      // `mergePull` of the same pull clears a leftover before its add.
      try {
        await runStubGit(options.originDir, options.git, "mergePull", [
          "worktree",
          "remove",
          "--force",
          wt,
        ]);
      } catch {
        // Ignored: see the best-effort note above.
      }
      try {
        if (await pathExists(wt)) {
          await rm(wt, { recursive: true, force: true });
        }
      } catch {
        // Ignored: see the best-effort note above.
      }
      try {
        await runStubGit(options.originDir, options.git, "mergePull", ["worktree", "prune"]);
      } catch {
        // Ignored: see the best-effort note above.
      }
    }
  }

  async function baseSha(repo: string, baseBranch: string): Promise<string> {
    requireRepo("baseSha", repo);
    try {
      return await revParse(options.originDir, options.git, `refs/heads/${baseBranch}`);
    } catch (error: unknown) {
      throw mapGitError("baseSha", error);
    }
  }

  async function commitParents(repo: string, sha: string): Promise<readonly string[]> {
    requireRepo("commitParents", repo);
    const { rc, stdout } = await runStubGit(options.originDir, options.git, "commitParents", [
      "rev-list",
      "--parents",
      "-n",
      "1",
      sha,
    ]);
    if (rc !== 0) {
      throw new GitHubError("rejected", "commitParents", "commitParents: rev-list failed");
    }
    return stdout.trim().split(/\s+/).slice(1);
  }

  async function createIssue(
    repo: string,
    title: string,
    body: string,
    labels: readonly string[],
  ): Promise<number> {
    requireRepo("createIssue", repo);
    await Promise.resolve();
    const number = next;
    next += 1;
    issues.set(number, {
      number,
      title,
      body,
      labels: [...labels],
      authorAssociation: "NONE",
      state: "open",
    });
    return number;
  }

  function seedIssue(seed: StubIssueSeed): number {
    requireRepo("seedIssue", options.repo);
    const number = next;
    next += 1;
    issues.set(number, { number, ...seed, labels: [...seed.labels] });
    return number;
  }

  async function factoryIssues(repo: string, label: string): Promise<readonly IssueFirstLine[]> {
    requireRepo("factoryIssues", repo);
    await Promise.resolve();
    return [...issues.values()]
      .filter((issue) => issue.labels.includes(label))
      .sort((a, b) => a.number - b.number)
      .map((issue) => ({
        number: issue.number,
        first: issue.body.split("\n")[0] ?? "",
      }));
  }

  async function readyIssues(
    repo: string,
    labels: readonly string[],
  ): Promise<readonly IntakeIssue[]> {
    requireRepo("readyIssues", repo);
    await Promise.resolve();
    return [...issues.values()]
      .filter(
        (issue) => issue.state === "open" && labels.every((label) => issue.labels.includes(label)),
      )
      .sort((a, b) => b.number - a.number)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels],
        authorAssociation: issue.authorAssociation,
        isPullRequest: false,
      }));
  }

  async function issueState(repo: string, n: number): Promise<"open" | "closed"> {
    requireRepo("issueState", repo);
    await Promise.resolve();
    return requireIssue("issueState", n).state;
  }

  async function editIssueLabels(
    repo: string,
    issue: number,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void> {
    requireRepo("editIssueLabels", repo);
    await Promise.resolve();
    const row = requireIssue("editIssueLabels", issue);
    for (const label of add) {
      if (!row.labels.includes(label)) {
        row.labels.push(label);
      }
    }
    row.labels = row.labels.filter((label) => !remove.includes(label));
  }

  return {
    viewerLogin,
    checkRuns,
    checkAnnotations,
    commentFirstLines,
    postComment,
    pullsForBranch,
    createPull,
    viewPull,
    mergePull,
    baseSha,
    commitParents,
    createIssue,
    seedIssue,
    factoryIssues,
    editIssueLabels,
    readyIssues,
    issueState,
    snapshot,
  };
}

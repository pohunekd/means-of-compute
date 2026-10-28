// In-memory GitHub stub over a sandbox origin.git: PRs, issues and
// comments live in maps while refs and merges run real git commands.
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isAncestor, revParse, type GitDeps } from "../git.js";
import {
  GitHubError,
  type CheckRun,
  type CommentFirstLine,
  type GitHubPort,
  type IssueFirstLine,
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

// The stub allowlist adds update-ref and rev-list next to the leaf set.
async function runStubGit(
  dir: string,
  deps: GitDeps,
  step: string,
  args: readonly string[],
  prefix: readonly string[] = [],
): Promise<StubGitOutput> {
  let index = 0;
  while (args[index] === "-c") {
    index += 3;
  }
  const sub = args[index];
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
      throw new GitHubError("unavailable", step, `${step}: timed out`);
    }
    return { rc, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
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
      stderr.slice(0, 300),
    );
  }
}

export function createStubGitHub(options: StubGitHubOptions): GitHubPort & {
  snapshot(): StubGitHubSnapshot;
} {
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
    if (await isAncestor(options.originDir, options.git, sha, baseRef)) {
      checkId += 1;
      return [{ id: checkId, name: "gates", status: "completed", conclusion: "success" }];
    }
    const outcome = options.ci(sha);
    if (outcome === "pending") {
      return [];
    }
    checkId += 1;
    return [{ id: checkId, name: "gates", status: "completed", conclusion: outcome }];
  }

  function commentFirstLines(repo: string, number: number): Promise<readonly CommentFirstLine[]> {
    requireRepo("commentFirstLines", repo);
    if (!pulls.has(number) && !issues.has(number)) {
      throw new GitHubError("rejected", "commentFirstLines", "commentFirstLines: unknown number");
    }
    const rows = (comments.get(number) ?? []).map((comment) => ({
      login: comment.login,
      first: comment.body.split("\n")[0] ?? "",
    }));
    return Promise.resolve(rows);
  }

  function postComment(repo: string, number: number, body: string): Promise<void> {
    requireRepo("postComment", repo);
    if (!pulls.has(number) && !issues.has(number)) {
      throw new GitHubError("rejected", "postComment", "postComment: unknown number");
    }
    const list = comments.get(number) ?? [];
    list.push({ number, login: options.factoryLogin, body });
    comments.set(number, list);
    return Promise.resolve();
  }

  async function liveHead(branch: string): Promise<string> {
    return revParse(options.originDir, options.git, `refs/heads/${branch}`);
  }

  async function pullsForBranch(repo: string, branch: string): Promise<readonly PullRow[]> {
    requireRepo("pullsForBranch", repo);
    const rows: PullRow[] = [];
    for (const pull of [...pulls.values()].sort((a, b) => a.number - b.number)) {
      if (pull.head !== branch) {
        continue;
      }
      const headRefOid =
        pull.state === "MERGED" ? (pull.mergedHead as string) : await liveHead(branch);
      rows.push({
        number: pull.number,
        state: pull.state,
        headRefOid,
        baseRefName: pull.base,
        isDraft: false,
        isCrossRepository: false,
        authorLogin: options.factoryLogin,
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
      await liveHead(head);
    } catch {
      throw new GitHubError("rejected", "createPull", "createPull: unknown branch");
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
      row.state === "MERGED" ? (row.mergedHead as string) : await liveHead(row.head);
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
    const live = await liveHead(row.head);
    if (live !== headSha) {
      throw new GitHubError("rejected", "mergePull", "mergePull: head moved");
    }
    const old = await revParse(options.originDir, options.git, `refs/heads/${row.base}`);
    const wt = join(options.scratchDir, `stub-merge-${String(pull)}`);
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
      await runStubGit(options.originDir, options.git, "mergePull", [
        "worktree",
        "remove",
        "--force",
        wt,
      ]);
      if (await pathExists(wt)) {
        await rm(wt, { recursive: true, force: true });
      }
      await runStubGit(options.originDir, options.git, "mergePull", ["worktree", "prune"]);
    }
  }

  async function baseSha(repo: string, baseBranch: string): Promise<string> {
    requireRepo("baseSha", repo);
    return revParse(options.originDir, options.git, `refs/heads/${baseBranch}`);
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

  function createIssue(
    repo: string,
    title: string,
    body: string,
    labels: readonly string[],
  ): Promise<number> {
    requireRepo("createIssue", repo);
    const number = next;
    next += 1;
    issues.set(number, { number, title, body, labels: [...labels] });
    return Promise.resolve(number);
  }

  function factoryIssues(repo: string, label: string): Promise<readonly IssueFirstLine[]> {
    requireRepo("factoryIssues", repo);
    const rows = [...issues.values()]
      .filter((issue) => issue.labels.includes(label))
      .sort((a, b) => a.number - b.number)
      .map((issue) => ({
        number: issue.number,
        first: issue.body.split("\n")[0] ?? "",
      }));
    return Promise.resolve(rows);
  }

  function editIssueLabels(
    repo: string,
    issue: number,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void> {
    requireRepo("editIssueLabels", repo);
    const row = requireIssue("editIssueLabels", issue);
    for (const label of add) {
      if (!row.labels.includes(label)) {
        row.labels.push(label);
      }
    }
    row.labels = row.labels.filter((label) => !remove.includes(label));
    return Promise.resolve();
  }

  return {
    viewerLogin,
    checkRuns,
    commentFirstLines,
    postComment,
    pullsForBranch,
    createPull,
    viewPull,
    mergePull,
    baseSha,
    commitParents,
    createIssue,
    factoryIssues,
    editIssueLabels,
    snapshot,
  };
}

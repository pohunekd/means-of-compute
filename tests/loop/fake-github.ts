// In-memory GitHubPort double: records every call, fails a named method
// once with a given GitHubError, and stores comments with a login.
// Methods the park tests never call throw instead of succeeding.
import type {
  CheckRun,
  CommentFirstLine,
  GitHubError,
  GitHubPort,
  IntakeIssue,
  IssueFirstLine,
  PullRow,
  PullView,
} from "../../src/loop/github.js";

export interface FakeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

interface StoredComment {
  readonly login: string;
  readonly first: string;
  readonly body: string;
}

interface StoredIssue {
  readonly number: number;
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

function unused(): never {
  throw new Error("not used by the park tests");
}

export class FakeGitHub implements GitHubPort {
  readonly calls: FakeCall[] = [];
  login = "factory-bot";
  nextIssue = 100;
  readonly failures = new Map<string, GitHubError>();
  readonly comments = new Map<string, StoredComment[]>();
  readonly issues: StoredIssue[] = [];
  readonly labelEdits: {
    readonly repo: string;
    readonly issue: number;
    readonly add: readonly string[];
    readonly remove: readonly string[];
  }[] = [];

  failNext(method: string, error: GitHubError): void {
    this.failures.set(method, error);
  }

  seedComment(repo: string, issue: number, login: string, body: string): void {
    const key = `${repo}#${String(issue)}`;
    const first = body.split("\n")[0] ?? "";
    const list = this.comments.get(key) ?? [];
    list.push({ login, first, body });
    this.comments.set(key, list);
  }

  takeFailure(method: string): void {
    const error = this.failures.get(method);
    if (error !== undefined) {
      this.failures.delete(method);
      throw error;
    }
  }

  viewerLogin(): Promise<string> {
    this.calls.push({ method: "viewerLogin", args: [] });
    return unused();
  }

  checkRuns(repo: string, sha: string): Promise<readonly CheckRun[]> {
    this.calls.push({ method: "checkRuns", args: [repo, sha] });
    return unused();
  }

  commentFirstLines(repo: string, number: number): Promise<readonly CommentFirstLine[]> {
    this.calls.push({ method: "commentFirstLines", args: [repo, number] });
    this.takeFailure("commentFirstLines");
    const rows = this.comments.get(`${repo}#${String(number)}`) ?? [];
    return Promise.resolve(rows.map((row) => ({ login: row.login, first: row.first })));
  }

  postComment(repo: string, number: number, body: string): Promise<void> {
    this.calls.push({ method: "postComment", args: [repo, number, body] });
    this.takeFailure("postComment");
    this.seedComment(repo, number, this.login, body);
    return Promise.resolve();
  }

  pullsForBranch(repo: string, branch: string): Promise<readonly PullRow[]> {
    this.calls.push({ method: "pullsForBranch", args: [repo, branch] });
    return unused();
  }

  createPull(
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<number> {
    this.calls.push({ method: "createPull", args: [repo, head, base, title, body] });
    return unused();
  }

  viewPull(repo: string, pull: number): Promise<PullView> {
    this.calls.push({ method: "viewPull", args: [repo, pull] });
    return unused();
  }

  mergePull(repo: string, pull: number, headSha: string): Promise<void> {
    this.calls.push({ method: "mergePull", args: [repo, pull, headSha] });
    return unused();
  }

  baseSha(repo: string, baseBranch: string): Promise<string> {
    this.calls.push({ method: "baseSha", args: [repo, baseBranch] });
    return unused();
  }

  commitParents(repo: string, sha: string): Promise<readonly string[]> {
    this.calls.push({ method: "commitParents", args: [repo, sha] });
    return unused();
  }

  createIssue(
    repo: string,
    title: string,
    body: string,
    labels: readonly string[],
  ): Promise<number> {
    this.calls.push({ method: "createIssue", args: [repo, title, body, [...labels]] });
    this.takeFailure("createIssue");
    const number = this.nextIssue;
    this.nextIssue += 1;
    this.issues.push({ number, repo, title, body, labels: [...labels] });
    return Promise.resolve(number);
  }

  factoryIssues(repo: string, label: string): Promise<readonly IssueFirstLine[]> {
    this.calls.push({ method: "factoryIssues", args: [repo, label] });
    this.takeFailure("factoryIssues");
    return Promise.resolve(
      this.issues
        .filter((entry) => entry.repo === repo && entry.labels.includes(label))
        .map((entry) => ({
          number: entry.number,
          first: entry.body.split("\n")[0] ?? "",
        })),
    );
  }

  editIssueLabels(
    repo: string,
    issue: number,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void> {
    this.calls.push({ method: "editIssueLabels", args: [repo, issue, [...add], [...remove]] });
    this.takeFailure("editIssueLabels");
    this.labelEdits.push({ repo, issue, add: [...add], remove: [...remove] });
    return Promise.resolve();
  }

  readyIssues(repo: string, labels: readonly string[]): Promise<readonly IntakeIssue[]> {
    this.calls.push({ method: "readyIssues", args: [repo, [...labels]] });
    return unused();
  }

  issueState(repo: string, issue: number): Promise<"open" | "closed"> {
    this.calls.push({ method: "issueState", args: [repo, issue] });
    return unused();
  }

  callsOf(method: string): readonly FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

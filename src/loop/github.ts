// Gh port: every GitHub call goes through `gh` with a fixed env and a
// bounded wait. The token travels only in the child env, never in argv.
import { mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Ajv from "ajv/dist/2020";
import { writeFileAtomic } from "../fs/write.js";
import type { LoopGithubConfig } from "./config.js";
import intakeSchema from "./intake.schema.json" with { type: "json" };

export type GitHubErrorKind = "unavailable" | "rejected" | "invalid-output" | "unverified";

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  readonly step: string;
  readonly detail?: string;
  constructor(kind: GitHubErrorKind, step: string, message: string, detail?: string) {
    super(message);
    this.name = "GitHubError";
    this.kind = kind;
    this.step = step;
    this.detail = detail;
  }
}

export interface GhEnv {
  readonly PATH: string;
  readonly token: string;
}
export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}
export interface CommentFirstLine {
  readonly login: string;
  readonly first: string;
}
export interface PullRow {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly isDraft: boolean;
  readonly isCrossRepository: boolean;
  readonly authorLogin: string;
  readonly bodyFirstLine: string;
}
export interface PullView {
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly isDraft: boolean;
  readonly mergeCommit: string | null;
}
export interface IssueFirstLine {
  readonly number: number;
  readonly first: string;
}
export interface IntakeIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly authorAssociation: string;
  readonly isPullRequest: boolean;
}
export interface GitHubPort {
  viewerLogin(): Promise<string>;
  checkRuns(repo: string, sha: string): Promise<readonly CheckRun[]>;
  commentFirstLines(repo: string, number: number): Promise<readonly CommentFirstLine[]>;
  postComment(repo: string, number: number, body: string): Promise<void>;
  pullsForBranch(repo: string, branch: string): Promise<readonly PullRow[]>;
  createPull(
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<number>;
  viewPull(repo: string, pull: number): Promise<PullView>;
  mergePull(repo: string, pull: number, headSha: string): Promise<void>;
  baseSha(repo: string, baseBranch: string): Promise<string>;
  commitParents(repo: string, sha: string): Promise<readonly string[]>;
  createIssue(
    repo: string,
    title: string,
    body: string,
    labels: readonly string[],
  ): Promise<number>;
  factoryIssues(repo: string, label: string): Promise<readonly IssueFirstLine[]>;
  editIssueLabels(
    repo: string,
    issue: number,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void>;
  readyIssues(repo: string, labels: readonly string[]): Promise<readonly IntakeIssue[]>;
  issueState(repo: string, issue: number): Promise<"open" | "closed">;
}
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const validateIntakeIssue = new Ajv({ strict: true }).compile(intakeSchema);

function redact(token: string, value: string): string {
  return token.length === 0 ? value : value.split(token).join("[redacted]");
}

// R2-1 keeps at most 300 bytes and never ends in a cut-made U+FFFD.
export function utf8Prefix(text: string, max: number): string {
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

// E2 keeps the first 300 bytes of stderr after redacting the token.
function stderrPrefix(token: string, stderr: string): string {
  return utf8Prefix(redact(token, stderr), 300);
}

async function runGh(
  config: LoopGithubConfig,
  env: GhEnv,
  step: string,
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["gh", ...argv], {
      env: {
        PATH: env.PATH,
        GH_TOKEN: env.token,
        GH_CONFIG_DIR: config.configDir,
        GH_PROMPT_DISABLED: "1",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new GitHubError("unavailable", step, `${step}: cannot start gh`);
  }
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // The child already exited; the timeout error below carries the failure.
    }
  }, config.timeoutMs);
  try {
    const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
    const stderrPromise = new Response(proc.stderr as ReadableStream).text();
    const rc = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (state.timedOut) {
      throw new GitHubError("unavailable", step, `${step}: timed out`);
    }
    if (rc !== 0) {
      const detail = stderrPrefix(env.token, stderr);
      throw new GitHubError("rejected", step, `${step}: gh exited ${String(rc)}`, detail);
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function useBodyFile<T>(
  config: LoopGithubConfig,
  body: string,
  step: string,
  run: (file: string) => Promise<T>,
): Promise<T> {
  const dir = join(config.configDir, "tmp");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${randomUUID()}.md`);
  await writeFileAtomic(step, file, body);
  try {
    return await run(file);
  } finally {
    try {
      await unlink(file);
    } catch {
      // A failed removal leaves a 600 file behind; the result stands.
    }
  }
}

function nonEmptyLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.length > 0);
}

function parseJsonLines(stdout: string, step: string): unknown[] {
  const values: unknown[] = [];
  for (const line of nonEmptyLines(stdout)) {
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      throw new GitHubError("invalid-output", step, `${step}: a line is not JSON`);
    }
  }
  return values;
}

function parseJsonValue(stdout: string, step: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new GitHubError("invalid-output", step, `${step}: stdout is not JSON`);
  }
}

function requireFields(
  value: unknown,
  keys: readonly string[],
  step: string,
  what: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubError("invalid-output", step, `${step}: ${what} is not an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  const same =
    actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  if (!same) {
    throw new GitHubError("invalid-output", step, `${step}: ${what} fields differ`);
  }
  return record;
}

function asString(value: unknown, step: string, what: string): string {
  if (typeof value !== "string") {
    throw new GitHubError("invalid-output", step, `${step}: ${what} is not a string`);
  }
  return value;
}

function asInteger(value: unknown, step: string, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GitHubError("invalid-output", step, `${step}: ${what} is not an integer`);
  }
  return value;
}

function asBoolean(value: unknown, step: string, what: string): boolean {
  if (typeof value !== "boolean") {
    throw new GitHubError("invalid-output", step, `${step}: ${what} is not a boolean`);
  }
  return value;
}

function asSha(value: unknown, step: string, what: string): string {
  const text = asString(value, step, what);
  if (!SHA_PATTERN.test(text)) {
    throw new GitHubError("invalid-output", step, `${step}: ${what} is not a 40-hex sha`);
  }
  return text;
}

function toCheckRun(value: unknown, step: string): CheckRun {
  const record = requireFields(value, ["id", "name", "status", "conclusion"], step, "check run");
  const conclusion = record["conclusion"];
  return {
    id: asInteger(record["id"], step, "check run id"),
    name: asString(record["name"], step, "check run name"),
    status: asString(record["status"], step, "check run status"),
    conclusion: conclusion === null ? null : asString(conclusion, step, "check run conclusion"),
  };
}

function toCommentFirstLine(value: unknown, step: string): CommentFirstLine {
  const record = requireFields(value, ["login", "first"], step, "comment");
  return {
    login: asString(record["login"], step, "comment login"),
    first: asString(record["first"], step, "comment first line"),
  };
}

// Real `gh pr list --json author` rows carry the gh author shape; the
// port maps only `login` and rejects any other key.
const PULL_AUTHOR_KEYS = ["id", "is_bot", "login", "name"];

function toPullAuthorLogin(value: unknown, step: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubError("invalid-output", step, `${step}: pull author is not an object`);
  }
  const author = value as Record<string, unknown>;
  for (const key of Object.keys(author)) {
    if (!PULL_AUTHOR_KEYS.includes(key)) {
      throw new GitHubError("invalid-output", step, `${step}: pull author fields differ`);
    }
  }
  return asString(author["login"], step, "pull author login");
}

export function createGhPort(config: LoopGithubConfig, env: GhEnv): GitHubPort {
  function requireFactoryLogin(step: string): string {
    const login = config.factoryLogin;
    if (login === null) {
      throw new GitHubError("rejected", "factory-login-unset", `${step}: factory login is unset`);
    }
    return login;
  }

  async function viewerLogin(): Promise<string> {
    const step = "viewerLogin";
    const { stdout } = await runGh(config, env, step, ["api", "user", "--jq", ".login"]);
    const trimmed = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (trimmed.length !== 1) {
      throw new GitHubError("invalid-output", step, `${step}: expected one login line`);
    }
    return trimmed[0] as string;
  }

  async function checkRuns(repo: string, sha: string): Promise<readonly CheckRun[]> {
    const step = "checkRuns";
    const { stdout } = await runGh(config, env, step, [
      "api",
      `repos/${repo}/commits/${sha}/check-runs`,
      "--paginate",
      "--jq",
      ".check_runs[] | {id, name, status, conclusion}",
    ]);
    return parseJsonLines(stdout, step).map((value) => toCheckRun(value, step));
  }

  async function commentFirstLines(
    repo: string,
    number: number,
  ): Promise<readonly CommentFirstLine[]> {
    const step = "commentFirstLines";
    const { stdout } = await runGh(config, env, step, [
      "api",
      `repos/${repo}/issues/${String(number)}/comments`,
      "--paginate",
      "--jq",
      '.[] | {login: .user.login, first: (.body | split("\\n")[0])}',
    ]);
    return parseJsonLines(stdout, step).map((value) => toCommentFirstLine(value, step));
  }

  async function postComment(repo: string, number: number, body: string): Promise<void> {
    const step = "postComment";
    const factoryLogin = requireFactoryLogin(step);
    await useBodyFile(config, body, step, async (file) => {
      const { stdout } = await runGh(config, env, step, [
        "api",
        "-X",
        "POST",
        `repos/${repo}/issues/${String(number)}/comments`,
        "-F",
        `body=@${file}`,
        "--jq",
        ".id",
      ]);
      const lines = nonEmptyLines(stdout);
      if (lines.length !== 1) {
        throw new GitHubError("invalid-output", step, `${step}: expected one id line`);
      }
      const posted: unknown = parseJsonValue(lines[0] as string, step);
      asInteger(posted, step, "comment id");
    });
    const first = body.split("\n")[0] as string;
    const rows = await commentFirstLines(repo, number);
    const found = rows.some((row) => row.login === factoryLogin && row.first === first);
    if (!found) {
      throw new GitHubError("unverified", step, `${step}: posted comment not found`);
    }
  }

  function toPullRow(value: unknown, step: string): PullRow {
    const record = requireFields(
      value,
      [
        "number",
        "state",
        "headRefOid",
        "baseRefName",
        "isDraft",
        "isCrossRepository",
        "author",
        "body",
      ],
      step,
      "pull row",
    );
    const state = asString(record["state"], step, "pull state");
    if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
      throw new GitHubError("invalid-output", step, `${step}: unknown pull state`);
    }
    const authorLogin = toPullAuthorLogin(record["author"], step);
    return {
      number: asInteger(record["number"], step, "pull number"),
      state,
      headRefOid: asSha(record["headRefOid"], step, "pull head"),
      baseRefName: asString(record["baseRefName"], step, "pull base"),
      isDraft: asBoolean(record["isDraft"], step, "pull draft"),
      isCrossRepository: asBoolean(record["isCrossRepository"], step, "pull cross repo"),
      authorLogin,
      bodyFirstLine: asString(record["body"], step, "pull body").split(/\r?\n/)[0] as string,
    };
  }

  async function pullsForBranch(repo: string, branch: string): Promise<readonly PullRow[]> {
    const step = "pullsForBranch";
    const { stdout } = await runGh(config, env, step, [
      "pr",
      "list",
      "-R",
      repo,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state,headRefOid,baseRefName,isDraft,isCrossRepository,author,body",
      "--limit",
      "20",
    ]);
    const value = parseJsonValue(stdout, step);
    if (!Array.isArray(value)) {
      throw new GitHubError("invalid-output", step, `${step}: expected an array`);
    }
    return value.map((entry) => toPullRow(entry, step));
  }

  function pullNumberFromUrl(stdout: string, step: string, what: string): number {
    const lines = nonEmptyLines(stdout);
    const last = lines[lines.length - 1];
    const match = last === undefined ? null : /\/pull\/([1-9][0-9]*)$/.exec(last);
    if (match === null) {
      throw new GitHubError("invalid-output", step, `${step}: ${what} url missing`);
    }
    return Number(match[1]);
  }

  async function createPull(
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<number> {
    const step = "createPull";
    return useBodyFile(config, body, step, async (file) => {
      const { stdout } = await runGh(config, env, step, [
        "pr",
        "create",
        "-R",
        repo,
        "--head",
        head,
        "--base",
        base,
        "--title",
        title,
        "--body-file",
        file,
      ]);
      return pullNumberFromUrl(stdout, step, "pull");
    });
  }

  async function viewPull(repo: string, pull: number): Promise<PullView> {
    const step = "viewPull";
    const { stdout } = await runGh(config, env, step, [
      "pr",
      "view",
      String(pull),
      "-R",
      repo,
      "--json",
      "state,headRefOid,baseRefName,isDraft,mergeCommit",
    ]);
    const record = requireFields(
      parseJsonValue(stdout, step),
      ["state", "headRefOid", "baseRefName", "isDraft", "mergeCommit"],
      step,
      "pull view",
    );
    const state = asString(record["state"], step, "pull state");
    if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
      throw new GitHubError("invalid-output", step, `${step}: unknown pull state`);
    }
    const mergeCommit = record["mergeCommit"];
    let mergeOid: string | null = null;
    if (mergeCommit !== null) {
      const mergeRecord = requireFields(mergeCommit, ["oid"], step, "merge commit");
      mergeOid = asSha(mergeRecord["oid"], step, "merge commit oid");
    }
    return {
      state,
      headRefOid: asSha(record["headRefOid"], step, "pull head"),
      baseRefName: asString(record["baseRefName"], step, "pull base"),
      isDraft: asBoolean(record["isDraft"], step, "pull draft"),
      mergeCommit: mergeOid,
    };
  }

  async function mergePull(repo: string, pull: number, headSha: string): Promise<void> {
    const step = "mergePull";
    await runGh(config, env, step, [
      "pr",
      "merge",
      String(pull),
      "-R",
      repo,
      "--merge",
      "--match-head-commit",
      headSha,
    ]);
  }

  async function baseSha(repo: string, baseBranch: string): Promise<string> {
    const step = "baseSha";
    const { stdout } = await runGh(config, env, step, [
      "api",
      `repos/${repo}/git/ref/heads/${baseBranch}`,
      "--jq",
      ".object.sha",
    ]);
    const lines = nonEmptyLines(stdout);
    if (lines.length !== 1 || !SHA_PATTERN.test(lines[0] as string)) {
      throw new GitHubError("invalid-output", step, `${step}: expected one sha line`);
    }
    return lines[0] as string;
  }

  async function commitParents(repo: string, sha: string): Promise<readonly string[]> {
    const step = "commitParents";
    const { stdout } = await runGh(config, env, step, [
      "api",
      `repos/${repo}/commits/${sha}`,
      "--jq",
      "[.parents[].sha]",
    ]);
    const value = parseJsonValue(stdout, step);
    if (!Array.isArray(value)) {
      throw new GitHubError("invalid-output", step, `${step}: expected an array`);
    }
    return value.map((entry) => asSha(entry, step, "parent sha"));
  }

  async function createIssue(
    repo: string,
    title: string,
    body: string,
    labels: readonly string[],
  ): Promise<number> {
    const step = "createIssue";
    return useBodyFile(config, body, step, async (file) => {
      const argv: string[] = ["issue", "create", "-R", repo, "--title", title, "--body-file", file];
      for (const label of labels) {
        argv.push("--label", label);
      }
      const { stdout } = await runGh(config, env, step, argv);
      const lines = nonEmptyLines(stdout);
      const last = lines[lines.length - 1];
      const match = last === undefined ? null : /\/issues\/([1-9][0-9]*)$/.exec(last);
      if (match === null) {
        throw new GitHubError("invalid-output", step, `${step}: issue url missing`);
      }
      return Number(match[1]);
    });
  }

  async function factoryIssues(repo: string, label: string): Promise<readonly IssueFirstLine[]> {
    const step = "factoryIssues";
    const factoryLogin = requireFactoryLogin(step);
    const { stdout } = await runGh(config, env, step, [
      "api",
      "-X",
      "GET",
      `repos/${repo}/issues`,
      "-f",
      `creator=${factoryLogin}`,
      "-f",
      `labels=${label}`,
      "-f",
      "state=all",
      "-f",
      "per_page=100",
      "--paginate",
      "--jq",
      '.[] | {number, pull_request, first: ((.body // "") | split("\\n")[0])}',
    ]);
    const rows: IssueFirstLine[] = [];
    for (const value of parseJsonLines(stdout, step)) {
      const record = requireFields(value, ["number", "pull_request", "first"], step, "issue");
      if (record["pull_request"] !== null) {
        continue;
      }
      rows.push({
        number: asInteger(record["number"], step, "issue number"),
        first: asString(record["first"], step, "issue first line"),
      });
    }
    return rows;
  }

  async function editIssueLabels(
    repo: string,
    issue: number,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void> {
    const step = "editIssueLabels";
    const argv: string[] = ["issue", "edit", String(issue), "-R", repo];
    for (const label of add) {
      argv.push("--add-label", label);
    }
    for (const label of remove) {
      argv.push("--remove-label", label);
    }
    await runGh(config, env, step, argv);
  }

  async function readyIssues(
    repo: string,
    labels: readonly string[],
  ): Promise<readonly IntakeIssue[]> {
    const step = "readyIssues";
    const { stdout } = await runGh(config, env, step, [
      "api",
      "-X",
      "GET",
      `repos/${repo}/issues`,
      "-f",
      "state=open",
      "-f",
      `labels=${labels.join(",")}`,
      "-f",
      "per_page=100",
      "--paginate",
      "--jq",
      '.[] | {number, title, body: (.body // ""), labels: [.labels[].name], author_association, pull_request: (.pull_request != null)}',
    ]);
    const rows: IntakeIssue[] = [];
    for (const value of parseJsonLines(stdout, step)) {
      if (!validateIntakeIssue(value)) {
        throw new GitHubError("invalid-output", step, "readyIssues: issue fails the intake schema");
      }
      const record = value as Record<string, unknown>;
      const labelsValue = record["labels"];
      rows.push({
        number: record["number"] as number,
        title: record["title"] as string,
        body: record["body"] as string,
        labels: Array.isArray(labelsValue) ? (labelsValue as string[]) : [],
        authorAssociation: record["author_association"] as string,
        isPullRequest: record["pull_request"] as boolean,
      });
    }
    return rows;
  }

  async function issueState(repo: string, issue: number): Promise<"open" | "closed"> {
    const step = "issueState";
    const { stdout } = await runGh(config, env, step, [
      "api",
      `repos/${repo}/issues/${String(issue)}`,
      "--jq",
      ".state",
    ]);
    const lines = nonEmptyLines(stdout);
    const state = lines.length === 1 ? lines[0] : undefined;
    if (state !== "open" && state !== "closed") {
      throw new GitHubError("invalid-output", step, "issueState: state is not open or closed");
    }
    return state;
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
    readyIssues,
    issueState,
  };
}

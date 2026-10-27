// Read-only git access for the auditor. Every call goes through execGit,
// which rejects write-capable subcommands and flags before spawning, so a
// violation never reaches a child process.
export const HEX40_PATTERN = /^[0-9a-f]{40}$/;

export const ALLOWED_GIT_SUBCOMMANDS = [
  "rev-parse",
  "merge-base",
  "diff",
  "ls-tree",
  "cat-file",
] as const;

export class ReadOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyViolation";
  }
}

export class GitReadError extends Error {
  readonly rc: number;
  constructor(message: string, rc: number) {
    super(message);
    this.name = "GitReadError";
    this.rc = rc;
  }
}

// A model-supplied tree path that is unsafe to resolve. The caller maps it
// to exit 4 because the path comes from the model reply.
export class InvalidModelPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModelPathError";
  }
}

export interface ReadOnlyGit {
  resolveCommit(ref: string): Promise<string>;
  mergeBase(a: string, b: string): Promise<string>;
  changedFiles(base: string, head: string): Promise<readonly string[]>;
  unifiedDiff(base: string, head: string): Promise<string>;
  blobAt(sha: string, path: string): Promise<string | null>;
}

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const OUTPUT_FLAG = /^--output(=|$)/;
const FORBIDDEN_FLAGS = new Set(["--ext-diff", "--textconv"]);

function isAllowedSubcommand(value: string): boolean {
  return (ALLOWED_GIT_SUBCOMMANDS as readonly string[]).includes(value);
}

export async function execGit(
  repoDir: string,
  subcommand: string,
  args: readonly string[],
): Promise<{ stdout: string; rc: number }> {
  if (!isAllowedSubcommand(subcommand)) {
    throw new ReadOnlyViolation(`refusing git ${subcommand}: not in the read-only allowlist`);
  }
  for (const arg of args) {
    if (OUTPUT_FLAG.test(arg)) {
      throw new ReadOnlyViolation(`refusing git ${subcommand} ${arg}: writes a file`);
    }
    if (FORBIDDEN_FLAGS.has(arg)) {
      throw new ReadOnlyViolation(`refusing git ${subcommand} ${arg}: externalizes content`);
    }
  }
  const proc = Bun.spawn(["git", "--no-pager", "-C", repoDir, subcommand, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, rc] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, rc };
}

function requireSha(value: string, what: string): void {
  if (!HEX40_PATTERN.test(value)) {
    throw new GitReadError(`${what} is not a 40-hex sha: ${value}`, 128);
  }
}

function parseShaOutput(stdout: string, ref: string, rc: number): string {
  const sha = stdout.trim();
  if (rc === 0 && HEX40_PATTERN.test(sha)) {
    return sha;
  }
  throw new GitReadError(`cannot resolve ${ref} (rc ${String(rc)})`, rc);
}

export function createReadOnlyGit(repoDir: string): ReadOnlyGit {
  async function resolveCommit(ref: string): Promise<string> {
    // Every ref, including a literal 40-hex sha, goes through rev-parse
    // --verify ...^{commit}: a nonexistent sha or a non-commit object
    // fails here with the rev-parse message instead of later in
    // merge-base.
    if (!HEX40_PATTERN.test(ref) && (!REF_PATTERN.test(ref) || ref.includes(".."))) {
      throw new GitReadError(`invalid ref "${ref}"`, 128);
    }
    const { stdout, rc } = await execGit(repoDir, "rev-parse", [
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    if (rc === 128) {
      throw new GitReadError(`cannot resolve ${ref}`, 128);
    }
    return parseShaOutput(stdout, ref, rc);
  }

  async function mergeBase(a: string, b: string): Promise<string> {
    requireSha(a, "merge-base a");
    requireSha(b, "merge-base b");
    const { stdout, rc } = await execGit(repoDir, "merge-base", [a, b]);
    return parseShaOutput(stdout, `${a}...${b}`, rc);
  }

  async function changedFiles(base: string, head: string): Promise<readonly string[]> {
    requireSha(base, "diff base");
    requireSha(head, "diff head");
    const { stdout, rc } = await execGit(repoDir, "diff", [
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      base,
      head,
    ]);
    if (rc !== 0) {
      throw new GitReadError(`git diff --name-only failed (rc ${String(rc)})`, rc);
    }
    return stdout.split("\0").filter((entry) => entry.length > 0);
  }

  async function unifiedDiff(base: string, head: string): Promise<string> {
    requireSha(base, "diff base");
    requireSha(head, "diff head");
    const { stdout, rc } = await execGit(repoDir, "diff", [
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=3",
      base,
      head,
    ]);
    if (rc !== 0) {
      throw new GitReadError(`git diff failed (rc ${String(rc)})`, rc);
    }
    return stdout;
  }

  async function blobAt(sha: string, path: string): Promise<string | null> {
    requireSha(sha, "blob sha");
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").includes("..")
    ) {
      throw new InvalidModelPathError(`model path escapes the tree: ${JSON.stringify(path)}`);
    }
    const { stdout, rc } = await execGit(repoDir, "ls-tree", [
      "-z",
      "--full-tree",
      sha,
      "--",
      path,
    ]);
    if (rc !== 0) {
      throw new GitReadError(`git ls-tree failed for ${path} (rc ${String(rc)})`, rc);
    }
    if (stdout === "") {
      return null;
    }
    const entries = stdout.split("\0").filter((entry) => entry.length > 0);
    if (entries.length !== 1) {
      throw new GitReadError(`ambiguous tree entries for ${path} at ${sha}`, 0);
    }
    const entry = entries[0] as string;
    const tab = entry.indexOf("\t");
    if (tab === -1) {
      throw new GitReadError(`unparseable ls-tree entry for ${path} at ${sha}`, 0);
    }
    const meta = entry.slice(0, tab).split(" ");
    const name = entry.slice(tab + 1);
    if (meta.length !== 3 || meta[1] !== "blob" || name !== path) {
      throw new GitReadError(`no blob ${path} at ${sha}`, 0);
    }
    const content = await execGit(repoDir, "cat-file", ["blob", `${sha}:${path}`]);
    if (content.rc !== 0) {
      throw new GitReadError(
        `git cat-file failed for ${path} (rc ${String(content.rc)})`,
        content.rc,
      );
    }
    return content.stdout;
  }

  return { resolveCommit, mergeBase, changedFiles, unifiedDiff, blobAt };
}

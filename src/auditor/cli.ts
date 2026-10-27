// CLI entry point: bun run audit --repo-dir <dir> --ref <ref> --base
// <ref> --item <file> [--authors <source>]
// [--author-model <id>...] [--pull <n>] [--post yes]. The WorkItem comes
// only from --item, supplied by the caller. Exit 0 prints the verdict file
// path, then the
// rendered comment (or a note when there is no pull request). Exit 3 is a
// domain refusal, 4 a model, provider or post failure, 2 any input,
// config or data error. Usage is appended to the configured ledger
// (config/ledger.json), the same ledger the budget gate reads. Posting
// uses gh and verifies the posted comment.
import { randomUUID } from "node:crypto";
import { contractErrors, isWorkItem } from "../../contracts/v1/validate.js";
import type { WorkItem } from "../../contracts/v1/types.js";
import { authorModelsOf, loadLedgerConfig, readLedger } from "../ledger/read.js";
import { LedgerDataError, LedgerRefusal } from "../ledger/errors.js";
import { createCliBudgetGate, loadBudgetGateConfig } from "../budget/gate.js";
import { callProviderOnce } from "../providers/router.js";
import { InputPathError, readInputText, requireInputDir, statInputPath } from "../fs/input.js";
import { requireWritableTarget, writeFileAtomic } from "../fs/write.js";
import { AuditPostError, auditExitCode, runAudit } from "./audit.js";
import type { AuditInput } from "./audit-types.js";
import { loadAuditorConfig } from "./config.js";
import { createReadOnlyGit, GitReadError } from "./git.js";
import { readVerdicts } from "./store.js";
import { renderComment } from "./verdict.js";

const AUDITOR_CONFIG_PATH = "config/auditor.json";
const BUDGET_CONFIG_PATH = "config/budget-gate.json";
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function flagValue(args: string[], flag: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const raw = args[index + 1];
      if (raw === undefined || raw.startsWith("--")) {
        throw new Error(`audit: ${flag} needs a value`);
      }
      values.push(raw);
    }
  }
  if (values.length === 0) {
    return null;
  }
  if (flag !== "--author-model" && values.length > 1) {
    throw new Error(`audit: repeated flag ${flag}`);
  }
  if (flag === "--author-model") {
    throw new Error(`audit: use flagValues for ${flag}`);
  }
  return values[0] as string;
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const raw = args[index + 1];
      if (raw === undefined || raw.startsWith("--")) {
        throw new Error(`audit: ${flag} needs a value`);
      }
      values.push(raw);
    }
  }
  return values;
}

// Every known flag takes a value, so each pair is a flag plus its
// value: anything else (a positional argument or a single-dash typo)
// is an unknown argument.
function checkUnknownFlags(args: string[]): void {
  const known = new Set([
    "--repo-dir",
    "--ref",
    "--base",
    "--item",
    "--authors",
    "--author-model",
    "--pull",
    "--post",
  ]);
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (!known.has(arg)) {
      throw new Error(`audit: unknown argument ${arg}`);
    }
    index += 2;
  }
}

interface CliOptions {
  repoDir: string;
  ref: string;
  base: string;
  itemPath: string;
  authors: string;
  authorModels: string[];
  pull: number | null;
  post: boolean;
}

function parseOptions(args: string[]): CliOptions {
  checkUnknownFlags(args);
  const repoDir = flagValue(args, "--repo-dir");
  const ref = flagValue(args, "--ref");
  const base = flagValue(args, "--base");
  const itemPath = flagValue(args, "--item");
  const authors = flagValue(args, "--authors");
  const pullRaw = flagValue(args, "--pull");
  const postRaw = flagValue(args, "--post");
  const authorModels = flagValues(args, "--author-model");
  const required: Readonly<Record<string, string | null>> = {
    "--repo-dir": repoDir,
    "--ref": ref,
    "--base": base,
    "--item": itemPath,
    "--authors": authors,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === null) {
      throw new Error(`audit: ${name} is required`);
    }
  }
  if (repoDir === null || ref === null || base === null || itemPath === null || authors === null) {
    throw new Error("audit: required flags are missing");
  }
  if (authors !== "ledger" && authors !== "flags") {
    throw new Error(`audit: --authors must be "ledger" or "flags"`);
  }
  if (authors === "flags" && authorModels.length === 0) {
    throw new Error(`audit: --authors flags needs at least one --author-model`);
  }
  if (authors === "ledger" && authorModels.length > 0) {
    throw new Error(`audit: --author-model needs --authors flags`);
  }
  for (const model of authorModels) {
    if (!MODEL_PATTERN.test(model)) {
      throw new Error(`audit: invalid --author-model ${JSON.stringify(model)}`);
    }
  }
  let pull: number | null = null;
  if (pullRaw !== null) {
    if (!/^[1-9][0-9]*$/.test(pullRaw) || !Number.isSafeInteger(Number(pullRaw))) {
      throw new Error(`audit: --pull must be an integer >= 1`);
    }
    pull = Number(pullRaw);
  }
  let post = false;
  if (postRaw !== null) {
    if (postRaw !== "yes") {
      throw new Error(`audit: --post accepts only "yes"`);
    }
    post = true;
  }
  if (post && pull === null) {
    throw new Error(`audit: --post requires --pull`);
  }
  return {
    repoDir,
    ref,
    base,
    itemPath,
    authors,
    authorModels,
    pull,
    post,
  };
}

async function readItem(path: string): Promise<WorkItem> {
  if ((await statInputPath("Work item", path)) === "absent") {
    throw new Error(`Work item ${path}: file is missing`);
  }
  const text = await readInputText("Work item", path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Work item ${path}: not valid JSON`);
  }
  if (!isWorkItem(raw)) {
    throw new Error(
      `Work item ${path}: invalid work item ${JSON.stringify(contractErrors("work-item", raw))}`,
    );
  }
  return raw;
}

async function resolveAuthors(
  ledgerPath: string,
  options: CliOptions,
  item: WorkItem,
): Promise<readonly string[]> {
  if (options.authors === "flags") {
    return options.authorModels;
  }
  try {
    const contents = await readLedger("Audit ledger", ledgerPath);
    return authorModelsOf(contents, item.id);
  } catch (error: unknown) {
    if (error instanceof LedgerDataError || error instanceof LedgerRefusal) {
      throw error;
    }
    if (error instanceof InputPathError) {
      throw error;
    }
    throw new Error(
      `cannot read ledger: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function postComment(repo: string, pull: number, comment: string): Promise<void> {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`invalid repo ${JSON.stringify(repo)}`);
  }
  const markerLine = comment.split("\n")[0] as string;
  const temp = `${process.env["TMPDIR"] ?? "/tmp"}/audit-comment-${randomUUID()}.md`;
  await writeFileAtomic("Audit comment", temp, comment);
  const { unlink } = await import("node:fs/promises");
  try {
    const proc = Bun.spawn(["gh", "pr", "comment", String(pull), "-R", repo, "--body-file", temp], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stderr, rc] = await Promise.all([
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (rc !== 0) {
      throw new AuditPostError(`gh pr comment failed (rc ${String(rc)}): ${stderr.slice(0, 500)}`);
    }
    const verify = Bun.spawn(
      [
        "gh",
        "api",
        `repos/${repo}/issues/${String(pull)}/comments`,
        "--paginate",
        "--jq",
        '.[] | .body | split("\n")[0]',
      ],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const [firstLines, verifyRc] = await Promise.all([
      new Response(verify.stdout as ReadableStream).text(),
      verify.exited,
    ]);
    if (verifyRc !== 0) {
      throw new AuditPostError(`gh api comments failed (rc ${String(verifyRc)})`);
    }
    // One JSON array per page would not parse past page one: gh prints
    // only the first line of each body, and the marker matches one line.
    const found = firstLines.split("\n").some((line) => line === markerLine);
    if (!found) {
      throw new AuditPostError("posted comment not found");
    }
  } finally {
    try {
      await unlink(temp);
    } catch {
      // The temp file removal adds nothing to a post failure.
    }
  }
}

async function run(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseOptions(Bun.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    await requireInputDir("Repo dir", options.repoDir);
    const { stdout, rc } = await createReadOnlyGit(options.repoDir)
      .resolveCommit("HEAD")
      .then(
        (sha) => ({ stdout: sha, rc: 0 }),
        (error: unknown) => ({
          stdout: error instanceof Error ? error.message : String(error),
          rc: error instanceof GitReadError ? error.rc : 128,
        }),
      );
    if (rc !== 0 || stdout === "") {
      throw new Error(`Repo dir ${options.repoDir}: not a git repo (${stdout})`);
    }
    const item = await readItem(options.itemPath);
    const { ledgerPath } = await loadLedgerConfig();
    await requireWritableTarget("Audit ledger", ledgerPath);
    const config = await loadAuditorConfig(AUDITOR_CONFIG_PATH);
    const git = createReadOnlyGit(options.repoDir);
    // A retry after a failed post must not refuse: when --post is given
    // and a verdict for the head already exists, post the stored verdict
    // with no budget gate, no model call and no ledger write.
    if (options.post) {
      const headSha = await git.resolveCommit(options.ref);
      const stored = await readVerdicts(config.verdictDir, item.id);
      const match = stored.find((verdict) => verdict.headSha === headSha) ?? null;
      if (match !== null) {
        // The stored verdict belongs to a PR: re-post keeps the PR it
        // was stored for, or renders the marker for --pull when the
        // stored verdict has none. A verdict stored for another PR
        // refuses instead of posting a marker that rule 2.6 rejects.
        if (match.pullNumber !== null && match.pullNumber !== options.pull) {
          console.error(
            `audit: stored verdict ${headSha} is for #${String(match.pullNumber)}, not #${String(options.pull)}`,
          );
          return 2;
        }
        const comment =
          match.pullNumber === null
            ? renderComment({ ...match, pullNumber: options.pull })
            : renderComment(match);
        if (comment === null || options.pull === null) {
          console.error("audit: --post requires a pull request");
          return 2;
        }
        await postComment(item.repo, options.pull, comment);
        console.log(`posted stored verdict ${headSha}`);
        return 0;
      }
    }
    const budgetConfig = await loadBudgetGateConfig(BUDGET_CONFIG_PATH);
    const authors = await resolveAuthors(ledgerPath, options, item);
    const input: AuditInput = {
      item,
      repoDir: options.repoDir,
      ref: options.ref,
      baseRef: options.base,
      pullNumber: options.pull,
      authorModels: [...authors],
    };
    const outcome = await runAudit(input, {
      config,
      git: createReadOnlyGit(options.repoDir),
      budget: createCliBudgetGate({
        command: budgetConfig.command,
        timeoutMs: budgetConfig.timeoutMs,
        cwd: process.cwd(),
      }),
      call: callProviderOnce,
      ledgerPath,
      now: () => new Date(),
    });
    if (outcome.kind === "refused") {
      console.error(`audit: refused: ${outcome.reason}`);
      return 3;
    }
    console.log(outcome.path);
    if (outcome.comment === null) {
      console.log("no pull request: verdict stored without a marker");
    } else {
      console.log(outcome.comment);
    }
    if (options.post) {
      if (outcome.comment === null || options.pull === null) {
        console.error("audit: --post requires a pull request");
        return 2;
      }
      await postComment(item.repo, options.pull, outcome.comment);
    }
    return 0;
  } catch (error: unknown) {
    if (error instanceof LedgerDataError) {
      console.error(`audit: ${error.message}`);
      return 2;
    }
    console.error(`audit: ${error instanceof Error ? error.message : String(error)}`);
    return auditExitCode(error);
  }
}

const code = await run();
process.exit(code);

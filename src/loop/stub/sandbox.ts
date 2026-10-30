// Demo sandbox: reset and seed for the loop demo. Only a directory marked
// with the sandbox marker is ever removed; anything else is refused.
import { copyFile, cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const SANDBOX_MARKER = ".loop-demo";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface SandboxGit {
  readonly PATH: string;
  readonly timeoutMs: number;
}

export interface SandboxInput {
  readonly sandboxDir: string;
  readonly demoRepoDir: string;
  readonly registryPath: string;
  readonly ownedDirs: readonly string[];
  readonly configDir: string;
  readonly ledgerPath: string;
  readonly git: SandboxGit;
}

export interface SandboxLayout {
  readonly originDir: string;
  readonly checkoutDir: string;
  readonly hostsDir: string;
  readonly configDir: string;
}

const ALLOWED_SUBCOMMANDS = new Set([
  "init",
  "clone",
  "fetch",
  "checkout",
  "apply",
  "add",
  "commit",
  "push",
  "rev-parse",
  "ls-remote",
]);

const GIT_IDENTITY = ["-c", "user.name=moc-demo", "-c", "user.email=demo@example.invalid"];

// The demo's own git runner: only the subcommands the demo needs, the demo
// identity on every call, and SIGKILL at the timeout.
export async function sandboxGit(
  git: SandboxGit,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === undefined || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new SandboxError(`sandbox git blocked subcommand ${subcommand ?? "<none>"}`);
  }
  const proc = Bun.spawn(["git", ...GIT_IDENTITY, ...args], {
    cwd,
    env: {
      PATH: git.PATH,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const outText = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const errText = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // The child already exited; the timeout error below carries the failure.
    }
  }, git.timeoutMs);
  try {
    const rc = await proc.exited;
    const timedOut = state.timedOut;
    const [stdout, stderr] = timedOut ? ["", ""] : await Promise.all([outText, errText]);
    if (timedOut) {
      throw new SandboxError(`sandbox git ${subcommand} timed out`);
    }
    if (rc !== 0) {
      throw new SandboxError(`sandbox git ${subcommand} failed: ${stderr.trim()}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

interface BudgetCopy {
  readonly statePath: string;
  readonly escalationLogPath: string;
  readonly dayCapUsd: number;
  readonly totalCapUsd: number;
  readonly nvidiaDailyRequestLimit: number;
  readonly nvidiaProviderId: string;
  readonly unmeasuredAuditCall: { readonly inputTokens: number; readonly outputTokens: number };
  readonly unmeasuredMeterCall: { readonly inputTokens: number; readonly outputTokens: number };
}

interface LedgerCopy {
  readonly ledgerPath: string;
}

// Reset the sandbox: a missing sandbox is created; an existing path must
// be a directory carrying the marker file, otherwise it is refused and left
// untouched. The registry file (not its lock) goes only after these checks.
async function resetSandbox(sandboxDir: string, registryPath: string): Promise<void> {
  let dirStat: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    dirStat = await lstat(sandboxDir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (dirStat !== null) {
    if (!dirStat.isDirectory()) {
      throw new SandboxError("sandbox dir is not a loop demo sandbox");
    }
    let marker: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      marker = await lstat(join(sandboxDir, SANDBOX_MARKER));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (marker === null || !marker.isFile()) {
      throw new SandboxError("sandbox dir is not a loop demo sandbox");
    }
    await rm(sandboxDir, { recursive: true, force: true });
  }
  await rm(registryPath, { force: true });
  await mkdir(sandboxDir, { recursive: true });
  await writeFile(join(sandboxDir, SANDBOX_MARKER), "", { mode: 0o600 });
}

// Seed origin.git from the demo repo: copy to a temp dir, commit there,
// push into the bare origin, then remove the temp dir.
async function seedOrigin(
  demoRepoDir: string,
  originDir: string,
  git: SandboxGit,
  sandboxDir: string,
): Promise<void> {
  await mkdir(originDir, { recursive: true });
  await sandboxGit(git, sandboxDir, ["init", "--bare", "-b", "main", originDir]);
  const seedDir = join(sandboxDir, "seed");
  await cp(demoRepoDir, seedDir, { recursive: true });
  try {
    await sandboxGit(git, seedDir, ["init", "-b", "main"]);
    await sandboxGit(git, seedDir, ["add", "-A"]);
    await sandboxGit(git, seedDir, ["commit", "-m", "Demo repo"]);
    await sandboxGit(git, seedDir, ["push", originDir, "main:main"]);
  } finally {
    await rm(seedDir, { recursive: true, force: true });
  }
}

async function writeJsonFile(path: string, value: BudgetCopy | LedgerCopy): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

// Sandbox startup steps 4 and 5 except the queue items: reset, seed the
// origin and checkout, create the owned dirs, write the budget copies.
export async function prepareSandbox(input: SandboxInput): Promise<SandboxLayout> {
  const sandboxDir = resolve(input.sandboxDir);
  await resetSandbox(sandboxDir, input.registryPath);
  const originDir = join(sandboxDir, "origin.git");
  const checkoutDir = join(sandboxDir, "checkout");
  const hostsDir = join(sandboxDir, "hosts");
  const configDir = join(sandboxDir, "config");
  await seedOrigin(input.demoRepoDir, originDir, input.git, sandboxDir);
  await sandboxGit(input.git, sandboxDir, ["clone", originDir, checkoutDir]);
  await mkdir(hostsDir, { recursive: true });
  for (const dir of input.ownedDirs) {
    await mkdir(dir, { recursive: true });
  }
  const budgetText = await readFile(join(input.configDir, "budget.json"), "utf8");
  const budget = JSON.parse(budgetText) as BudgetCopy;
  const ledgerPath = resolve(input.ledgerPath);
  await mkdir(configDir, { recursive: true });
  await mkdir(join(configDir, "providers"), { recursive: true });
  await writeJsonFile(join(configDir, "budget.json"), {
    ...budget,
    statePath: join(sandboxDir, "budget-state.json"),
    escalationLogPath: join(sandboxDir, "budget-escalations.log"),
  });
  await writeJsonFile(join(configDir, "ledger.json"), { ledgerPath });
  const providerFiles = await readdir(join(input.configDir, "providers"));
  for (const file of providerFiles) {
    await copyFile(join(input.configDir, "providers", file), join(configDir, "providers", file));
  }
  return { originDir, checkoutDir, hostsDir, configDir };
}

// Temp git repo builder for auditor tests: a base commit plus two
// branches (demo-good with a correct add, demo-bad with `a - b` for a
// DoD of "add returns the sum"). No network, no real model.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempRepo {
  readonly dir: string;
  readonly goodSha: string;
  readonly badSha: string;
  readonly baseSha: string;
}

async function git(dir: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const [stdout, stderr, rc] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (rc !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.slice(0, 300)}`);
  }
  return stdout.trim();
}

export async function makeTempRepo(): Promise<TempRepo> {
  const dir = mkdtempSync(join(tmpdir(), "auditor-repo-"));
  try {
    await git(dir, ["init", "-b", "main"]);
    await Bun.write(join(dir, "src", "add.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "base"]);
    const baseSha = await git(dir, ["rev-parse", "HEAD"]);
    await git(dir, ["checkout", "-b", "demo-good"]);
    await Bun.write(join(dir, "src", "add.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function version(): string {\n  return \"good\";\n}\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "good"]);
    const goodSha = await git(dir, ["rev-parse", "HEAD"]);
    await git(dir, ["checkout", "main"]);
    await git(dir, ["checkout", "-b", "demo-bad"]);
    await Bun.write(join(dir, "notes.txt"), "bad branch note\n");
    await Bun.write(join(dir, "src", "add.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "bad"]);
    const badSha = await git(dir, ["rev-parse", "HEAD"]);
    return { dir, goodSha, badSha, baseSha };
  } catch (error: unknown) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function removeTempRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function demoItem(ref: "demo-good" | "demo-bad"): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id: "w9-demo",
    repo: "factory/demo",
    title: "Add two numbers",
    goal: "Sum two numbers",
    issue: 99,
    dod: [{ id: "D1", text: "add returns the sum of its arguments", done: false }],
    dependencies: [],
    status: "review",
    statusReason: null,
    assignedHostAlias: "desktop",
    branch: ref,
    pullNumber: 99,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 1, fallbackUsed: false },
    retryCount: 1,
    stallRounds: 0,
  };
}

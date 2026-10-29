// CLI test: the dry-run start prints the hand-written expected request.
// Deterministic: no gate call, no port call, no writes. The expected
// fixture is compared field by field, so printing the brief instead of
// its hash fails the test. The brief file is required, matching a real
// start (design 2.1.6).
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runCli(args: readonly string[]): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly rc: number;
}> {
  const proc = Bun.spawn(["bun", "run", "src/dispatcher/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, rc] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, rc };
}

test("dry-run prints the expected start request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-cli-"));
  try {
    const ledger = join(dir, "ledger.jsonl");
    const { stdout, stderr, rc } = await runCli([
      "start",
      "--dry-run",
      "--item",
      "tests/fixtures/dispatcher/demo-item.json",
      "--decision",
      "tests/fixtures/dispatcher/demo-decision.json",
      "--provider",
      "nvidia-build",
      "--model",
      "meta/muse-glimmer-30b",
      "--ledger",
      ledger,
      "--brief-file",
      "tests/fixtures/dispatcher/demo-brief.md",
    ]);
    expect(stderr).toBe("");
    expect(rc).toBe(0);
    const expected = JSON.parse(
      await readFile("tests/fixtures/dispatcher/demo-start-expected.json", "utf8"),
    ) as unknown;
    expect(JSON.parse(stdout) as unknown).toEqual(expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

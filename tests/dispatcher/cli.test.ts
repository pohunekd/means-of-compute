// CLI test: the dry-run start prints the hand-written expected request.
// Deterministic: no gate call, no port call, no writes. The expected
// fixture is compared field by field, so printing the brief instead of
// its hash fails the test. The brief file is required, matching a real
// start (design 2.1.6).
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("dry-run rejects the bad ledgers the service would reject", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-cli-bad-"));
  try {
    const cases: Readonly<Record<string, string>> = {
      "bad-attempts": '{"workItemId":"demo-item","attempts":"x"}\n',
      "bad-record": '{"foo":1}\n',
      unterminated: '{"pending":{"entryId":"demo-item:mem-1","kind":"session"',
    };
    for (const [name, line] of Object.entries(cases)) {
      const ledger = join(dir, `${name}.jsonl`);
      await writeFile(ledger, line, "utf8");
      const { rc } = await runCli([
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
      expect(rc).toBe(2);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing flag value exits 2", async () => {
  const { rc, stdout } = await runCli([
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
  ]);
  expect(rc).toBe(2);
  expect(stdout).toBe("");
});

test("a missing brief file exits 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-cli-nobrief-"));
  try {
    const { rc, stdout } = await runCli([
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
      join(dir, "ledger.jsonl"),
    ]);
    expect(rc).toBe(2);
    expect(stdout).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real start attempt exits 2 without touching anything", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-cli-"));
  try {
    const ledger = join(dir, "ledger.jsonl");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/dispatcher/cli.ts",
        "start",
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
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, rc] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    expect(rc).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("only --dry-run is supported");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

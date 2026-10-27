// CLI test: the dry-run start prints the hand-written expected request.
// Deterministic: no gate call, no port call, no writes. The expected
// fixture is compared field by field, so printing the brief instead of
// its hash fails the test.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("dry-run prints the expected start request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-cli-"));
  try {
    const ledger = join(dir, "ledger.jsonl");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/dispatcher/cli.ts",
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
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, rc] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
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

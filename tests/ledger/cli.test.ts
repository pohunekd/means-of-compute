// Ledger CLI tests: the real record and query scripts run as child
// processes on temp files. D1 records the finished-task fixture and the last
// line validates as a UsageRecord; D2 output deep-equals the hand-computed
// expected file; the section-3 rows the CLI owns each exit 2.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: string[], cwd: string = REPO): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", "src/ledger/cli.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function sandbox(): { dir: string; ledger: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-cli-"));
  return { dir, ledger: join(dir, "ledger.jsonl") };
}

test("D1: record writes the record and validates as usage-record", async () => {
  const { dir, ledger } = sandbox();
  try {
    const completion = join(dir, "finished-task.json");
    await Bun.write(completion, Bun.file("tests/fixtures/ledger/finished-task.json"));
    const recorded = await runCli(["record", "--ledger", ledger, "--completion", completion]);
    expect(recorded.code).toBe(0);
    expect(recorded.stdout).toBe("recorded w1-demo (appended)\n");
    const text = await Bun.file(ledger).text();
    expect(text.endsWith("\n")).toBe(true);
    const last = text.trim().split("\n").pop() as string;
    expect(JSON.parse(last)).not.toHaveProperty("pending");
    const proc = Bun.spawn(["bun", "run", "scripts/contracts-check.ts", "usage-record", "-"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Response(last).body,
      cwd: REPO,
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("ok usage-record <- stdin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D2: query output deep-equals the hand-computed expected file", async () => {
  const { dir, ledger } = sandbox();
  try {
    await Bun.write(ledger, Bun.file("tests/fixtures/ledger/ledger.jsonl"));
    const queried = await runCli(["query", "--ledger", ledger, "--by", "provider,host,model"]);
    expect(queried.code).toBe(0);
    const expected = (await Bun.file(
      "tests/fixtures/ledger/query-expected.json",
    ).json()) as unknown;
    expect(JSON.parse(queried.stdout) as unknown).toEqual(expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("query --record prints one JSON line for a known record", async () => {
  const { dir, ledger } = sandbox();
  try {
    await Bun.write(ledger, Bun.file("tests/fixtures/ledger/ledger.jsonl"));
    const queried = await runCli(["query", "--ledger", ledger, "--record", "w1-alpha"]);
    expect(queried.code).toBe(0);
    expect(queried.stdout.endsWith("\n")).toBe(true);
    expect(queried.stdout.trim().split("\n")).toHaveLength(1);
    const record = JSON.parse(queried.stdout) as { workItemId: string };
    expect(record.workItemId).toBe("w1-alpha");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("query --record for a missing id exits 3 and never writes", async () => {
  const { dir, ledger } = sandbox();
  try {
    await Bun.write(ledger, Bun.file("tests/fixtures/ledger/ledger.jsonl"));
    const before = await Bun.file(ledger).text();
    const queried = await runCli(["query", "--ledger", ledger, "--record", "w9-missing"]);
    expect(queried.code).toBe(3);
    expect(queried.stderr).toContain("no record for w9-missing");
    expect(await Bun.file(ledger).text()).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record with a missing completion file exits 2", async () => {
  const { dir, ledger } = sandbox();
  try {
    const missing = join(dir, "no-such-completion.json");
    const recorded = await runCli(["record", "--ledger", ledger, "--completion", missing]);
    expect(recorded.code).toBe(2);
    expect(recorded.stderr).toContain("file is missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record with bad JSON in the completion file exits 2", async () => {
  const { dir, ledger } = sandbox();
  try {
    const completion = join(dir, "bad.json");
    await Bun.write(completion, "{not json");
    const recorded = await runCli(["record", "--ledger", ledger, "--completion", completion]);
    expect(recorded.code).toBe(2);
    expect(recorded.stderr).toContain("not valid JSON");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record with an unknown completion key exits 2", async () => {
  const { dir, ledger } = sandbox();
  try {
    const completion = join(dir, "extra.json");
    const raw = (await Bun.file("tests/fixtures/ledger/finished-task.json").json()) as Record<
      string,
      unknown
    >;
    await Bun.write(completion, JSON.stringify({ ...raw, extra: 1 }));
    const recorded = await runCli(["record", "--ledger", ledger, "--completion", completion]);
    expect(recorded.code).toBe(2);
    expect(recorded.stderr).toContain('must hold exactly "pending" and "finalize"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record with an invalid pending entry exits 2", async () => {
  const { dir, ledger } = sandbox();
  try {
    const completion = join(dir, "invalid.json");
    const raw = (await Bun.file("tests/fixtures/ledger/finished-task.json").json()) as {
      pending: Record<string, unknown>[];
      finalize: unknown;
    };
    await Bun.write(
      completion,
      JSON.stringify({ ...raw, pending: [{ ...raw.pending[0], session: null }] }),
    );
    const recorded = await runCli(["record", "--ledger", ledger, "--completion", completion]);
    expect(recorded.code).toBe(2);
    expect(recorded.stderr).toContain("invalid pending entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record with a missing ledger parent exits 2", async () => {
  const { dir } = sandbox();
  try {
    const ledger = join(dir, "no-such-dir", "ledger.jsonl");
    const recorded = await runCli([
      "record",
      "--ledger",
      ledger,
      "--completion",
      "tests/fixtures/ledger/finished-task.json",
    ]);
    expect(recorded.code).toBe(2);
    expect(recorded.stderr).toContain(ledger);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("query with both --by and --record exits 2", async () => {
  const { dir, ledger } = sandbox();
  try {
    await Bun.write(ledger, Bun.file("tests/fixtures/ledger/ledger.jsonl"));
    const queried = await runCli([
      "query",
      "--ledger",
      ledger,
      "--by",
      "provider",
      "--record",
      "w1-alpha",
    ]);
    expect(queried.code).toBe(2);
    expect(queried.stderr).toContain("exactly one of --by and --record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("query with neither --by nor --record exits 2", async () => {
  const { dir, ledger } = sandbox();
  try {
    await Bun.write(ledger, Bun.file("tests/fixtures/ledger/ledger.jsonl"));
    const queried = await runCli(["query", "--ledger", ledger]);
    expect(queried.code).toBe(2);
    expect(queried.stderr).toContain("exactly one of --by and --record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("query with an unknown --by value exits 2", async () => {
  const { dir, ledger } = sandbox();
  try {
    await Bun.write(ledger, Bun.file("tests/fixtures/ledger/ledger.jsonl"));
    const queried = await runCli(["query", "--ledger", ledger, "--by", "provider,owner"]);
    expect(queried.code).toBe(2);
    expect(queried.stderr).toContain("unknown dimension");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("query with a repeated --by dimension exits 2", async () => {
  const { dir, ledger } = sandbox();
  try {
    await Bun.write(ledger, Bun.file("tests/fixtures/ledger/ledger.jsonl"));
    const queried = await runCli(["query", "--ledger", ledger, "--by", "provider,provider"]);
    expect(queried.code).toBe(2);
    expect(queried.stderr).toContain("must not repeat a dimension");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown flag or a repeated flag exits 2", async () => {
  const { dir, ledger } = sandbox();
  try {
    await Bun.write(ledger, Bun.file("tests/fixtures/ledger/ledger.jsonl"));
    const unknown = await runCli(["query", "--ledger", ledger, "--by", "provider", "--owner", "x"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown flag --owner");
    const repeated = await runCli([
      "query",
      "--ledger",
      ledger,
      "--by",
      "provider",
      "--by",
      "host",
    ]);
    expect(repeated.code).toBe(2);
    expect(repeated.stderr).toContain("repeated flag --by");
    const missingValue = await runCli(["query", "--ledger"]);
    expect(missingValue.code).toBe(2);
    expect(missingValue.stderr).toContain("--ledger needs a value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

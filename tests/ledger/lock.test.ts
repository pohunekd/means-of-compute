// Ledger lock tests: a held flock refuses, a crash releases the lock, and
// the in-process chain serializes absolute and relative paths to one file.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { appendPending, LedgerDataError } from "../../src/ledger/store.js";

function sessionEntry(entryId: string, workItemId: string): Record<string, unknown> {
  return {
    entryId,
    kind: "session",
    workItemId,
    finishedAt: "2026-10-26T10:40:00.000Z",
    startModel: "meta/muse-glimmer-30b",
    tokens: [
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 1000,
        outputTokens: 500,
        requests: 2,
        source: "provider-usage",
      },
    ],
    session: {
      hostAlias: "desktop",
      seconds: 540,
      source: "dispatcher-clock",
      result: "success",
    },
  };
}

const HOLDER_SCRIPT = [
  "import { withLedgerLock } from './src/ledger/lock.js';",
  "await withLedgerLock(process.env.LEDGER_LOCK_TEST_PATH ?? '', async () => {",
  "  console.log('holder ready');",
  "  await new Promise(() => {});",
  "});",
].join("\n");

async function waitForLine(proc: { stdout: unknown }, line: string): Promise<void> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("holder exited before printing the ready line");
      }
      buffered += decoder.decode(value, { stream: true });
      const index = buffered.indexOf("\n");
      if (index >= 0) {
        const first = buffered.slice(0, index);
        if (first !== line) {
          throw new Error(`holder printed unexpected line: ${first}`);
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

test("lock held by another process refuses as LedgerDataError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-lock-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  const child = Bun.spawn(["bun", "-e", HOLDER_SCRIPT], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, LEDGER_LOCK_TEST_PATH: ledgerPath },
  });
  try {
    await waitForLine(child, "holder ready");
    let error: unknown;
    try {
      await appendPending(ledgerPath, sessionEntry("e-held", "w-held") as never);
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LedgerDataError);
    expect((error as Error).message).toContain("held by another process");
  } finally {
    child.kill(9);
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock is released when the holder crashes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-lock-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  const child = Bun.spawn(["bun", "-e", HOLDER_SCRIPT], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, LEDGER_LOCK_TEST_PATH: ledgerPath },
  });
  await waitForLine(child, "holder ready");
  child.kill(9);
  await child.exited;
  try {
    expect(await appendPending(ledgerPath, sessionEntry("e-crash", "w-crash") as never)).toBe(
      "appended",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent appends through absolute and relative paths both succeed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-lock-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const relativePath = relative(process.cwd(), ledgerPath);
    const [first, second] = await Promise.all([
      appendPending(ledgerPath, sessionEntry("e-abs", "w-abs") as never),
      appendPending(relativePath, sessionEntry("e-rel", "w-rel") as never),
    ]);
    expect(first).toBe("appended");
    expect(second).toBe("appended");
    const text = await Bun.file(ledgerPath).text();
    expect(text).toContain('"e-abs"');
    expect(text).toContain('"e-rel"');
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

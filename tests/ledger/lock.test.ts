// Ledger lock tests: a live holder refuses with its pid, a stale lock is
// removed once and the write succeeds. The held case spawns a live child
// and kills it by exact pid in finally.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLedgerLock } from "../../src/ledger/lock.js";

test("lock held by a live child refuses naming its pid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-lock-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  const child = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = child.pid;
  try {
    await Bun.write(`${ledgerPath}.lock`, `${String(pid)}\n`);
    let message = "";
    try {
      await withLedgerLock(ledgerPath, () => Promise.resolve("wrote"));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`ledger lock ${ledgerPath}.lock: held by pid ${String(pid)}`);
  } finally {
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock of an exited child is stale: removed once and the write succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-lock-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  const child = Bun.spawn(["bun", "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = child.pid;
  await child.exited;
  const errors: unknown[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown): boolean => {
    errors.push(chunk);
    return true;
  };
  try {
    await Bun.write(`${ledgerPath}.lock`, `${String(pid)}\n`);
    const result = await withLedgerLock(ledgerPath, () => Promise.resolve("wrote"));
    expect(result).toBe("wrote");
    expect(await Bun.file(`${ledgerPath}.lock`).exists()).toBe(false);
    expect(errors.join("")).toContain(`removed stale lock of pid ${String(pid)}`);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
  }
});

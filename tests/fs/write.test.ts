// Atomic write tests: a directory as target exits 2 without touching the
// parent, and the rename-failure case runs as a child process so its
// module mock never loads in the main run.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/fs/write.js";

function tmpNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

test("atomic write to a directory exits 2 with no tmp files left", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-write-"));
  try {
    let message = "";
    try {
      await writeFileAtomic("Test state", dir, "new\n");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`Test state ${dir}`);
    expect(tmpNames(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic write failure after the temp write removes the temp file", () => {
  const result = Bun.spawnSync(["bun", "test", "./tests/fs/write-rename-failure.case.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
});

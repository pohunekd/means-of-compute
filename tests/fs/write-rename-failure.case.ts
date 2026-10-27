// Rename-failure case: run as a child process from tests/fs/write.test.ts,
// not by the default bun test pattern, so the module mock never loads in
// the main run.
import { expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/fs/write.js";

function tmpNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

test("atomic write failure after the temp write removes the temp file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-write-"));
  const failingPath = join(dir, "state.json");
  const originalRename = fsPromises.rename;
  const failingRename = (from: string, to: string): Promise<void> => {
    if (to === failingPath) {
      throw Object.assign(new Error("mocked rename failure"), { code: "MOCKRENAME" });
    }
    return originalRename(from, to);
  };
  void mock.module("node:fs/promises", () => ({
    ...fsPromises,
    rename: (from: string, to: string): Promise<void> => failingRename(from, to),
  }));
  try {
    const mocked = (await import(
      // @ts-expect-error: query suffix forces a fresh module registry entry
      "../../src/fs/write.js?rename-fail"
    )) as { writeFileAtomic: typeof writeFileAtomic };
    let message = "";
    try {
      await mocked.writeFileAtomic("Test state", failingPath, "new\n");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("MOCKRENAME");
    expect(await Bun.file(failingPath).exists()).toBe(false);
    expect(tmpNames(dir)).toEqual([]);
  } finally {
    mock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

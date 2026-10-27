// Atomic write tests: a successful write lands the text, a directory as
// target exits 2 without touching the parent, and a rename failure after
// the temp write still removes the temp file.
import { expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/fs/write.js";

function tmpNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

test("atomic write lands the text at the target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-write-"));
  try {
    const path = join(dir, "state.json");
    await writeFileAtomic("Test state", path, '{"escalated":[]}\n');
    expect(await Bun.file(path).text()).toBe('{"escalated":[]}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

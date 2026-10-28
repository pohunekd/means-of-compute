// Dispatcher config tests (PR 3c C1): nonTerminalPauseMs is a required
// integer in 0..600000; a missing key or an out-of-range value fails naming
// the key. Boundaries 0 and 600000 load. Deterministic: temp files only.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDispatcherConfig } from "../../src/dispatcher/config.js";

const VALID = {
  baseBranch: "main",
  branchPrefix: "moc/",
  waitTimeoutMs: 60000,
  lostAfterUnreachable: 3,
  nonTerminalPauseMs: 1000,
  unreachableBackoffMs: 5000,
  registryPath: "logs/dispatcher-sessions.json",
};

async function writeConfig(dir: string, value: unknown): Promise<string> {
  const path = join(dir, "dispatcher.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "moc-dispatcher-config-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the checked-in dispatcher config loads with nonTerminalPauseMs 1000", async () => {
  const config = await loadDispatcherConfig();
  expect(config.nonTerminalPauseMs).toBe(1000);
});

const BAD_CASES: ReadonlyArray<readonly [string, unknown, string]> = [
  ["missing key", "absent", "nonTerminalPauseMs"],
  ["minus one", -1, "nonTerminalPauseMs"],
  ["above the ceiling", 600001, "nonTerminalPauseMs"],
  ["fractional", 1.5, "nonTerminalPauseMs"],
];

for (const [name, value, fragment] of BAD_CASES) {
  test(`nonTerminalPauseMs ${name} fails naming the key`, async () => {
    await withTempDir(async (dir) => {
      const record: Record<string, unknown> = { ...VALID };
      if (value === "absent") {
        delete record["nonTerminalPauseMs"];
      } else {
        record["nonTerminalPauseMs"] = value;
      }
      const path = await writeConfig(dir, record);
      let message = "";
      try {
        await loadDispatcherConfig(path);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(fragment);
    });
  });
}

for (const boundary of [0, 600000]) {
  test(`nonTerminalPauseMs ${String(boundary)} loads`, async () => {
    await withTempDir(async (dir) => {
      const path = await writeConfig(dir, { ...VALID, nonTerminalPauseMs: boundary });
      const config = await loadDispatcherConfig(path);
      expect(config.nonTerminalPauseMs).toBe(boundary);
    });
  });
}

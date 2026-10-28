// Loop log tests (matrix rows C2, C3): event order with the injected
// clock, the 0600 file mode, and the latch when a write fails.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLoopLog } from "../../src/loop/log.js";

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-log-"));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("two events give two lines in order with the injected clock (C2)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop.jsonl");
    const times = [new Date("2026-10-28T00:00:01.000Z"), new Date("2026-10-28T00:00:02.000Z")];
    let index = 0;
    const log = await openLoopLog(path, () => {
      const now = times[index] as Date;
      index += 1;
      return now;
    });
    log.log({ event: "round-closed", workItemId: "gh-moc-5", round: 0, code: "red-ci" });
    log.log({ event: "started", workItemId: "gh-moc-5", round: 1, hostAlias: "host-a" });
    await log.close();
    const lines = (await Bun.file(path).text()).split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({
      ts: "2026-10-28T00:00:01.000Z",
      event: "round-closed",
      workItemId: "gh-moc-5",
      round: 0,
      code: "red-ci",
    });
    expect(JSON.parse(lines[1] as string)).toEqual({
      ts: "2026-10-28T00:00:02.000Z",
      event: "started",
      workItemId: "gh-moc-5",
      round: 1,
      hostAlias: "host-a",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

test("a failed write latches and later logs write nothing and do not throw (C3)", async () => {
  await withTempDir(async () => {
    // /dev/full fails every write with ENOSPC: the write latch trips
    // without touching the real filesystem. CI gates run on Linux.
    const log = await openLoopLog("/dev/full", () => new Date("2026-10-28T00:00:01.000Z"));
    expect(log.failed()).toBe(false);
    log.log({ event: "ci", workItemId: "gh-moc-5" });
    for (let attempt = 0; attempt < 100 && !log.failed(); attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(log.failed()).toBe(true);
    expect(() => {
      log.log({ event: "ci", workItemId: "gh-moc-5" });
      log.log({ event: "merged", workItemId: "gh-moc-6" });
    }).not.toThrow();
    await log.close().catch(() => {});
    expect(log.failed()).toBe(true);
  });
});

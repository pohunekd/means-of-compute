// Loop log tests (matrix rows C2, C3): event order with the injected
// clock, the 0600 file mode, and the latch when a write fails.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLoopLog, type LoopLogFs } from "../../src/loop/log.js";

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

test("a burst of events lands in call order (C2)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop.jsonl");
    let tick = 0;
    const log = await openLoopLog(path, () => {
      tick += 1;
      return new Date(Date.UTC(2026, 9, 28, 0, 0, 0, tick));
    });
    for (let round = 0; round < 200; round += 1) {
      log.log({ event: "round-closed", workItemId: "gh-moc-5", round, code: "red-ci" });
    }
    await log.close();
    const lines = (await Bun.file(path).text()).split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(200);
    lines.forEach((line, index) => {
      expect((JSON.parse(line) as { round?: number }).round).toBe(index);
    });
  });
});

// The seam the C3 latch test needs: the first write fails once, then
// later writes would succeed, so the test can show they never happen.
function failingFirstFs(): { fs: LoopLogFs; written: () => number } {
  let writes = 0;
  return {
    written: () => writes,
    fs: {
      async open(target: string): Promise<FileHandle> {
        // Create the file so the empty-content assertion holds, but hand
        // back an in-memory handle: proxying a real FileHandle would leave
        // the inner handle unclosed and trip the runtime GC guard.
        const { open } = await import("node:fs/promises");
        const creator = await open(target, "a", 0o600);
        await creator.close();
        let calls = 0;
        const failing = {
          write(): Promise<unknown> {
            calls += 1;
            writes += 1;
            if (calls === 1) {
              return Promise.reject(new Error("ENOSPC: no space left on device"));
            }
            return Promise.resolve(undefined);
          },
          async sync(): Promise<void> {},
          async close(): Promise<void> {},
        } as unknown as FileHandle;
        return failing;
      },
    },
  };
}

test("a failed write latches and later logs write nothing and do not throw (C3)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop.jsonl");
    const seam = failingFirstFs();
    const log = await openLoopLog(path, {
      fs: seam.fs,
      now: () => new Date("2026-10-28T00:00:01.000Z"),
    });
    expect(log.failed()).toBe(false);
    log.log({ event: "ci", workItemId: "gh-moc-5" });
    log.log({ event: "merged", workItemId: "gh-moc-6" });
    // Awaiting close drains the chain, so the latch is set with no
    // wall-clock wait: the second queued event must never reach the
    // seam, because the latch tripped on the first write.
    await log.close();
    expect(log.failed()).toBe(true);
    expect(seam.written()).toBe(1);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path, "utf8")).toBe("");
    expect(() => {
      log.log({ event: "ci", workItemId: "gh-moc-5" });
      log.log({ event: "merged", workItemId: "gh-moc-7" });
    }).not.toThrow();
  });
});

// Loop state tests (matrix rows L3-L5): revision advance with a deep-equal
// re-read, rule (b) rejection without a write, and the busy path with a
// holder subprocess. Deterministic: temp dirs hold every file.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LoopStateBusyError,
  LoopStateDataError,
  checkLoopState,
  readLoopState,
  updateLoopState,
  type LoopState,
} from "../../src/loop/state.js";

function idleItem(): Record<string, unknown> {
  return {
    phase: "idle",
    round: 0,
    start: null,
    requestId: null,
    pull: null,
    ciSince: null,
    trial: null,
    rounds: [],
    failures: {},
    excludedHosts: [],
    startRejections: 0,
    escalations: [],
    followups: [],
    humanInterventions: 0,
    finalize: null,
    auditAttempts: null,
    mergeAttempts: null,
    backoffUntil: null,
  };
}

function emptyState(): LoopState {
  return checkLoopState(
    {
      schemaVersion: "v1",
      revision: 0,
      items: { "gh-moc-5": idleItem() },
      resolvedApprovals: [],
      mergeHold: null,
      lastDigestDay: null,
    },
    "test",
  );
}

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-state-"));
  return body(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

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

test("an update writes revision n+1 and a re-read is deep-equal (L3)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-state.json");
    await updateLoopState(path, () =>
      Promise.resolve({
        next: { ...emptyState(), items: { "gh-moc-5": idleItem() } },
        value: undefined,
      }),
    );
    const first = await readLoopState(path);
    expect(first.revision).toBe(1);
    await updateLoopState(path, (state) =>
      Promise.resolve({
        next: {
          items: state.items,
          resolvedApprovals: [...state.resolvedApprovals, "approval-1"],
          mergeHold: state.mergeHold,
          lastDigestDay: "2026-10-28",
        },
        value: undefined,
      }),
    );
    const second = await readLoopState(path);
    expect(second.revision).toBe(2);
    expect(second.resolvedApprovals).toEqual(["approval-1"]);
    expect(second.lastDigestDay).toBe("2026-10-28");
    const reread = await readLoopState(path);
    expect(reread).toEqual(second);
  });
});

test("phase starting with start null fails and writes nothing (L4)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-state.json");
    await updateLoopState(path, () =>
      Promise.resolve({
        next: { ...emptyState(), items: { "gh-moc-5": idleItem() } },
        value: undefined,
      }),
    );
    const before = readFileSync(path, "utf8");
    let error: unknown;
    try {
      await updateLoopState(path, () =>
        Promise.resolve({
          next: {
            items: { "gh-moc-5": { ...idleItem(), phase: "starting" } },
            resolvedApprovals: [],
            mergeHold: null,
            lastDigestDay: null,
          },
          value: undefined,
        }),
      );
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopStateDataError);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

test("a lock held by a subprocess gives LoopStateBusyError (L5)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-state.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: "v1",
        revision: 0,
        items: {},
        resolvedApprovals: [],
        mergeHold: null,
        lastDigestDay: null,
      }),
    );
    const before = readFileSync(path, "utf8");
    const child = Bun.spawn(["bun", join(import.meta.dir, "lock-holder.case.ts")], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, LOOP_STATE_TEST_PATH: path },
    });
    try {
      await waitForLine(child, "holder ready");
      let error: unknown;
      try {
        await updateLoopState(path, (state) =>
          Promise.resolve({
            next: {
              items: state.items,
              resolvedApprovals: state.resolvedApprovals,
              mergeHold: state.mergeHold,
              lastDigestDay: state.lastDigestDay,
            },
            value: undefined,
          }),
        );
      } catch (thrown: unknown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(LoopStateBusyError);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      child.kill(9);
      await child.exited;
    }
  });
});

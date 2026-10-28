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
    retry: 0,
    park: null,
    session: null,
    fallbackUsed: false,
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

test("an update writes revision n+1 and the re-read matches the fold (L3, F5)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-state.json");
    let written = emptyState();
    await updateLoopState(path, () =>
      Promise.resolve({
        next: { ...emptyState(), items: { "gh-moc-5": idleItem() } },
        value: undefined,
      }),
    );
    const first = await readLoopState(path);
    expect(first.revision).toBe(1);
    await updateLoopState(path, (state) => {
      const next = {
        items: state.items,
        resolvedApprovals: [...state.resolvedApprovals, "approval-1"],
        mergeHold: state.mergeHold,
        lastDigestDay: "2026-10-28",
      };
      written = { schemaVersion: "v1", revision: state.revision + 1, ...next };
      return Promise.resolve({ next, value: undefined });
    });
    const second = await readLoopState(path);
    expect(second).toEqual(written);
    expect(second.revision).toBe(2);
    expect(second.schemaVersion).toBe("v1");
    expect(second.items["gh-moc-5"]).toEqual(idleItem());
  });
});

test("an item key outside the work-item id shape is rejected (F4)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-state.json");
    let error: unknown;
    try {
      await updateLoopState(path, () =>
        Promise.resolve({
          next: { ...emptyState(), items: { Bad_Id: idleItem() } },
          value: undefined,
        }),
      );
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopStateDataError);
  });
});

test("a misspelled round outcome is rejected (F10)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-state.json");
    let error: unknown;
    try {
      await updateLoopState(path, () =>
        Promise.resolve({
          next: {
            ...emptyState(),
            items: {
              "gh-moc-5": {
                ...idleItem(),
                rounds: [
                  {
                    round: 0,
                    retry: 0,
                    requestId: null,
                    model: "meta/muse-glimmer-30b",
                    providerId: "nvidia-build",
                    hostAlias: null,
                    attempt: "success",
                    outcome: "red_ci",
                    headSha: null,
                    failingChecks: [],
                    verdict: null,
                    newlyMet: [],
                    at: "2026-10-28T00:00:00.000Z",
                    baseRace: false,
                  },
                ],
              },
            },
          },
          value: undefined,
        }),
      );
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopStateDataError);
  });
});

test("rule (f): a stall park with phase running fails (C1)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-state.json");
    let error: unknown;
    try {
      await updateLoopState(path, () =>
        Promise.resolve({
          next: {
            ...emptyState(),
            items: {
              "gh-moc-5": {
                ...idleItem(),
                phase: "running",
                requestId: "req-000001",
                park: { kind: "stall", reason: "stalled: 3 rounds", code: null },
              },
            },
          },
          value: undefined,
        }),
      );
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopStateDataError);
    expect(String(error)).toContain("rule (f)");
  });
});

test("rule (f): a blocked park without a blocked finalize fails (C1)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "loop-state.json");
    let error: unknown;
    try {
      await updateLoopState(path, () =>
        Promise.resolve({
          next: {
            ...emptyState(),
            items: {
              "gh-moc-5": {
                ...idleItem(),
                phase: "idle",
                park: { kind: "blocked", reason: "blocked: retries used", code: null },
              },
            },
          },
          value: undefined,
        }),
      );
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopStateDataError);
    expect(String(error)).toContain("rule (f)");
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

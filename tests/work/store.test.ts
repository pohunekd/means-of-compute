// Work store tests (matrix S1-S10): read rules (a)-(g), absent file,
// missing parent, write revision, null write, busy lock, write check and
// the ready set.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../../contracts/v1/types.js";
import {
  WorkStoreBusyError,
  WorkStoreDataError,
  checkWorkStore,
  readWorkStore,
  readyItems,
  updateWorkStore,
} from "../../src/work/store.js";

function item(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo-repo",
    title: `Item ${id}`,
    goal: `Goal of ${id}`,
    issue: null,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
    ...overrides,
  };
}

function storeOf(items: readonly WorkItem[]): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    revision: 1,
    items,
    submissions: [
      {
        submissionId: "sub-0123456789abcdef",
        digest: `sha256:${"0".repeat(64)}`,
        itemIds: items.map((entry) => entry.id),
        caller: "coordinator",
        submittedAt: "2026-10-28T00:00:00.000Z",
      },
    ],
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value)}\n`);
}

test("absent file with an existing parent reads as revision 0 (S1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  try {
    const store = await readWorkStore(join(dir, "work-items.json"));
    expect(store.revision).toBe(0);
    expect(store.items).toEqual([]);
    expect(store.submissions).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("absent parent is a data error (S2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  rmSync(dir, { recursive: true, force: true });
  let error: unknown;
  try {
    await readWorkStore(join(dir, "work-items.json"));
  } catch (thrown: unknown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(WorkStoreDataError);
});

test("unknown dependency names rule (f) (S3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  try {
    const path = join(dir, "work-items.json");
    await writeJson(path, storeOf([item("a", { dependencies: ["missing"] })]));
    let message = "";
    try {
      await readWorkStore(path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("rule (f)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stored cycle names rule (g) (S4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  try {
    const path = join(dir, "work-items.json");
    await writeJson(
      path,
      storeOf([item("a", { dependencies: ["b"] }), item("b", { dependencies: ["a"] })]),
    );
    let message = "";
    try {
      await readWorkStore(path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("rule (g)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a null item is a data error naming rule (b) (M1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  try {
    const path = join(dir, "work-items.json");
    await writeJson(path, { schemaVersion: "v1", revision: 1, items: [null], submissions: [] });
    let message = "";
    try {
      await readWorkStore(path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("rule (b)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an update that drops an item is refused by rule (h) (M2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  try {
    const path = join(dir, "work-items.json");
    const doc = storeOf([item("a"), item("b", { dependencies: ["a"] })]);
    await writeJson(path, doc);
    const before = readFileSync(path, "utf8");
    let message = "";
    try {
      await updateWorkStore(path, (store) =>
        Promise.resolve({
          next: { items: [item("a")], submissions: store.submissions },
          value: undefined,
        }),
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("rule (h)");
    expect(message).toContain("b");
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an update that changes a submission is refused by rule (h) (M2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  try {
    const path = join(dir, "work-items.json");
    await writeJson(path, storeOf([item("a")]));
    const before = readFileSync(path, "utf8");
    let message = "";
    try {
      await updateWorkStore(path, (store) =>
        Promise.resolve({
          next: {
            items: store.items,
            submissions: store.submissions.map((entry, index) =>
              index === 0 ? { ...entry, caller: "intruder" } : entry,
            ),
          },
          value: undefined,
        }),
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("rule (h)");
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate item id names rule (c) (S5)", () => {
  const path = "unused-for-check";
  let message = "";
  try {
    checkWorkStore(storeOf([item("a"), item("a")]), path);
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("rule (c)");
});

test("update with next bumps the revision and re-reads equal (S6)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  try {
    const path = join(dir, "work-items.json");
    await writeJson(path, { schemaVersion: "v1", revision: 0, items: [], submissions: [] });
    const before = await readWorkStore(path);
    await updateWorkStore(path, (store) =>
      Promise.resolve({
        next: { items: [item("a")], submissions: store.submissions },
        value: undefined,
      }),
    );
    const after = await readWorkStore(path);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.items.map((entry) => entry.id)).toEqual(["a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("null next writes nothing (S7)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  try {
    const path = join(dir, "work-items.json");
    const doc = { schemaVersion: "v1", revision: 4, items: [], submissions: [] };
    await writeJson(path, doc);
    const before = readFileSync(path, "utf8");
    await updateWorkStore(path, () => Promise.resolve({ next: null, value: undefined }));
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("held lock is busy and the file is unchanged (S8)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  const storePath = join(dir, "work-items.json");
  await writeJson(storePath, { schemaVersion: "v1", revision: 0, items: [], submissions: [] });
  const before = readFileSync(storePath, "utf8");
  const child = Bun.spawn(["bun", "./tests/work/lock-holder.case.ts"], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, WORK_STORE_TEST_PATH: storePath },
  });
  try {
    await waitForLine(child, "holder ready");
    let error: unknown;
    try {
      await updateWorkStore(storePath, (store) =>
        Promise.resolve({
          next: { items: [item("a")], submissions: store.submissions },
          value: undefined,
        }),
      );
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(WorkStoreBusyError);
    expect(readFileSync(storePath, "utf8")).toBe(before);
  } finally {
    child.kill(9);
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("next with an item missing title fails and writes nothing (S9)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  try {
    const path = join(dir, "work-items.json");
    await writeJson(path, { schemaVersion: "v1", revision: 0, items: [], submissions: [] });
    const before = readFileSync(path, "utf8");
    const broken = item("a") as unknown as Record<string, unknown>;
    delete broken["title"];
    let error: unknown;
    try {
      await updateWorkStore(path, (store) =>
        Promise.resolve({
          next: { items: [broken as unknown as WorkItem], submissions: store.submissions },
          value: undefined,
        }),
      );
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(WorkStoreDataError);
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ready set holds queued items whose deps are done (S10)", () => {
  const store = {
    schemaVersion: "v1" as const,
    revision: 1,
    items: [
      item("a", { status: "done" }),
      item("b", { dependencies: ["a"] }),
      item("c", { dependencies: ["b"] }),
    ],
    submissions: [],
  };
  expect(readyItems(store).map((entry) => entry.id)).toEqual(["b"]);
});

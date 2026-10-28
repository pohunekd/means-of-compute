// Work store: every write takes the lock, reads the file, applies a pure
// fold, and persists the whole file with one atomic write. Readers take
// no lock: rename is atomic, so a reader sees revision n or n+1 whole.
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { isWorkItem } from "../../contracts/v1/validate.js";
import type { WorkItem } from "../../contracts/v1/types.js";
import { readInputText, statInputPath, InputPathError } from "../fs/input.js";
import { canonicalJson } from "./canonical.js";
import { withFileLock, FileLockError } from "../fs/lock.js";
import { writeFileAtomic } from "../fs/write.js";
import { findCycle } from "./dag.js";
import storeSchema from "./store.schema.json" with { type: "json" };

export interface WorkSubmission {
  readonly submissionId: string;
  readonly digest: string;
  readonly itemIds: readonly string[];
  readonly caller: string;
  readonly submittedAt: string;
}

export interface WorkStore {
  readonly schemaVersion: "v1";
  readonly revision: number;
  readonly items: readonly WorkItem[];
  readonly submissions: readonly WorkSubmission[];
}

export interface WorkStoreBody {
  readonly items: readonly WorkItem[];
  readonly submissions: readonly WorkSubmission[];
}

export class WorkStoreDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkStoreDataError";
  }
}

export class WorkStoreBusyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkStoreBusyError";
  }
}

export class WorkStoreWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkStoreWriteError";
  }
}

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const validateStore = ajv.compile(storeSchema);

const EMPTY_STORE: WorkStore = { schemaVersion: "v1", revision: 0, items: [], submissions: [] };

function shapeErrors(): string {
  const errors = validateStore.errors ?? [];
  const first = errors[0] as { instancePath?: string; keyword?: string } | undefined;
  const path =
    first?.instancePath === "" || first?.instancePath === undefined ? "/" : first.instancePath;
  return `${path} (${String(first?.keyword)})`;
}

export function checkWorkStore(value: unknown, path: string): WorkStore {
  const label = `work store ${path}`;
  if (!validateStore(value)) {
    throw new WorkStoreDataError(`${label}: rule (a): invalid shape at ${shapeErrors()}`);
  }
  const doc = value as {
    readonly items: readonly unknown[];
    readonly submissions: readonly WorkSubmission[];
  };
  for (const item of doc.items) {
    if (!isWorkItem(item)) {
      const id =
        typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined;
      throw new WorkStoreDataError(`${label}: rule (b): item ${String(id)} is not a WorkItem`);
    }
  }
  const items = doc.items as readonly WorkItem[];
  const seenIds = new Set<string>();
  for (const item of items) {
    if (seenIds.has(item.id)) {
      throw new WorkStoreDataError(`${label}: rule (c): duplicate item id "${item.id}"`);
    }
    seenIds.add(item.id);
  }
  const seenSubmissions = new Set<string>();
  for (const submission of doc.submissions) {
    if (seenSubmissions.has(submission.submissionId)) {
      throw new WorkStoreDataError(
        `${label}: rule (d): duplicate submission id "${submission.submissionId}"`,
      );
    }
    seenSubmissions.add(submission.submissionId);
  }
  const submittedItems = new Set<string>();
  for (const submission of doc.submissions) {
    for (const id of submission.itemIds) {
      if (!seenIds.has(id)) {
        throw new WorkStoreDataError(
          `${label}: rule (e): submission "${submission.submissionId}" names unknown item "${id}"`,
        );
      }
      if (submittedItems.has(id)) {
        throw new WorkStoreDataError(`${label}: rule (e): item "${id}" is in two submissions`);
      }
      submittedItems.add(id);
    }
  }
  for (const item of items) {
    for (const dep of item.dependencies) {
      if (!seenIds.has(dep)) {
        throw new WorkStoreDataError(
          `${label}: rule (f): item "${item.id}" depends on unknown item "${dep}"`,
        );
      }
    }
  }
  const cycle = findCycle(items);
  if (cycle !== null) {
    throw new WorkStoreDataError(
      `${label}: rule (g): cycle edge ${cycle.from} -> ${cycle.to} (${cycle.cycle.join(" -> ")})`,
    );
  }
  const store = value as unknown as WorkStore;
  return { schemaVersion: "v1", revision: store.revision, items, submissions: store.submissions };
}

export async function readWorkStore(path: string): Promise<WorkStore> {
  const label = "work store";
  let status: "absent" | "file";
  try {
    status = await statInputPath(label, path);
  } catch (error: unknown) {
    throw new WorkStoreDataError(`${label} ${path}: cannot stat path`, { cause: error });
  }
  if (status === "absent") {
    return { ...EMPTY_STORE, items: [], submissions: [] };
  }
  let text: string;
  try {
    text = await readInputText(label, path);
  } catch (error: unknown) {
    throw new WorkStoreDataError(`${label} ${path}: cannot read file`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new WorkStoreDataError(`${label} ${path}: not valid JSON`, { cause: error });
  }
  return checkWorkStore(raw, path);
}

function toInputError(error: unknown, label: string, path: string): WorkStoreWriteError {
  if (error instanceof InputPathError) {
    return new WorkStoreWriteError(error.message, { cause: error });
  }
  return new WorkStoreWriteError(
    `${label} ${path}: cannot write file (${String((error as NodeJS.ErrnoException).code)})`,
    { cause: error },
  );
}

// Append-only rule (h): no write may drop a stored item or change a
// stored submission. Item fields other than id may change in place (W7
// status transitions), and new items and submissions may be appended.
function checkAppendOnly(label: string, oldStore: WorkStore, next: WorkStoreBody): void {
  const nextIds = new Set(next.items.map((entry) => entry.id));
  for (const item of oldStore.items) {
    if (!nextIds.has(item.id)) {
      throw new WorkStoreDataError(
        `${label}: rule (h): item "${item.id}" is missing from the next store`,
      );
    }
  }
  for (let index = 0; index < oldStore.submissions.length; index += 1) {
    const before = oldStore.submissions[index] as WorkSubmission;
    const after = next.submissions[index];
    if (after === undefined || canonicalJson(after) !== canonicalJson(before)) {
      throw new WorkStoreDataError(`${label}: rule (h): submission ${String(index)} changed`);
    }
  }
}

export async function updateWorkStore<T>(
  path: string,
  fn: (store: WorkStore) => Promise<{ readonly next: WorkStoreBody | null; readonly value: T }>,
): Promise<T> {
  let result: { readonly next: WorkStoreBody | null; readonly value: T };
  try {
    result = await withFileLock("work store lock", path, async () => {
      const store = await readWorkStore(path);
      const r = await fn(store);
      if (r.next === null) {
        return r;
      }
      checkAppendOnly(`work store ${path}`, store, r.next);
      const next: WorkStore = {
        schemaVersion: "v1",
        revision: store.revision + 1,
        items: r.next.items,
        submissions: r.next.submissions,
      };
      checkWorkStore(next, path);
      try {
        await writeFileAtomic("work store", path, `${JSON.stringify(next)}\n`);
      } catch (error: unknown) {
        throw toInputError(error, "work store", path);
      }
      return r;
    });
  } catch (error: unknown) {
    if (error instanceof FileLockError) {
      if (error.code === "busy") {
        throw new WorkStoreBusyError(error.message, { cause: error });
      }
      if (error.code === "open-failed") {
        throw new WorkStoreDataError(error.message, { cause: error });
      }
      throw new WorkStoreWriteError(error.message, { cause: error });
    }
    throw error;
  }
  return result.value;
}

export function readyItems(store: WorkStore): readonly WorkItem[] {
  const done = new Set<string>();
  for (const item of store.items) {
    if (item.status === "done") {
      done.add(item.id);
    }
  }
  return store.items.filter(
    (item) => item.status === "queued" && item.dependencies.every((dep) => done.has(dep)),
  );
}

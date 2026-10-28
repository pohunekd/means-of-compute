// submit_work predicates (S2): steps 1-6 are pure and run before the
// lock; steps 7-12 run inside updateWorkStore through applySubmission.
// Item i goes in submission order; an edge a -> b means a depends on b.
import { contractErrors, isWorkItem } from "../../contracts/v1/validate.js";
import type { WorkItem } from "../../contracts/v1/types.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { findCycle } from "./dag.js";
import type { WorkStore, WorkStoreBody } from "./store.js";

export interface SubmitRefusal {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type SubmitResult =
  | {
      readonly kind: "ok";
      readonly submissionId: string;
      readonly itemIds: readonly string[];
      readonly revision: number;
      readonly replayed: boolean;
    }
  | { readonly kind: "refused"; readonly refusal: SubmitRefusal };

function initialField(item: WorkItem): string | null {
  if (item.status !== "queued") {
    return "status";
  }
  if (item.statusReason !== null) {
    return "statusReason";
  }
  if (item.assignedHostAlias !== null) {
    return "assignedHostAlias";
  }
  if (item.branch !== null) {
    return "branch";
  }
  if (item.pullNumber !== null) {
    return "pullNumber";
  }
  if (item.retryCount !== 0) {
    return "retryCount";
  }
  if (item.stallRounds !== 0) {
    return "stallRounds";
  }
  if (item.modelRouting.attempts !== 0) {
    return "modelRouting.attempts";
  }
  if (item.modelRouting.fallbackUsed !== false) {
    return "modelRouting.fallbackUsed";
  }
  for (let index = 0; index < item.dod.length; index += 1) {
    const entry = item.dod[index];
    if (entry !== undefined && entry.done !== false) {
      return `dod[${String(index)}].done`;
    }
  }
  return null;
}

export function checkItems(
  items: readonly unknown[],
  maxItemBytes: number,
  models: readonly string[],
  repos: ReadonlySet<string>,
): SubmitRefusal | null {
  for (let index = 0; index < items.length; index += 1) {
    if (Buffer.byteLength(canonicalJson(items[index]), "utf8") > maxItemBytes) {
      return {
        code: "item-too-large",
        message: `item ${String(index)} exceeds ${String(maxItemBytes)} bytes`,
        details: { index, limit: maxItemBytes },
      };
    }
  }
  for (let index = 0; index < items.length; index += 1) {
    const item: unknown = items[index];
    if (!isWorkItem(item)) {
      const errors = contractErrors("work-item", item) as readonly {
        readonly instancePath?: string;
        readonly keyword?: string;
      }[] | null;
      const first = errors?.[0];
      const path =
        first?.instancePath === "" || first?.instancePath === undefined
          ? "/"
          : first.instancePath;
      const keyword = String(first?.keyword);
      return {
        code: "contract-invalid",
        message: `item ${String(index)} fails the WorkItem contract at ${path} (${keyword})`,
        details: { index, path, keyword },
      };
    }
  }
  const workItems = items as readonly WorkItem[];
  for (let index = 0; index < workItems.length; index += 1) {
    const item = workItems[index] as WorkItem;
    const field = initialField(item);
    if (field !== null) {
      return {
        code: "loop-state-not-initial",
        message: `item ${item.id}: ${field} must have its initial value`,
        details: { index, id: item.id, field },
      };
    }
  }
  for (let index = 0; index < workItems.length; index += 1) {
    const item = workItems[index] as WorkItem;
    if (!repos.has(item.repo)) {
      return {
        code: "repo-not-configured",
        message: `item ${item.id}: repo ${item.repo} is not configured`,
        details: { index, id: item.id, repo: item.repo },
      };
    }
  }
  for (let index = 0; index < workItems.length; index += 1) {
    const item = workItems[index] as WorkItem;
    if (!models.includes(item.modelRouting.preferredModel)) {
      return {
        code: "model-not-allowed",
        message: `item ${item.id}: model ${item.modelRouting.preferredModel} is not allowed`,
        details: { index, id: item.id, model: item.modelRouting.preferredModel },
      };
    }
  }
  for (let j = 1; j < workItems.length; j += 1) {
    const id = (workItems[j] as WorkItem).id;
    for (let i = 0; i < j; i += 1) {
      if ((workItems[i] as WorkItem).id === id) {
        return {
          code: "duplicate-id",
          message: `duplicate id ${id} at items ${String(i)} and ${String(j)}`,
          details: { id, indices: [i, j] },
        };
      }
    }
  }
  return null;
}

export function applySubmission(
  store: WorkStore,
  items: readonly WorkItem[],
  caller: string,
  submittedAt: string,
  maxStoreItems: number,
): { readonly next: WorkStoreBody | null; readonly value: SubmitResult } {
  const digest = `sha256:${sha256Hex(canonicalJson(items))}`;
  const replay = store.submissions.find((entry) => entry.digest === digest);
  if (replay !== undefined) {
    return {
      next: null,
      value: {
        kind: "ok",
        submissionId: replay.submissionId,
        itemIds: [...replay.itemIds],
        revision: store.revision,
        replayed: true,
      },
    };
  }
  const storeIds = new Set(store.items.map((entry) => entry.id));
  const existing = items.filter((entry) => storeIds.has(entry.id)).map((entry) => entry.id);
  if (existing.length > 0) {
    return {
      next: null,
      value: {
        kind: "refused",
        refusal: {
          code: "id-exists",
          message: `ids already in the store: ${existing.join(", ")}`,
          details: { ids: existing },
        },
      },
    };
  }
  const submissionIds = new Set(items.map((entry) => entry.id));
  for (const item of items) {
    for (const dep of item.dependencies) {
      if (!submissionIds.has(dep) && !storeIds.has(dep)) {
        return {
          next: null,
          value: {
            kind: "refused",
            refusal: {
              code: "unknown-dependency",
              message: `unknown dependency ${item.id} -> ${dep}`,
              details: { edge: { from: item.id, to: dep } },
            },
          },
        };
      }
    }
  }
  const cycle = findCycle(items);
  if (cycle !== null) {
    return {
      next: null,
      value: {
        kind: "refused",
        refusal: {
          code: "dag-cycle",
          message: `cycle edge ${cycle.from} -> ${cycle.to} (${cycle.cycle.join(" -> ")})`,
          details: { edge: { from: cycle.from, to: cycle.to }, cycle: [...cycle.cycle] },
        },
      },
    };
  }
  if (store.items.length + items.length > maxStoreItems) {
    return {
      next: null,
      value: {
        kind: "refused",
        refusal: {
          code: "store-full",
          message: `store holds at most ${String(maxStoreItems)} items`,
          details: { limit: maxStoreItems },
        },
      },
    };
  }
  const submissionId = `sub-${digest.slice("sha256:".length, "sha256:".length + 16)}`;
  const itemIds = items.map((entry) => entry.id);
  return {
    next: {
      items: [...store.items, ...items],
      submissions: [
        ...store.submissions,
        { submissionId, digest, itemIds, caller, submittedAt },
      ],
    },
    value: { kind: "ok", submissionId, itemIds, revision: store.revision + 1, replayed: false },
  };
}

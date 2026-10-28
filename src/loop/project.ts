// Work store projection: every store field the loop owns is an absolute
// value computed from the loop item, so replaying a write is a no-op.
// reconcile rewrites a differing store item and reports busy locks.
import type { WorkItem, WorkItemStatus } from "../../contracts/v1/types.js";
import type { ModelRouting } from "../../contracts/v1/types.js";
import { canonicalJson } from "../work/canonical.js";
import { updateWorkStore, WorkStoreBusyError } from "../work/store.js";
import { LoopStateDataError } from "./state.js";
import { attemptsOnPreferred, stallRoundsOf } from "./policy.js";
import type { LoopItem } from "./types.js";

export interface ProjectionContext {
  readonly branchPrefix: string;
}

export interface WorkItemProjection {
  readonly status: WorkItemStatus;
  readonly statusReason: string | null;
  readonly assignedHostAlias: string | null;
  readonly branch: string | null;
  readonly pullNumber: number | null;
  readonly modelRouting: ModelRouting;
  readonly retryCount: number;
  readonly stallRounds: number;
  readonly dodDone: boolean;
}

export function projectStatus(li: LoopItem): WorkItemStatus {
  if (li.finalize?.result === "success") {
    return "done";
  }
  if (li.park?.kind === "blocked") {
    return "blocked";
  }
  if (li.park !== null) {
    return "parked";
  }
  if (li.phase === "running" || li.phase === "publishing") {
    return "running";
  }
  if (
    li.phase === "ci" ||
    li.phase === "auditing" ||
    li.phase === "merging" ||
    li.phase === "awaiting-approval"
  ) {
    return "review";
  }
  return "queued";
}

export function project(item: WorkItem, li: LoopItem, ctx: ProjectionContext): WorkItemProjection {
  const hasHead = li.pull !== null || li.rounds.some((record) => record.headSha !== null);
  return {
    status: projectStatus(li),
    statusReason: li.park?.reason ?? null,
    assignedHostAlias: li.session?.hostAlias ?? null,
    branch: hasHead ? `${ctx.branchPrefix}${item.id}` : null,
    pullNumber: li.pull?.number ?? null,
    modelRouting: {
      preferredModel: item.modelRouting.preferredModel,
      // start-rejected and lost rounds never count toward attempts; refused closes no round.
      attempts: attemptsOnPreferred(
        item,
        li.rounds.filter(
          (record) => record.outcome !== "start-rejected" && record.outcome !== "lost",
        ),
        li.session?.model ?? null,
      ),
      fallbackUsed: li.fallbackUsed,
    },
    retryCount: li.retry,
    stallRounds: stallRoundsOf(li.rounds, li.retry),
    dodDone: li.finalize?.result === "success",
  };
}

export function applyProjection(item: WorkItem, p: WorkItemProjection): WorkItem {
  return {
    ...item,
    status: p.status,
    statusReason: p.statusReason,
    assignedHostAlias: p.assignedHostAlias,
    branch: p.branch,
    pullNumber: p.pullNumber,
    modelRouting: p.modelRouting,
    retryCount: p.retryCount,
    stallRounds: p.stallRounds,
    dod: item.dod.map((entry) => ({ ...entry, done: p.dodDone })),
  };
}

export type ReconcileResult = "unchanged" | "written" | "busy";

export async function reconcile(
  storePath: string,
  id: string,
  li: LoopItem,
  ctx: ProjectionContext,
): Promise<ReconcileResult> {
  try {
    return await updateWorkStore(storePath, (store) => {
      const item = store.items.find((entry) => entry.id === id);
      if (item === undefined) {
        throw new LoopStateDataError(
          `work store ${storePath}: rule (a): item "${id}" is not in the work store`,
        );
      }
      const next = applyProjection(item, project(item, li, ctx));
      if (canonicalJson(next) === canonicalJson(item)) {
        return Promise.resolve({ next: null, value: "unchanged" as const });
      }
      const items = store.items.map((entry) => (entry.id === id ? next : entry));
      return Promise.resolve({
        next: { items, submissions: store.submissions },
        value: "written" as const,
      });
    });
  } catch (error: unknown) {
    if (error instanceof WorkStoreBusyError) {
      return "busy";
    }
    throw error;
  }
}

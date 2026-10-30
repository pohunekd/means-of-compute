import type { WorkStore } from "./store.js";

export interface WorkSummary {
  readonly revision: number;
  readonly total: number;
  readonly byStatus: {
    readonly queued: number;
    readonly running: number;
    readonly review: number;
    readonly parked: number;
    readonly blocked: number;
    readonly done: number;
  };
}

export function summarizeStore(store: WorkStore): WorkSummary {
  const byStatus = {
    queued: 0,
    running: 0,
    review: 0,
    parked: 0,
    blocked: 0,
    done: 0,
  };

  for (const item of store.items) {
    switch (item.status) {
      case "queued":
        byStatus.queued += 1;
        break;
      case "running":
        byStatus.running += 1;
        break;
      case "review":
        byStatus.review += 1;
        break;
      case "parked":
        byStatus.parked += 1;
        break;
      case "blocked":
        byStatus.blocked += 1;
        break;
      case "done":
        byStatus.done += 1;
        break;
    }
  }

  return {
    revision: store.revision,
    total: store.items.length,
    byStatus,
  };
}

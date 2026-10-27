// Dashboard page model: a pure value the renderer turns into HTML.
// buildDashboard and the panel builders arrive in the next step; this part
// holds the shared types and the work-row selection gatherInputs needs.
import type { DashboardInputs, InputErrorCode } from "./inputs.js";

export type Cell =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "aliases"; readonly aliases: readonly string[] }
  | { readonly kind: "no-data"; readonly reason: string }
  | { readonly kind: "error"; readonly code: InputErrorCode };

export interface Figure {
  readonly label: string;
  readonly cell: Cell;
  readonly source: string;
}

export interface Table {
  readonly caption: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
  readonly source: string;
  readonly note: string | null;
}

export type PanelId = "fleet" | "work" | "usage" | "savings" | "autonomy";

export type PanelTitle = "Fleet" | "Work" | "Usage" | "Savings" | "Autonomy";

export interface Panel {
  readonly id: PanelId;
  readonly title: PanelTitle;
  readonly figures: readonly Figure[];
  readonly tables: readonly Table[];
}

export interface DashboardModel {
  readonly renderedAt: string;
  readonly utcDay: string;
  readonly logPath: string;
  readonly panels: readonly Panel[];
}

// Row selection for the Work table (rule 5.2.1). The ids are the union of
// ledger record and pending workItemIds plus work item ids when a source
// exists. Activity is the newest finishedAt across the item's records and
// pending entries; rows sort by activity descending with null last, then by
// id ascending. gatherInputs reads verdicts only for the shown ids.
export function workRows(inputs: Omit<DashboardInputs, "verdicts">): {
  readonly shown: readonly string[];
  readonly total: number;
} {
  const ids = new Set<string>();
  if (inputs.ledger.ok) {
    for (const record of inputs.ledger.value.records) {
      ids.add(record.workItemId);
    }
    for (const entry of inputs.ledger.value.pending) {
      ids.add(entry.workItemId);
    }
  }
  if (inputs.workItems !== null) {
    for (const item of inputs.workItems) {
      ids.add(item.id);
    }
  }
  const activityOf = (id: string): number | null => {
    if (!inputs.ledger.ok) {
      return null;
    }
    let latest: number | null = null;
    for (const record of inputs.ledger.value.records) {
      if (record.workItemId !== id) {
        continue;
      }
      const at = Date.parse(record.finishedAt);
      if (latest === null || at > latest) {
        latest = at;
      }
    }
    for (const entry of inputs.ledger.value.pending) {
      if (entry.workItemId !== id) {
        continue;
      }
      const at = Date.parse(entry.finishedAt);
      if (latest === null || at > latest) {
        latest = at;
      }
    }
    return latest;
  };
  const ordered = [...ids].sort((a, b) => {
    const activityA = activityOf(a);
    const activityB = activityOf(b);
    if (activityA !== null && activityB !== null && activityA !== activityB) {
      return activityB - activityA;
    }
    if (activityA === null && activityB !== null) {
      return 1;
    }
    if (activityA !== null && activityB === null) {
      return -1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return { shown: ordered.slice(0, inputs.workRowLimit), total: ordered.length };
}

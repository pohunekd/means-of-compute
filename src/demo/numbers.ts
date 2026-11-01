import type { UsageRecord } from "../../contracts/v1/types.js";
import type { LedgerContents } from "../ledger/types.js";
import { buildDashboard } from "../dashboard/model.js";
import type { DashboardInputs } from "../dashboard/inputs.js";
import type { BudgetConfig } from "../budget/config.js";
import type { NanoPricing } from "../budget/pricing.js";
import { isPriced } from "../budget/cost.js";
import { groupDigits } from "../dashboard/money.js";
import type { DashboardConfig } from "../dashboard/config.js";

export interface ProviderClasses {
  readonly local: ReadonlySet<string>;
  readonly cloud: ReadonlySet<string>;
}

export interface NumbersInputs {
  readonly ledgerPath: string;
  readonly ledger: LedgerContents;
  readonly pricing: ReadonlyMap<string, NanoPricing>;
  readonly dashboard: DashboardConfig;
  readonly budget: BudgetConfig;
  readonly route: readonly string[];
  readonly classes: ProviderClasses;
  readonly now: Date;
}

export interface NumbersRow {
  readonly label: string;
  readonly cells: readonly string[];
  readonly source: string;
}

export interface BenchmarkNumbers {
  readonly ledgerPath: string;
  readonly records: number;
  readonly pending: number;
  readonly figures: readonly NumbersRow[];
  readonly models: readonly NumbersRow[];
}

function mdCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}

function idList(ids: Iterable<string>): string {
  const sorted = [...new Set(ids)].sort();
  return sorted.length === 0 ? "none" : sorted.join(", ");
}

function cellText(cell: import("../dashboard/model.js").Cell): string {
  if (cell.kind === "text") {
    return cell.text;
  }
  if (cell.kind === "no-data") {
    return `no data (${cell.reason})`;
  }
  throw new Error(`demo:numbers: unexpected ${cell.kind} cell`);
}

function getFigure(
  model: ReturnType<typeof buildDashboard>,
  panelId: string,
  label: string,
): import("../dashboard/model.js").Figure {
  const panel = model.panels.find((p) => p.id === panelId);
  if (!panel) {
    throw new Error(`demo:numbers: dashboard panel "${panelId}" missing`);
  }
  const figure = panel.figures.find((f) => f.label === label);
  if (!figure) {
    throw new Error(`demo:numbers: dashboard figure "${label}" missing in panel ${panelId}`);
  }
  return figure;
}

function localShare(records: readonly UsageRecord[], classes: ProviderClasses): string {
  const nullIds = records
    .filter((r) =>
      r.tokens.some(
        (t: import("../../contracts/v1/types.js").TokenUsage) =>
          t.inputTokens === null || t.outputTokens === null,
      ),
    )
    .map((r) => r.workItemId);
  if (nullIds.length > 0) return `no data (token counts not reported for ${idList(nullIds)})`;
  const unmeasured = records
    .filter((r) =>
      r.tokens.some(
        (t: import("../../contracts/v1/types.js").TokenUsage) => t.unmeasuredRequests !== undefined,
      ),
    )
    .map((r) => r.workItemId);
  if (unmeasured.length > 0) return `no data (requests without usage for ${idList(unmeasured)})`;
  let local = 0;
  let total = 0;
  for (const record of records) {
    for (const token of record.tokens) {
      const count = (token.inputTokens ?? 0) + (token.outputTokens ?? 0);
      total += count;
      if (classes.local.has(token.provider)) local += count;
    }
  }
  if (total === 0) return "no data (no tokens in ledger records)";
  return `${(local / total).toFixed(4)} local (${groupDigits(local)} of ${groupDigits(total)} tokens)`;
}

function unmeasuredRequestsFor(records: readonly UsageRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const r of records) {
    if (
      r.tokens.some(
        (t: import("../../contracts/v1/types.js").TokenUsage) => t.unmeasuredRequests !== undefined,
      )
    ) {
      ids.add(r.workItemId);
    }
  }
  return ids;
}

function nullTokenIdsFor(
  records: readonly UsageRecord[],
  pricedOnly: boolean,
  pricing?: ReadonlyMap<string, NanoPricing>,
): Set<string> {
  const ids = new Set<string>();
  for (const r of records) {
    const hasNull = r.tokens.some((t: import("../../contracts/v1/types.js").TokenUsage) => {
      const nullCount = t.inputTokens === null || t.outputTokens === null;
      if (!nullCount) return false;
      if (!pricedOnly) return true;
      const entry = pricing?.get(t.provider);
      return entry !== undefined && isPriced(entry);
    });
    if (hasNull) ids.add(r.workItemId);
  }
  return ids;
}
export function buildNumbers(inputs: NumbersInputs): BenchmarkNumbers {
  const { ledgerPath, ledger, pricing, dashboard, budget, route, classes, now } = inputs;

  const allProviders = new Set<string>();
  for (const record of ledger.records) {
    for (const token of record.tokens) {
      allProviders.add(token.provider);
    }
  }
  for (const pending of ledger.pending) {
    for (const token of pending.tokens) {
      allProviders.add(token.provider);
    }
  }
  for (const provider of allProviders) {
    if (!classes.local.has(provider) && !classes.cloud.has(provider)) {
      throw new Error(
        `demo:numbers: provider ${provider} is not classified in config/demo-numbers.json`,
      );
    }
  }

  const dashboardInputs: DashboardInputs = {
    now,
    budget,
    route,
    baselines: dashboard.baselines,
    workRowLimit: dashboard.workRowLimit,
    logPath: dashboard.logPath,
    ledger: { ok: true, value: ledger },
    pricing: { ok: true, value: pricing },
    hosts: { ok: false, failure: { kind: "no-data", reason: "not used by demo:numbers" } },
    registry: { ok: true, value: [] },
    results: { ok: false, failure: { kind: "no-data", reason: "not used by demo:numbers" } },
    verdicts: new Map(),
    workItems: null,
  };

  const model = buildDashboard(dashboardInputs);

  const records = ledger.records;
  const pending = ledger.pending;

  const unmeasuredIds = unmeasuredRequestsFor(records);
  const nullIdsAll = nullTokenIdsFor(records, false);
  const nullIdsPriced = nullTokenIdsFor(records, true, pricing);

  const recordIds = records.map((r) => r.workItemId);
  const successIds = records.filter((r) => r.result === "success").map((r) => r.workItemId);
  const blockedIds = records.filter((r) => r.result === "blocked").map((r) => r.workItemId);

  const localIds: string[] = [];
  const cloudIds: string[] = [];
  for (const r of records) {
    let hasLocal = false;
    let hasCloud = false;
    for (const t of r.tokens) {
      if (classes.local.has(t.provider)) hasLocal = true;
      if (classes.cloud.has(t.provider)) hasCloud = true;
    }
    if (hasLocal) localIds.push(r.workItemId);
    if (hasCloud) cloudIds.push(r.workItemId);
  }

  const modelToIds = new Map<string, Set<string>>();
  for (const r of records) {
    for (const attempt of r.attempts) {
      let set = modelToIds.get(attempt.model);
      if (!set) {
        set = new Set();
        modelToIds.set(attempt.model, set);
      }
      set.add(r.workItemId);
    }
  }

  const rows: NumbersRow[] = [];

  const finishedTasksFigure = getFigure(model, "autonomy", "Finished tasks");
  const tasksSource = `${finishedTasksFigure.source}; rows: success: ${idList(successIds)}; blocked: ${idList(blockedIds)}; config: none (count, no price)`;
  rows.push({
    label: "Tasks completed",
    cells: [mdCell(cellText(finishedTasksFigure.cell))],
    source: tasksSource,
  });

  const localShareCell = localShare(records, classes);
  const localProviderIds = [...classes.local].sort();
  const cloudProviderIds = [...classes.cloud].sort();
  const localShareBase = `ledger records tokens[] input plus output, auditor tokens included; config/demo-numbers.json localProviderIds [${localProviderIds.join(", ")}], cloudProviderIds [${cloudProviderIds.join(", ")}]`;
  const localShareSource = `${localShareBase}; rows: local: ${idList(localIds)}; cloud: ${idList(cloudIds)}`;
  rows.push({
    label: "Local token share",
    cells: [mdCell(localShareCell)],
    source: localShareSource,
  });

  const actualCostFigure = getFigure(model, "savings", "Actual token cost");
  let actualCostText = cellText(actualCostFigure.cell);
  if (actualCostFigure.cell.kind === "text" && nullIdsPriced.size > 0) {
    actualCostText = `no data (token counts not reported for ${idList(nullIdsPriced)})`;
  } else if (actualCostFigure.cell.kind !== "no-data" && unmeasuredIds.size > 0) {
    const unmeasuredPriced = new Set<string>();
    for (const r of records) {
      for (const t of r.tokens) {
        if (t.unmeasuredRequests !== undefined) {
          const entry = pricing.get(t.provider);
          if (entry && isPriced(entry)) {
            unmeasuredPriced.add(r.workItemId);
          }
        }
      }
    }
    if (unmeasuredPriced.size > 0) {
      actualCostText = `no data (requests without usage for ${idList(unmeasuredPriced)})`;
    }
  }
  const actualCostSource = `${actualCostFigure.source}; rows: ${idList(recordIds)}`;
  rows.push({
    label: "Actual token cost",
    cells: [mdCell(actualCostText)],
    source: actualCostSource,
  });

  const frontierFigure = getFigure(model, "savings", "Frontier-token baseline");
  let frontierText = cellText(frontierFigure.cell);
  if (frontierFigure.cell.kind === "text" && nullIdsAll.size > 0) {
    frontierText = `no data (token counts not reported for ${idList(nullIdsAll)})`;
  } else if (frontierFigure.cell.kind !== "no-data" && unmeasuredIds.size > 0) {
    frontierText = `no data (requests without usage for ${idList(unmeasuredIds)})`;
  }
  const frontierSource = `${frontierFigure.source}; rows: ${idList(recordIds)}`;
  rows.push({
    label: "Frontier-token baseline",
    cells: [mdCell(frontierText)],
    source: frontierSource,
  });

  const cloudFigure = getFigure(model, "savings", "Cloud sandbox baseline");
  const cloudSource = `${cloudFigure.source}; rows: ${idList(recordIds)}`;
  rows.push({
    label: "Cloud sandbox baseline",
    cells: [mdCell(cellText(cloudFigure.cell))],
    source: cloudSource,
  });

  const ownedFigure = getFigure(model, "savings", "Owned compute cost");
  const ownedSource = `${ownedFigure.source}; rows: ${idList(recordIds)}`;
  rows.push({
    label: "Owned compute cost",
    cells: [mdCell(cellText(ownedFigure.cell))],
    source: ownedSource,
  });

  const interventionsFigure = getFigure(model, "autonomy", "Human interventions");
  const interventionsWithNonZero: string[] = [];
  for (const r of records) {
    if (r.humanInterventions > 0) {
      interventionsWithNonZero.push(`${r.workItemId} (${String(r.humanInterventions)})`);
    }
  }
  interventionsWithNonZero.sort();
  const interventionsCitation =
    interventionsWithNonZero.length === 0
      ? `none nonzero of ${String(records.length)} records`
      : `${interventionsWithNonZero.join(", ")} of ${String(records.length)} records`;
  const interventionsSource = `${interventionsFigure.source}; rows: ${interventionsCitation}; config: none (count, no price)`;
  rows.push({
    label: "Human interventions",
    cells: [mdCell(cellText(interventionsFigure.cell))],
    source: interventionsSource,
  });

  const retriesFigure = getFigure(model, "autonomy", "Retries");
  const retriesWithNonZero: string[] = [];
  for (const r of records) {
    if (r.retries > 0) {
      retriesWithNonZero.push(`${r.workItemId} (${String(r.retries)})`);
    }
  }
  retriesWithNonZero.sort();
  const retriesCitation =
    retriesWithNonZero.length === 0
      ? `none nonzero of ${String(records.length)} records`
      : `${retriesWithNonZero.join(", ")} of ${String(records.length)} records`;
  const retriesSource = `${retriesFigure.source}; rows: ${retriesCitation}; config: none (count, no price)`;
  rows.push({
    label: "Retries",
    cells: [mdCell(cellText(retriesFigure.cell))],
    source: retriesSource,
  });

  const pendingIds = pending.map((p) => p.entryId);
  const pendingSource = `ledger pending entries; rows: ${idList(pendingIds)}; config: none (count, no price)`;
  const pendingCount = pending.length;
  const unfinalizedText = pendingCount === 0 ? "0" : `${String(pendingCount)} (in no figure above)`;
  rows.push({
    label: "Unfinalized entries",
    cells: [mdCell(unfinalizedText)],
    source: pendingSource,
  });

  const autonomyPanel = model.panels.find((p) => p.id === "autonomy");
  if (!autonomyPanel) {
    throw new Error("demo:numbers: autonomy panel missing");
  }
  const sessionsTable = autonomyPanel.tables.find(
    (t) => t.caption === "Sessions per model (finished tasks)",
  );
  if (!sessionsTable) {
    throw new Error("demo:numbers: Sessions per model table missing");
  }
  const modelRows: NumbersRow[] = [];
  const tableSource = sessionsTable.source;
  for (const rowCells of sessionsTable.rows) {
    const cells = rowCells.map(cellText);
    const modelId = cells[0] ?? "";
    const sessions = cells[1] ?? "";
    const finished = cells[2] ?? "";
    const ids = modelToIds.get(modelId);
    const citation = idList(ids ?? []);
    const source = `${tableSource}; rows: ${citation}; config: none (count, no price)`;
    modelRows.push({
      label: modelId,
      cells: [mdCell(sessions), mdCell(finished)],
      source,
    });
  }

  return {
    ledgerPath,
    records: records.length,
    pending: pending.length,
    figures: rows,
    models: modelRows,
  };
}
export function renderNumbers(numbers: BenchmarkNumbers, withSources = false): string {
  const lines: string[] = [];
  lines.push("# Benchmark numbers");
  lines.push("");
  lines.push(
    `Ledger: ${numbers.ledgerPath} (records: ${String(numbers.records)}, unfinalized entries: ${String(numbers.pending)})`,
  );
  lines.push("");
  if (withSources) {
    lines.push("| figure | value | sources |");
    lines.push("| --- | --- | --- |");
    for (const row of numbers.figures) {
      const value = row.cells[0] ?? "";
      lines.push(`| ${mdCell(row.label)} | ${value} | ${mdCell(row.source)} |`);
    }
  } else {
    lines.push("| figure | value |");
    lines.push("| --- | --- |");
    for (const row of numbers.figures) {
      const value = row.cells[0] ?? "";
      lines.push(`| ${mdCell(row.label)} | ${value} |`);
    }
  }
  lines.push("");
  lines.push("## Sessions per model (finished tasks)");
  lines.push("");
  if (withSources) {
    lines.push("| model | sessions | finished | sources |");
    lines.push("| --- | --- | --- | --- |");
    if (numbers.models.length === 0) {
      lines.push("| no data (no sessions) |  |  |  |");
    } else {
      for (const row of numbers.models) {
        const model = mdCell(row.label);
        const sessions = row.cells[0] ?? "";
        const finished = row.cells[1] ?? "";
        lines.push(`| ${model} | ${sessions} | ${finished} | ${mdCell(row.source)} |`);
      }
    }
  } else {
    lines.push("| model | sessions | finished |");
    lines.push("| --- | --- | --- |");
    if (numbers.models.length === 0) {
      lines.push("| no data (no sessions) |  |  |");
    } else {
      for (const row of numbers.models) {
        const model = mdCell(row.label);
        const sessions = row.cells[0] ?? "";
        const finished = row.cells[1] ?? "";
        lines.push(`| ${model} | ${sessions} | ${finished} |`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

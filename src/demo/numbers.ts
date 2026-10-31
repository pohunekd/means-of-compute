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

function figureOf(
  model: ReturnType<typeof buildDashboard>,
  panelId: string,
  label: string,
): import("../dashboard/model.js").Cell {
  const panel = model.panels.find((p) => p.id === panelId);
  if (!panel) {
    throw new Error(`demo:numbers: dashboard panel "${panelId}" missing`);
  }
  const figure = panel.figures.find((f) => f.label === label);
  if (!figure) {
    throw new Error(`demo:numbers: dashboard figure "${label}" missing in panel ${panelId}`);
  }
  return figure.cell;
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

  const unmeasuredIds = unmeasuredRequestsFor(ledger.records);
  const nullIdsAll = nullTokenIdsFor(ledger.records, false);
  const nullIdsPriced = nullTokenIdsFor(ledger.records, true, pricing);

  const rows: NumbersRow[] = [];

  const finishedTasksCell = figureOf(model, "autonomy", "Finished tasks");
  rows.push({ label: "Tasks completed", cells: [mdCell(cellText(finishedTasksCell))] });

  let localShareCell = localShare(ledger.records, classes);
  if (unmeasuredIds.size > 0) {
    localShareCell = `no data (requests without usage for ${idList(unmeasuredIds)})`;
  } else if (nullIdsAll.size > 0) {
    localShareCell = `no data (token counts not reported for ${idList(nullIdsAll)})`;
  }
  rows.push({ label: "Local token share", cells: [mdCell(localShareCell)] });

  const actualCostCell = figureOf(model, "savings", "Actual token cost");
  let actualCostText = cellText(actualCostCell);
  if (actualCostCell.kind === "text" && nullIdsPriced.size > 0) {
    actualCostText = `no data (token counts not reported for ${idList(nullIdsPriced)})`;
  } else if (actualCostCell.kind !== "no-data" && unmeasuredIds.size > 0) {
    const unmeasuredPriced = new Set<string>();
    for (const r of ledger.records) {
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
  rows.push({ label: "Actual token cost", cells: [mdCell(actualCostText)] });

  const frontierCell = figureOf(model, "savings", "Frontier-token baseline");
  let frontierText = cellText(frontierCell);
  if (frontierCell.kind === "text" && nullIdsAll.size > 0) {
    frontierText = `no data (token counts not reported for ${idList(nullIdsAll)})`;
  } else if (frontierCell.kind !== "no-data" && unmeasuredIds.size > 0) {
    frontierText = `no data (requests without usage for ${idList(unmeasuredIds)})`;
  }
  rows.push({ label: "Frontier-token baseline", cells: [mdCell(frontierText)] });

  const cloudCell = figureOf(model, "savings", "Cloud sandbox baseline");
  rows.push({ label: "Cloud sandbox baseline", cells: [mdCell(cellText(cloudCell))] });

  const ownedCell = figureOf(model, "savings", "Owned compute cost");
  rows.push({ label: "Owned compute cost", cells: [mdCell(cellText(ownedCell))] });

  const interventionsCell = figureOf(model, "autonomy", "Human interventions");
  rows.push({ label: "Human interventions", cells: [mdCell(cellText(interventionsCell))] });

  const retriesCell = figureOf(model, "autonomy", "Retries");
  rows.push({ label: "Retries", cells: [mdCell(cellText(retriesCell))] });

  const pendingCount = ledger.pending.length;
  const unfinalizedText = pendingCount === 0 ? "0" : `${String(pendingCount)} (in no figure above)`;
  rows.push({ label: "Unfinalized entries", cells: [mdCell(unfinalizedText)] });

  const autonomyPanel = model.panels.find((p) => p.id === "autonomy");
  if (!autonomyPanel) {
    throw new Error("demo:numbers: autonomy panel missing");
  }
  const successTable = autonomyPanel.tables.find((t) => t.caption === "Success rate per model");
  if (!successTable) {
    throw new Error("demo:numbers: Success rate per model table missing");
  }
  const modelRows: NumbersRow[] = [];
  for (const rowCells of successTable.rows) {
    const cells = rowCells.map(cellText);
    const modelId = cells[0] ?? "";
    const attempts = cells[1] ?? "";
    const successes = cells[2] ?? "";
    const rate = cells[3] ?? "";
    modelRows.push({ label: modelId, cells: [mdCell(attempts), mdCell(successes), mdCell(rate)] });
  }

  return {
    ledgerPath,
    records: ledger.records.length,
    pending: ledger.pending.length,
    figures: rows,
    models: modelRows,
  };
}

export function renderNumbers(numbers: BenchmarkNumbers): string {
  const lines: string[] = [];
  lines.push("# Benchmark numbers");
  lines.push("");
  lines.push(
    `Ledger: ${numbers.ledgerPath} (records: ${String(numbers.records)}, unfinalized entries: ${String(numbers.pending)})`,
  );
  lines.push("");
  lines.push("| figure | value |");
  lines.push("| --- | --- |");
  for (const row of numbers.figures) {
    const value = row.cells[0] ?? "";
    lines.push(`| ${mdCell(row.label)} | ${value} |`);
  }
  lines.push("");
  lines.push("## Success rate per model");
  lines.push("");
  lines.push("| model | attempts | successes | rate |");
  lines.push("| --- | --- | --- | --- |");
  if (numbers.models.length === 0) {
    lines.push("| no data (no attempts) |  |  |  |");
  } else {
    for (const row of numbers.models) {
      const model = mdCell(row.label);
      const attempts = row.cells[0] ?? "";
      const successes = row.cells[1] ?? "";
      const rate = row.cells[2] ?? "";
      lines.push(`| ${model} | ${attempts} | ${successes} | ${rate} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

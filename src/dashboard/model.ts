// Dashboard page model: a pure value the renderer turns into HTML.
// buildDashboard turns gathered Sourced inputs into panels; every figure
// cites its ledger field and price entry, and a missing input shows
// "no data" while an unreadable input shows an error code only.
import type { UsageRecord } from "../../contracts/v1/types.js";
import { recount } from "../auditor/verdict.js";
import { isPriced, summarizeSpend, utcCalendarDay } from "../budget/cost.js";
import { decideAdmission } from "../budget/decision.js";
import type { NanoPricing } from "../budget/pricing.js";
import { queryLedger } from "../ledger/query.js";
import { spendEntriesOf } from "../ledger/read.js";
import type { PendingUsage, SpendEntry } from "../ledger/types.js";
import {
  capScaled,
  formatUsd,
  groupDigits,
  guardScaled,
  hourCostScaled,
  priceText,
  tokenCostScaled,
} from "./money.js";
import type { Baselines } from "./config.js";
import type { DashboardInputs, InputErrorCode, InputFailure } from "./inputs.js";
import type { HostObservation } from "../hoststate/collector.js";
import type { UnavailableCause } from "../hoststate/collector.js";

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

const CAUSE_LABELS: Record<UnavailableCause, string> = {
  "host-unreachable": "unreachable",
  "request-timeout": "request timed out",
  "daemon-unsupported": "daemon too old",
  "daemon-rejected": "daemon rejected the request",
  "plugin-missing": "plugin not installed",
  "plugin-disabled": "plugin disabled",
  "plugin-busy": "plugin busy",
  "plugin-failed": "plugin failed",
  "plugin-timeout": "plugin timed out",
  "output-too-large": "output too large",
  "output-invalid": "output not UTF-8",
  "package-mismatch": "other plugin package",
  "version-not-accepted": "plugin version not accepted",
  "not-json": "output not JSON",
  "contract-invalid": "output fails the HostCapacity contract",
  "alias-mismatch": "reported alias differs",
  stale: "report too old",
  "future-timestamp": "report from the future",
};

function textCell(text: string): Cell {
  return { kind: "text", text };
}

function noDataCell(reason: string): Cell {
  return { kind: "no-data", reason };
}

function errorCell(code: InputErrorCode): Cell {
  return { kind: "error", code };
}

function failureCell(failure: InputFailure): Cell {
  return failure.kind === "error" ? errorCell(failure.code) : noDataCell(failure.reason);
}

// Every alias arrives validated (F1): the schema and the collector enforce
// ^[a-z][a-z0-9-]{0,31}$. The renderer re-checks (2.6); anything that fails
// never reaches a cell text because aliases are stored, not interpolated.
function aliasesCell(values: readonly string[]): Cell {
  const aliases = [...new Set(values)].sort();
  return { kind: "aliases", aliases };
}

function textFigure(label: string, value: string, source: string): Figure {
  return { label, cell: textCell(value), source };
}

function failedFigure(label: string, failure: InputFailure, source: string): Figure {
  return { label, cell: failureCell(failure), source };
}

function priceCite(ids: readonly string[], pricing: ReadonlyMap<string, NanoPricing>): string {
  const parts = [...new Set(ids)].sort().map((id) => {
    const entry = pricing.get(id);
    if (entry === undefined) {
      return `config/providers/${id}.json (no price found)`;
    }
    return (
      `config/providers/${id}.json input $${priceText(entry.inputNanoPer1M)} per 1M, ` +
      `output $${priceText(entry.outputNanoPer1M)} per 1M`
    );
  });
  return parts.join("; ");
}

function cachedClause(ids: readonly string[], pricing: ReadonlyMap<string, NanoPricing>): string {
  const cached = [...new Set(ids)]
    .sort()
    .filter((id) => pricing.get(id)?.cachedInputNanoPer1M !== undefined);
  return cached.length === 0
    ? ""
    : `; upper bound: cached-input pricing of ${cached.join(", ")} not applied`;
}

function moneyUnknown(entry: SpendEntry, pricing: ReadonlyMap<string, NanoPricing>): boolean {
  return entry.tokens.some((token) => {
    const entry_pricing = pricing.get(token.provider);
    return (
      entry_pricing !== undefined &&
      isPriced(entry_pricing) &&
      (token.inputTokens === null || token.outputTokens === null)
    );
  });
}

function buildFleetPanel(inputs: DashboardInputs): Panel {
  const aliases = new Set<string>();
  if (inputs.hosts.ok) {
    for (const observation of inputs.hosts.value) {
      aliases.add(observation.hostAlias);
    }
  }
  if (inputs.ledger.ok) {
    for (const record of inputs.ledger.value.records) {
      for (const session of record.sessionSeconds) {
        aliases.add(session.hostAlias);
      }
    }
    for (const entry of inputs.ledger.value.pending) {
      if (entry.kind === "session" && entry.session !== null) {
        aliases.add(entry.session.hostAlias);
      }
    }
  }
  const ordered = [...aliases].sort();
  const byAlias = new Map<string, HostObservation>();
  if (inputs.hosts.ok) {
    for (const observation of inputs.hosts.value) {
      byAlias.set(observation.hostAlias, observation);
    }
  }
  const running = noDataCell("dispatcher registry not wired");
  const rows = ordered.map((alias): readonly Cell[] => {
    const observation = byAlias.get(alias);
    if (!inputs.hosts.ok) {
      const failure = failureCell(inputs.hosts.failure);
      return [aliasesCell([alias]), failure, failure, running, failure];
    }
    if (observation === undefined) {
      const missing = noDataCell("not in this collector round");
      return [aliasesCell([alias]), missing, missing, running, missing];
    }
    if (observation.kind === "unavailable") {
      const state = textCell(`unavailable: ${CAUSE_LABELS[observation.cause]}`);
      return [aliasesCell([alias]), state, state, running, textCell(observation.observedAt)];
    }
    const state = observation.capacity.idle
      ? textCell("idle")
      : textCell(`not idle: ${observation.capacity.idleReason}`);
    const { cpu, memory, gpu } = observation.capacity;
    const free = Math.round(Math.max(0, 1 - cpu.load1m / cpu.cores) * 100);
    const gpuText = !gpu.present
      ? "no GPU"
      : gpu.freeMb === null
        ? "GPU free memory unknown"
        : `GPU ${groupDigits(gpu.freeMb)} MB free`;
    const capacity = textCell(
      `CPU ${String(free)}% free, memory ${groupDigits(memory.freeMb)} of ${groupDigits(memory.totalMb)} MB free, ${gpuText}`,
    );
    return [aliasesCell([alias]), state, capacity, running, textCell(observation.observedAt)];
  });
  return {
    id: "fleet",
    title: "Fleet",
    figures: [],
    tables: [
      {
        caption: "Fleet",
        columns: ["host", "state", "free capacity", "running", "observed"],
        rows,
        source:
          "collector round of this request (HostCapacity); running sessions from the dispatcher registry",
        note: null,
      },
    ],
  };
}

function recordFor(inputs: DashboardInputs, id: string): UsageRecord | null {
  if (!inputs.ledger.ok) {
    return null;
  }
  let latest: UsageRecord | null = null;
  for (const record of inputs.ledger.value.records) {
    if (record.workItemId !== id) {
      continue;
    }
    if (latest === null || record.finishedAt > latest.finishedAt) {
      latest = record;
    }
  }
  return latest;
}

function pendingFor(inputs: DashboardInputs, id: string): readonly PendingUsage[] {
  if (!inputs.ledger.ok) {
    return [];
  }
  return inputs.ledger.value.pending.filter((entry) => entry.workItemId === id);
}

function activityOf(inputs: DashboardInputs, id: string): string | null {
  if (!inputs.ledger.ok) {
    return null;
  }
  let latest: string | null = null;
  for (const record of inputs.ledger.value.records) {
    if (record.workItemId !== id) {
      continue;
    }
    if (latest === null || record.finishedAt > latest) {
      latest = record.finishedAt;
    }
  }
  for (const entry of inputs.ledger.value.pending) {
    if (entry.workItemId !== id) {
      continue;
    }
    if (latest === null || entry.finishedAt > latest) {
      latest = entry.finishedAt;
    }
  }
  return latest;
}

function verdictCell(inputs: DashboardInputs, id: string): Cell {
  const sourced = inputs.verdicts.get(id);
  if (sourced === undefined) {
    return noDataCell("no verdict store");
  }
  if (!sourced.ok) {
    return failureCell(sourced.failure);
  }
  if (sourced.value.length === 0) {
    return textCell("none");
  }
  const parts = sourced.value.map((verdict) => {
    const counts = recount(verdict.findings);
    if (
      counts.high !== verdict.counts.high ||
      counts.medium !== verdict.counts.medium ||
      counts.low !== verdict.counts.low
    ) {
      return `${verdict.headSha.slice(0, 12)}: invalid (counts disagree)`;
    }
    return (
      `${verdict.headSha.slice(0, 12)} by ${verdict.auditorModel}: ` +
      `high ${String(counts.high)}, medium ${String(counts.medium)}, low ${String(counts.low)}`
    );
  });
  return textCell(parts.join("; "));
}

function buildWorkPanel(inputs: DashboardInputs, shown: readonly string[], total: number): Panel {
  const rows = shown.map((id): readonly Cell[] => {
    const record = recordFor(inputs, id);
    const pending = pendingFor(inputs, id);
    let status: Cell;
    if (inputs.workItems !== null) {
      const item = inputs.workItems.find((candidate) => candidate.id === id);
      if (item !== undefined) {
        status =
          item.statusReason === null
            ? textCell(item.status)
            : textCell(`${item.status} (${item.statusReason})`);
      } else if (record !== null) {
        status = textCell(record.result === "success" ? "done" : "blocked");
      } else if (pending.length > 0) {
        status = textCell("session ended, not finalized");
      } else {
        status = inputs.ledger.ok
          ? noDataCell("no ledger entry")
          : failureCell(inputs.ledger.failure);
      }
    } else if (record !== null) {
      status = textCell(record.result === "success" ? "done" : "blocked");
    } else if (pending.length > 0) {
      status = textCell("session ended, not finalized");
    } else {
      status = inputs.ledger.ok
        ? noDataCell("no ledger entry")
        : failureCell(inputs.ledger.failure);
    }
    const sessionHosts = new Set<string>();
    if (record !== null) {
      for (const session of record.sessionSeconds) {
        sessionHosts.add(session.hostAlias);
      }
    }
    for (const entry of pending) {
      if (entry.kind === "session" && entry.session !== null) {
        sessionHosts.add(entry.session.hostAlias);
      }
    }
    const host: Cell =
      sessionHosts.size > 0
        ? aliasesCell([...sessionHosts])
        : inputs.ledger.ok
          ? noDataCell("no session")
          : failureCell(inputs.ledger.failure);
    let branch: Cell;
    if (inputs.workItems !== null) {
      const item = inputs.workItems.find((candidate) => candidate.id === id);
      if (item !== undefined && item.branch !== null) {
        branch = textCell(item.branch);
      } else {
        branch = noDataCell("dispatcher registry not wired");
      }
    } else {
      branch = noDataCell("dispatcher registry not wired");
    }
    const model = noDataCell("dispatcher registry not wired");
    const verdicts = verdictCell(inputs, id);
    const activity = activityOf(inputs, id);
    const lastActivity =
      activity === null
        ? inputs.ledger.ok
          ? noDataCell("no timestamp")
          : failureCell(inputs.ledger.failure)
        : textCell(activity);
    return [textCell(id), status, host, branch, model, verdicts, lastActivity];
  });
  return {
    id: "work",
    title: "Work",
    figures: [],
    tables: [
      {
        caption: "Work",
        columns: ["item", "status", "host", "branch", "model", "verdicts", "last activity"],
        rows,
        source:
          "work items, dispatcher registry, ledger and verdict store; status rule in docs/dashboard.md",
        note: `showing ${String(shown.length)} of ${String(total)} items`,
      },
    ],
  };
}

function spendEntriesInScope(
  inputs: DashboardInputs,
  day: string,
): { readonly today: readonly SpendEntry[]; readonly all: readonly SpendEntry[] } | null {
  if (!inputs.ledger.ok) {
    return null;
  }
  const all = spendEntriesOf(inputs.ledger.value);
  return { today: all.filter((entry) => utcCalendarDay(new Date(entry.finishedAt)) === day), all };
}

function buildUsagePanel(inputs: DashboardInputs, day: string): Panel {
  const figures: Figure[] = [];
  const scope = spendEntriesInScope(inputs, day);
  const pricingForUnknown = inputs.pricing.ok ? inputs.pricing.value : null;
  const unknownToday =
    scope !== null && pricingForUnknown !== null
      ? scope.today.filter((entry) => moneyUnknown(entry, pricingForUnknown))
      : [];
  const unknownAll =
    scope !== null && pricingForUnknown !== null
      ? scope.all.filter((entry) => moneyUnknown(entry, pricingForUnknown))
      : [];
  const requestsUnknownToday =
    scope !== null
      ? scope.today.filter((entry) =>
          entry.tokens.some(
            (token) => token.provider === inputs.budget.nvidiaProviderId && token.requests === null,
          ),
        )
      : [];
  // The caps need no ledger or prices (5.3): they stand on every failure,
  // in the same figure positions as the success path.
  const dayCapFigure = textFigure(
    "Day cap",
    formatUsd(capScaled(inputs.budget.dayCapNanoUsd)),
    "config/budget.json dayCapUsd",
  );
  const totalCapFigure = textFigure(
    "Total cap",
    formatUsd(capScaled(inputs.budget.totalCapNanoUsd)),
    "config/budget.json totalCapUsd",
  );
  if (!inputs.ledger.ok) {
    figures.push(
      failedFigure(`Spent today (UTC ${day})`, inputs.ledger.failure, "ledger records"),
      dayCapFigure,
      failedFigure("Spent total", inputs.ledger.failure, "ledger records"),
      totalCapFigure,
      failedFigure(
        `NVIDIA Build requests today (UTC ${day})`,
        inputs.ledger.failure,
        "ledger records",
      ),
      failedFigure(
        "New sessions",
        inputs.ledger.failure,
        "budget guard decision over the ledger, prices and caps above (docs/budget-guard.md)",
      ),
    );
  } else if (!inputs.pricing.ok) {
    figures.push(
      failedFigure(
        `Spent today (UTC ${day})`,
        inputs.pricing.failure,
        "ledger records and pending entries",
      ),
      dayCapFigure,
      failedFigure("Spent total", inputs.pricing.failure, "ledger records and pending entries"),
      totalCapFigure,
      failedFigure(
        `NVIDIA Build requests today (UTC ${day})`,
        inputs.pricing.failure,
        "ledger records and pending entries",
      ),
      failedFigure(
        "New sessions",
        inputs.pricing.failure,
        "budget guard decision over the ledger, prices and caps above (docs/budget-guard.md)",
      ),
    );
  } else if (scope !== null) {
    const pricing = inputs.pricing.value;
    const summary = summarizeSpend(scope.all, pricing, inputs.budget.nvidiaProviderId, inputs.now);
    const todayIds = [
      ...new Set(scope.today.flatMap((entry) => entry.tokens.map((token) => token.provider))),
    ];
    const allIds = [
      ...new Set(scope.all.flatMap((entry) => entry.tokens.map((token) => token.provider))),
    ];
    const todayScope =
      todayIds.length === 0 ? [...inputs.route, inputs.budget.nvidiaProviderId] : todayIds;
    const allScope =
      allIds.length === 0 ? [...inputs.route, inputs.budget.nvidiaProviderId] : allIds;
    const todayPrefix = todayIds.length === 0 ? "no entries; " : "";
    const allPrefix = allIds.length === 0 ? "no entries; " : "";
    const spentTodaySource =
      `ledger records and pending entries finished on ${day}, tokens × price; ` +
      `${todayPrefix}${priceCite(todayScope, pricing)}${cachedClause(todayScope, pricing)}`;
    const spentTotalSource =
      `ledger records and pending entries, tokens × price; ` +
      `${allPrefix}${priceCite(allScope, pricing)}${cachedClause(allScope, pricing)}`;
    if (unknownToday.length > 0) {
      const ids = [...new Set(unknownToday.map((entry) => entry.workItemId))].sort();
      figures.push({
        label: `Spent today (UTC ${day})`,
        cell: noDataCell(`spend unknown for ${ids.join(", ")}`),
        source: spentTodaySource,
      });
    } else {
      figures.push({
        label: `Spent today (UTC ${day})`,
        cell: textCell(formatUsd(guardScaled(summary.spentTodayNanoTimes1M))),
        source: spentTodaySource,
      });
    }
    figures.push(
      textFigure(
        "Day cap",
        formatUsd(capScaled(inputs.budget.dayCapNanoUsd)),
        "config/budget.json dayCapUsd",
      ),
    );
    if (unknownAll.length > 0) {
      const ids = [...new Set(unknownAll.map((entry) => entry.workItemId))].sort();
      figures.push({
        label: "Spent total",
        cell: noDataCell(`spend unknown for ${ids.join(", ")}`),
        source: spentTotalSource,
      });
    } else {
      figures.push({
        label: "Spent total",
        cell: textCell(formatUsd(guardScaled(summary.spentTotalNanoTimes1M))),
        source: spentTotalSource,
      });
    }
    figures.push(
      textFigure(
        "Total cap",
        formatUsd(capScaled(inputs.budget.totalCapNanoUsd)),
        "config/budget.json totalCapUsd",
      ),
    );
    if (requestsUnknownToday.length > 0) {
      const ids = [
        ...new Set(
          requestsUnknownToday.flatMap((entry) => entry.tokens.map((token) => token.provider)),
        ),
      ].sort();
      figures.push({
        label: `NVIDIA Build requests today (UTC ${day})`,
        cell: noDataCell(`requests not reported for ${ids.join(", ")}`),
        source:
          `ledger requests of provider ${inputs.budget.nvidiaProviderId} finished on ${day}; ` +
          "limit config/budget.json nvidiaDailyRequestLimit",
      });
    } else {
      figures.push({
        label: `NVIDIA Build requests today (UTC ${day})`,
        cell: textCell(
          `${groupDigits(summary.nvidiaRequestsToday)} of ${groupDigits(inputs.budget.nvidiaDailyRequestLimit)}`,
        ),
        source:
          `ledger requests of provider ${inputs.budget.nvidiaProviderId} finished on ${day}; ` +
          "limit config/budget.json nvidiaDailyRequestLimit",
      });
    }
    const admission = decideAdmission(summary, inputs.budget, { route: [...inputs.route] });
    figures.push(
      textFigure(
        "New sessions",
        admission.admit ? `admitted (${admission.reason})` : `refused (${admission.reason})`,
        "budget guard decision over the ledger, prices and caps above (docs/budget-guard.md)",
      ),
    );
  }
  const tables: Table[] = [];
  if (inputs.ledger.ok && scope !== null) {
    const providerRows = queryLedger(inputs.ledger.value, new Set(["provider"])).byProvider ?? [];
    const tokenRows = providerRows.map((row): readonly Cell[] => {
      const input =
        row.inputTokens === null
          ? noDataCell("not reported")
          : textCell(groupDigits(row.inputTokens));
      const output =
        row.outputTokens === null
          ? noDataCell("not reported")
          : textCell(groupDigits(row.outputTokens));
      return [
        textCell(row.provider),
        textCell(row.model),
        input,
        output,
        textCell(groupDigits(row.requests)),
        textCell(row.sources.join(", ")),
      ];
    });
    tables.push({
      caption: "Tokens by provider (finished tasks)",
      columns: ["provider", "model", "input tokens", "output tokens", "requests", "sources"],
      rows: tokenRows,
      source: "ledger records tokens[]",
      note: `${String(inputs.ledger.value.pending.length)} pending entries are not in this table; they count in spend above.`,
    });
    const hostRows = queryLedger(inputs.ledger.value, new Set(["host"])).byHost ?? [];
    const sessionRows = hostRows.map((row): readonly Cell[] => [
      aliasesCell([row.hostAlias]),
      textCell(row.hours),
      textCell(row.sources.join(", ")),
    ]);
    const totalSeconds = inputs.ledger.value.records.reduce(
      (sum, record) =>
        sum + record.sessionSeconds.reduce((inner, session) => inner + session.seconds, 0),
      0,
    );
    sessionRows.push([textCell("total"), textCell((totalSeconds / 3600).toFixed(2)), textCell("")]);
    tables.push({
      caption: "Session hours by host (finished tasks)",
      columns: ["host", "hours", "sources"],
      rows: sessionRows,
      source: "ledger records sessionSeconds[]",
      note: null,
    });
  } else if (!inputs.ledger.ok) {
    tables.push(
      {
        caption: "Tokens by provider (finished tasks)",
        columns: ["provider", "model", "input tokens", "output tokens", "requests", "sources"],
        rows: [],
        source: "ledger records tokens[]",
        note: null,
      },
      {
        caption: "Session hours by host (finished tasks)",
        columns: ["host", "hours", "sources"],
        rows: [],
        source: "ledger records sessionSeconds[]",
        note: null,
      },
    );
  }
  return { id: "usage", title: "Usage", figures, tables };
}

function frontierPart(baselines: Baselines): string {
  const baseline = baselines.frontierTokens;
  if (baseline === null) {
    return "config/dashboard.json baselines.frontierTokens (not set)";
  }
  return (
    `config/dashboard.json baselines.frontierTokens input $${priceText(baseline.inputNanoPer1M)} per 1M, ` +
    `output $${priceText(baseline.outputNanoPer1M)} per 1M`
  );
}

function hourPart(baselines: Baselines, key: "cloudSandboxHour" | "ownedHostHour"): string {
  const baseline = baselines[key];
  if (baseline === null) {
    return `config/dashboard.json baselines.${key} (not set)`;
  }
  return `config/dashboard.json baselines.${key} $${priceText(baseline.nanoPerHour)} per hour`;
}

function buildSavingsPanel(inputs: DashboardInputs): Panel {
  const figures: Figure[] = [];
  if (!inputs.ledger.ok) {
    return {
      id: "savings",
      title: "Savings",
      figures: [
        failedFigure("Frontier-token baseline", inputs.ledger.failure, "ledger records tokens"),
        failedFigure("Actual token cost", inputs.ledger.failure, "ledger records tokens"),
        failedFigure(
          "Token savings",
          inputs.ledger.failure,
          "frontier-token baseline minus actual token cost",
        ),
        failedFigure(
          "Cloud sandbox baseline",
          inputs.ledger.failure,
          "ledger records sessionSeconds",
        ),
        failedFigure("Owned compute cost", inputs.ledger.failure, "ledger records sessionSeconds"),
        failedFigure(
          "Compute-hour savings",
          inputs.ledger.failure,
          "cloud sandbox baseline minus owned compute cost",
        ),
        failedFigure(
          "Total savings",
          inputs.ledger.failure,
          "token savings plus compute-hour savings",
        ),
        {
          label: "Scope",
          cell: failureCell(inputs.ledger.failure),
          source: "ledger records",
        },
      ],
      tables: [],
    };
  }
  const records = inputs.ledger.value.records;
  const pendingEntries = inputs.ledger.value.pending.length;
  const frontier = inputs.baselines.frontierTokens;
  let baselineValue: bigint | null = null;
  if (frontier === null) {
    figures.push({
      label: "Frontier-token baseline",
      cell: noDataCell("no frontierTokens baseline in config/dashboard.json"),
      source: "config/dashboard.json baselines.frontierTokens",
    });
  } else {
    const nullIds = [
      ...new Set(
        records
          .filter((record) =>
            record.tokens.some(
              (token) => token.inputTokens === null || token.outputTokens === null,
            ),
          )
          .map((record) => record.workItemId),
      ),
    ].sort();
    if (nullIds.length > 0) {
      figures.push({
        label: "Frontier-token baseline",
        cell: noDataCell(`token counts not reported for ${nullIds.join(", ")}`),
        source:
          `ledger records tokens (input ${groupDigits(records.reduce((sum, record) => sum + record.tokens.reduce((inner, token) => inner + (token.inputTokens ?? 0), 0), 0))}, ` +
          `output ${groupDigits(records.reduce((sum, record) => sum + record.tokens.reduce((inner, token) => inner + (token.outputTokens ?? 0), 0), 0))}); ` +
          `config/dashboard.json baselines.frontierTokens input $${priceText(frontier.inputNanoPer1M)} per 1M, ` +
          `output $${priceText(frontier.outputNanoPer1M)} per 1M (${frontier.label}; ${frontier.source}; as of ${frontier.asOf})`,
      });
    } else {
      baselineValue = records.reduce(
        (sum, record) =>
          sum +
          record.tokens.reduce(
            (inner, token) =>
              inner +
              tokenCostScaled(token.inputTokens ?? 0, frontier.inputNanoPer1M) +
              tokenCostScaled(token.outputTokens ?? 0, frontier.outputNanoPer1M),
            0n,
          ),
        0n,
      );
      const totalIn = records.reduce(
        (sum, record) =>
          sum + record.tokens.reduce((inner, token) => inner + (token.inputTokens ?? 0), 0),
        0,
      );
      const totalOut = records.reduce(
        (sum, record) =>
          sum + record.tokens.reduce((inner, token) => inner + (token.outputTokens ?? 0), 0),
        0,
      );
      figures.push({
        label: "Frontier-token baseline",
        cell: textCell(formatUsd(baselineValue)),
        source:
          `ledger records tokens (input ${groupDigits(totalIn)}, output ${groupDigits(totalOut)}); ` +
          `config/dashboard.json baselines.frontierTokens input $${priceText(frontier.inputNanoPer1M)} per 1M, ` +
          `output $${priceText(frontier.outputNanoPer1M)} per 1M (${frontier.label}; ${frontier.source}; as of ${frontier.asOf})`,
      });
    }
  }
  const recordIds = [
    ...new Set(records.flatMap((record) => record.tokens.map((token) => token.provider))),
  ].sort();
  const pricingForRecordCite = inputs.pricing.ok
    ? inputs.pricing.value
    : new Map<string, NanoPricing>();
  let actualValue: bigint | null = null;
  if (!inputs.pricing.ok) {
    figures.push(
      failedFigure("Actual token cost", inputs.pricing.failure, "ledger records tokens"),
    );
  } else {
    const pricing = inputs.pricing.value;
    const nullOnPriced = [
      ...new Set(
        records
          .filter((record) =>
            record.tokens.some((token) => {
              const entry = pricing.get(token.provider);
              return (
                entry !== undefined &&
                isPriced(entry) &&
                (token.inputTokens === null || token.outputTokens === null)
              );
            }),
          )
          .map((record) => record.workItemId),
      ),
    ].sort();
    if (nullOnPriced.length > 0) {
      figures.push({
        label: "Actual token cost",
        cell: noDataCell(`token counts not reported for ${nullOnPriced.join(", ")}`),
        source:
          `ledger records tokens × price; ` +
          `${recordIds.length === 0 ? "no entries; " : ""}${priceCite(recordIds, pricing)}${cachedClause(recordIds, pricing)}`,
      });
    } else {
      actualValue = records.reduce(
        (sum, record) =>
          sum +
          record.tokens.reduce((inner, token) => {
            const entry = pricing.get(token.provider);
            if (entry === undefined || !isPriced(entry)) {
              return inner;
            }
            return (
              inner +
              tokenCostScaled(token.inputTokens ?? 0, entry.inputNanoPer1M) +
              tokenCostScaled(token.outputTokens ?? 0, entry.outputNanoPer1M)
            );
          }, 0n),
        0n,
      );
      figures.push({
        label: "Actual token cost",
        cell: textCell(formatUsd(actualValue)),
        source:
          `ledger records tokens × price; ` +
          `${recordIds.length === 0 ? "no entries; " : ""}${priceCite(recordIds, pricing)}${cachedClause(recordIds, pricing)}`,
      });
    }
  }
  if (baselineValue === null || actualValue === null) {
    figures.push({
      label: "Token savings",
      cell: noDataCell("needs every figure it is computed from"),
      source: `frontier-token baseline minus actual token cost above; ${frontierPart(inputs.baselines)}; ${priceCite(recordIds, pricingForRecordCite)}`,
    });
  } else {
    figures.push({
      label: "Token savings",
      cell: textCell(formatUsd(baselineValue - actualValue)),
      source: `frontier-token baseline minus actual token cost above; ${frontierPart(inputs.baselines)}; ${priceCite(recordIds, pricingForRecordCite)}`,
    });
  }
  const totalSeconds = records.reduce(
    (sum, record) =>
      sum + record.sessionSeconds.reduce((inner, session) => inner + session.seconds, 0),
    0,
  );
  const cloud = inputs.baselines.cloudSandboxHour;
  const owned = inputs.baselines.ownedHostHour;
  let cloudValue: bigint | null = null;
  let ownedValue: bigint | null = null;
  if (cloud === null) {
    figures.push({
      label: "Cloud sandbox baseline",
      cell: noDataCell("no cloudSandboxHour baseline in config/dashboard.json"),
      source: "config/dashboard.json baselines.cloudSandboxHour",
    });
  } else {
    cloudValue = hourCostScaled(totalSeconds, cloud.nanoPerHour);
    figures.push({
      label: "Cloud sandbox baseline",
      cell: textCell(formatUsd(cloudValue)),
      source:
        `ledger records sessionSeconds (${groupDigits(totalSeconds)} s); ` +
        `config/dashboard.json baselines.cloudSandboxHour $${priceText(cloud.nanoPerHour)} per hour ` +
        `(${cloud.label}; ${cloud.source}; as of ${cloud.asOf})`,
    });
  }
  if (owned === null) {
    figures.push({
      label: "Owned compute cost",
      cell: noDataCell("no ownedHostHour baseline in config/dashboard.json"),
      source: "config/dashboard.json baselines.ownedHostHour",
    });
  } else {
    ownedValue = hourCostScaled(totalSeconds, owned.nanoPerHour);
    figures.push({
      label: "Owned compute cost",
      cell: textCell(formatUsd(ownedValue)),
      source:
        `ledger records sessionSeconds (${groupDigits(totalSeconds)} s); ` +
        `config/dashboard.json baselines.ownedHostHour $${priceText(owned.nanoPerHour)} per hour ` +
        `(${owned.label}; ${owned.source}; as of ${owned.asOf})`,
    });
  }
  if (cloudValue === null || ownedValue === null) {
    figures.push({
      label: "Compute-hour savings",
      cell: noDataCell("needs every figure it is computed from"),
      source:
        `cloud sandbox baseline minus owned compute cost above; ${hourPart(inputs.baselines, "cloudSandboxHour")}; ` +
        hourPart(inputs.baselines, "ownedHostHour"),
    });
  } else {
    figures.push({
      label: "Compute-hour savings",
      cell: textCell(formatUsd(cloudValue - ownedValue)),
      source:
        `cloud sandbox baseline minus owned compute cost above; ${hourPart(inputs.baselines, "cloudSandboxHour")}; ` +
        hourPart(inputs.baselines, "ownedHostHour"),
    });
  }
  const tokenSavings =
    baselineValue !== null && actualValue !== null ? baselineValue - actualValue : null;
  const computeSavings =
    cloudValue !== null && ownedValue !== null ? cloudValue - ownedValue : null;
  if (tokenSavings === null || computeSavings === null) {
    figures.push({
      label: "Total savings",
      cell: noDataCell("needs every figure it is computed from"),
      source:
        `token savings plus compute-hour savings above; ${frontierPart(inputs.baselines)}; ` +
        `${priceCite(recordIds, pricingForRecordCite)}; ${hourPart(inputs.baselines, "cloudSandboxHour")}; ` +
        hourPart(inputs.baselines, "ownedHostHour"),
    });
  } else {
    figures.push({
      label: "Total savings",
      cell: textCell(formatUsd(tokenSavings + computeSavings)),
      source:
        `token savings plus compute-hour savings above; ${frontierPart(inputs.baselines)}; ` +
        `${priceCite(recordIds, pricingForRecordCite)}; ${hourPart(inputs.baselines, "cloudSandboxHour")}; ` +
        hourPart(inputs.baselines, "ownedHostHour"),
    });
  }
  figures.push({
    label: "Scope",
    cell: textCell(`${String(records.length)} finished tasks`),
    source: `ledger records; ${String(pendingEntries)} pending entries are not included`,
  });
  return { id: "savings", title: "Savings", figures, tables: [] };
}

function buildAutonomyPanel(inputs: DashboardInputs): Panel {
  if (!inputs.ledger.ok) {
    return {
      id: "autonomy",
      title: "Autonomy",
      figures: [
        failedFigure("Human interventions", inputs.ledger.failure, "ledger records"),
        failedFigure("Retries", inputs.ledger.failure, "ledger records"),
        failedFigure("Parked tasks", inputs.ledger.failure, "ledger records"),
        failedFigure("Finished tasks", inputs.ledger.failure, "ledger records"),
      ],
      tables: [],
    };
  }
  const records = inputs.ledger.value.records;
  const interventions = records.reduce((sum, record) => sum + record.humanInterventions, 0);
  const retries = records.reduce((sum, record) => sum + record.retries, 0);
  const success = records.filter((record) => record.result === "success").length;
  const blocked = records.filter((record) => record.result === "blocked").length;
  const parked: Figure =
    inputs.workItems === null
      ? {
          label: "Parked tasks",
          cell: noDataCell("no work item source (#15, #17)"),
          source: "work items with status parked",
        }
      : textFigure(
          "Parked tasks",
          groupDigits(inputs.workItems.filter((item) => item.status === "parked").length),
          "work items with status parked",
        );
  const modelRows = queryLedger(inputs.ledger.value, new Set(["model"])).byModel ?? [];
  return {
    id: "autonomy",
    title: "Autonomy",
    figures: [
      textFigure(
        "Human interventions",
        groupDigits(interventions),
        `ledger records humanInterventions (${String(records.length)} records)`,
      ),
      textFigure("Retries", groupDigits(retries), "ledger records retries"),
      parked,
      textFigure(
        "Finished tasks",
        `${String(success)} succeeded, ${String(blocked)} blocked`,
        "ledger records result",
      ),
    ],
    tables: [
      {
        caption: "Success rate per model",
        columns: ["model", "attempts", "successes", "rate"],
        rows: modelRows.map((row): readonly Cell[] => [
          textCell(row.model),
          textCell(groupDigits(row.attempts)),
          textCell(groupDigits(row.successes)),
          row.successRate === null ? noDataCell("no attempts") : textCell(row.successRate),
        ]),
        source: "ledger records attempts[] (attempt-level, docs/ledger.md)",
        note: null,
      },
    ],
  };
}

export function buildDashboard(inputs: DashboardInputs): DashboardModel {
  const day = utcCalendarDay(inputs.now);
  const { shown, total } = workRows(inputs);
  return {
    renderedAt: inputs.now.toISOString(),
    utcDay: day,
    logPath: inputs.logPath,
    panels: [
      buildFleetPanel(inputs),
      buildWorkPanel(inputs, shown, total),
      buildUsagePanel(inputs, day),
      buildSavingsPanel(inputs),
      buildAutonomyPanel(inputs),
    ],
  };
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

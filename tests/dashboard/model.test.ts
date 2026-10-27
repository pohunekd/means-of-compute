// Dashboard model tests. Fresh cases come from the design fixture 10.1:
// every number is recomputed below from the fixture text, never from the
// code under test. Each test names the mutation it must catch.
import { describe, expect, test } from "bun:test";
import { loadBudgetConfig } from "../../src/budget/config.js";
import { loadPricingForIds } from "../../src/budget/pricing.js";
import { readLedger } from "../../src/ledger/read.js";
import { loadProviderRoute } from "../../src/providers/route.js";
import { providerDescriptorExists } from "../../src/providers/config.js";
import { isWorkItem } from "../../contracts/v1/validate.js";
import type { WorkItem } from "../../contracts/v1/types.js";
import { gatherInputs, type DashboardInputs } from "../../src/dashboard/inputs.js";
import { buildDashboard, type Figure } from "../../src/dashboard/model.js";
import {
  createCollector,
  type HostStateCollector,
} from "../../src/hoststate/collector.js";
import { loadHostStateConfig } from "../../src/hoststate/config.js";
import { createMemoryHostStatePort } from "../../src/hoststate/memory-port.js";

const FIXTURE = "tests/fixtures/dashboard/ledger.jsonl";
const UNKNOWN = "tests/fixtures/dashboard/ledger-unknown.jsonl";
const INVALID = "tests/fixtures/dashboard/ledger-invalid.jsonl";
const VERDICTS = "tests/fixtures/dashboard/verdicts";

async function loadInputs(
  ledgerPath: string,
  verdictDir: string = VERDICTS,
  baselines: DashboardInputs["baselines"] = {
    frontierTokens: null,
    cloudSandboxHour: null,
    ownedHostHour: null,
  },
  now = new Date("2026-10-27T12:00:00.000Z"),
  hostState: HostStateCollector | null = null,
  workRowLimit = 50,
): Promise<DashboardInputs> {
  const budget = await loadBudgetConfig();
  const route = await loadProviderRoute("config/providers/route.json", providerDescriptorExists);
  const inputs = await gatherInputs(
    { ledgerPath, verdictDir, hostState, registryPath: "" },
    { budget, route, baselines, workRowLimit, logPath: "logs/dashboard.jsonl" },
    now,
    () => {},
  );
  return inputs;
}

const PRICED_BASELINES: DashboardInputs["baselines"] = {
  frontierTokens: {
    label: "synthetic frontier",
    inputNanoPer1M: 3_000_000_000n,
    outputNanoPer1M: 15_000_000_000n,
    source: "synthetic test value, not a price",
    asOf: "2026-10-01",
  },
  cloudSandboxHour: {
    label: "synthetic sandbox",
    nanoPerHour: 500_000_000n,
    source: "synthetic test value, not a price",
    asOf: "2026-10-01",
  },
  ownedHostHour: {
    label: "synthetic owned",
    nanoPerHour: 50_000_000n,
    source: "synthetic test value, not a price",
    asOf: "2026-10-01",
  },
};

function textOf(panel: { figures: readonly Figure[] }, label: string): string {
  return cellTextOf(figureOf(panel, label));
}

async function loadWorkItemFixture(name: string): Promise<WorkItem> {
  const raw = (await Bun.file(`contracts/v1/fixtures/${name}`).json()) as unknown;
  if (!isWorkItem(raw)) {
    throw new Error(`${name} is not a WorkItem`);
  }
  return raw;
}

function figureOf(panel: { figures: readonly Figure[] }, label: string): Figure {
  const figure = panel.figures.find((entry) => entry.label === label);
  if (figure === undefined) {
    throw new Error(`missing figure ${label}`);
  }
  return figure;
}

function cellTextOf(figure: Figure): string {
  const cell = figure.cell;
  if (cell.kind !== "text") {
    throw new Error(`figure ${figure.label} is not text`);
  }
  return cell.text;
}

describe("dashboard panels exist (mutation: missing one of the five sections)", () => {
  test("all five panels render in PanelId order", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE));
    expect(model.panels.map((panel) => panel.id)).toEqual([
      "fleet",
      "work",
      "usage",
      "savings",
      "autonomy",
    ]);
  });
});

describe("dashboard verdicts (mutation: latest-verdict only, or finding texts rendered)", () => {
  test("d1-alpha lists both verdicts in store order", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE));
    const work = model.panels[1] as (typeof model.panels)[number];
    const table = work.tables[0] as (typeof work.tables)[number];
    const row = table.rows.find((cells) => {
      const first = cells[0] as { kind: string; text?: string };
      return first.kind === "text" && first.text === "d1-alpha";
    });
    if (row === undefined) {
      throw new Error("missing d1-alpha row");
    }
    const verdicts = row[5] as { kind: string; text?: string };
    expect(verdicts.kind).toBe("text");
    expect(verdicts.text ?? "").toBe(
      "111111111111 by muse-spark-1.3-contributor: high 0, medium 1, low 0; " +
        "222222222222 by muse-spark-1.3-contributor: high 0, medium 0, low 0",
    );
  });

  test("invalid verdict store gives an error cell, not a number", async () => {
    const broken = `${import.meta.dir}/.tmp-verdicts-broken`;
    await Bun.write(
      `${broken}/d1-alpha/4444444444444444444444444444444444444444.json`,
      "not json\n",
    );
    const model = buildDashboard(await loadInputs(FIXTURE, broken));
    const work = model.panels[1] as (typeof model.panels)[number];
    const table = work.tables[0] as (typeof work.tables)[number];
    const row = table.rows.find((cells) => {
      const first = cells[0] as { kind: string; text?: string };
      return first.kind === "text" && first.text === "d1-alpha";
    });
    if (row === undefined) {
      throw new Error("missing d1-alpha row");
    }
    const verdicts = row[5] as { kind: string };
    expect(verdicts.kind).toBe("error");
    const { rm } = await import("node:fs/promises");
    await rm(broken, { recursive: true, force: true });
  });
});

describe("dashboard usage figures 10.2 (mutation: records-only spend; per-record rounding; pending mixed in)", () => {
  test("Spent today and total use exact sums over records and pending", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE));
    const usage = model.panels[2] as (typeof model.panels)[number];
    // d1-alpha meta-api 1M in + 0.5M out at 0.1/0.2 per 1M = $0.20;
    // d4-delta pending nvidia tokens are unpriced, meta-api 0.1M in + 0.05M out = $0.02.
    expect(textOf(usage, "Spent today (UTC 2026-10-27)")).toBe("$0.2200");
    // d2-beta meta-api 0.2M in + 0.1M out = $0.04 on top.
    expect(textOf(usage, "Spent total")).toBe("$0.2600");
    expect(textOf(usage, "Day cap")).toBe("$12.0000");
    expect(textOf(usage, "Total cap")).toBe("$140.0000");
    // 10.1: nvidia requests 20 + 8 today, plus 3 pending = 31.
    expect(textOf(usage, "NVIDIA Build requests today (UTC 2026-10-27)")).toBe("31 of 1,000");
    expect(textOf(usage, "New sessions")).toBe("admitted (within budget)");
    const providerTable = usage.tables[0] as (typeof usage.tables)[number];
    const rows = providerTable.rows.map((cells) =>
      cells.map((cell) =>
        cell.kind === "text"
          ? cell.text
          : cell.kind === "no-data"
            ? `no data (${cell.reason})`
            : cell.kind,
      ),
    );
    expect(rows).toEqual([
      [
        "meta-api",
        "muse-spark-1.3-contributor",
        "1,200,000",
        "600,000",
        "12",
        "auditor-usage, meter-proxy",
      ],
      [
        "nvidia-build",
        "meta/muse-glimmer-30b",
        "5,500,000",
        "1,100,000",
        "58",
        "meter-proxy",
      ],
    ]);
    expect(providerTable.note ?? "").toContain("1 pending entries");
    const hoursTable = usage.tables[1] as (typeof usage.tables)[number];
    const hourRows = hoursTable.rows.map((cells) =>
      cells.map((cell) =>
        cell.kind === "text" ? cell.text : cell.kind === "aliases" ? "aliases" : cell.kind,
      ),
    );
    // The host column is a checked aliases cell; the sources join dispatcher-clock.
    expect(hourRows).toEqual([
      ["aliases", "2.00", "dispatcher-clock"],
      ["aliases", "1.50", "dispatcher-clock"],
      ["aliases", "0.50", "dispatcher-clock"],
      ["total", "4.00", ""],
    ]);
  });
});

describe("dashboard savings 10.2 (mutation: records-only arithmetic; per-record rounding)", () => {
  test("all savings figures use the exact 10.2 values", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE, VERDICTS, { ...PRICED_BASELINES }));
    const savings = model.panels[3] as (typeof model.panels)[number];
    expect(textOf(savings, "Frontier-token baseline")).toBe("$45.6000");
    expect(textOf(savings, "Actual token cost")).toBe("$0.2400");
    expect(textOf(savings, "Token savings")).toBe("$45.3600");
    expect(textOf(savings, "Cloud sandbox baseline")).toBe("$2.0000");
    expect(textOf(savings, "Owned compute cost")).toBe("$0.2000");
    expect(textOf(savings, "Compute-hour savings")).toBe("$1.8000");
    expect(textOf(savings, "Total savings")).toBe("$47.1600");
    expect(textOf(savings, "Scope")).toBe("3 finished tasks");
    expect(savings.figures.at(-1)?.source).toContain("1 pending entries are not included");
    const usage = model.panels[2] as (typeof model.panels)[number];
    const founders = usage.figures.map((figure) => figure.label);
    expect(founders).toEqual([
      "Spent today (UTC 2026-10-27)",
      "Day cap",
      "Spent total",
      "Total cap",
      "NVIDIA Build requests today (UTC 2026-10-27)",
      "New sessions",
    ]);
  });
});

describe("dashboard autonomy and work order 10.2 (mutation: sort by id; invented numbers)", () => {
  test("Autonomy counts and model rates match 10.2", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE, VERDICTS, { ...PRICED_BASELINES }));
    const autonomy = model.panels[4] as (typeof model.panels)[number];
    expect(textOf(autonomy, "Human interventions")).toBe("2");
    expect(textOf(autonomy, "Retries")).toBe("3");
    expect(textOf(autonomy, "Finished tasks")).toBe("2 succeeded, 1 blocked");
    expect(figureOf(autonomy, "Parked tasks").cell).toEqual({
      kind: "no-data",
      reason: "no work item source (#15, #17)",
    });
    const table = autonomy.tables[0] as (typeof autonomy.tables)[number];
    expect(table.caption).toBe("Success rate per model");
    const rows = table.rows.map((cells) =>
      cells.map((cell) => (cell.kind === "text" ? cell.text : cell.kind)),
    );
    expect(rows).toEqual([
      ["meta/muse-glimmer-30b", "4", "1", "0.2500"],
      ["muse-spark-1.3-contributor", "1", "1", "1.0000"],
    ]);
  });

  test("Work rows are in 10.2 activity order with verdict texts", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE));
    const work = model.panels[1] as (typeof model.panels)[number];
    const table = work.tables[0] as (typeof work.tables)[number];
    const ids = table.rows.map((cells) => (cells[0] as { text?: string }).text);
    expect(ids).toEqual(["d4-delta", "d3-gamma", "d1-alpha", "d2-beta"]);
    expect(table.note).toBe("showing 4 of 4 items");
    const text = (index: number, column: number): string => {
      const cell = table.rows[index]?.[column];
      if (cell === undefined || cell.kind !== "text") {
        throw new Error(`work row ${String(index)} column ${String(column)} is not text`);
      }
      return cell.text;
    };
    expect(text(0, 1)).toBe("session ended, not finalized");
    expect(text(1, 1)).toBe("blocked");
    expect(text(2, 1)).toBe("done");
    expect(text(3, 1)).toBe("done");
    expect(text(0, 5)).toBe("none");
    expect(text(1, 5)).toBe("333333333333: invalid (counts disagree)");
    expect(text(2, 5)).toContain("111111111111 by muse-spark-1.3-contributor");
    expect(text(2, 5)).toContain("222222222222 by muse-spark-1.3-contributor");
    expect(text(3, 5)).toBe("none");
  });

  test("workRowLimit 2 reads verdicts only for the shown ids", async () => {
    const seen = new Set<string>();
    const logged: DashboardInputs["verdicts"] = new Map();
    const inputs = await loadInputs(FIXTURE, VERDICTS, {
      frontierTokens: null,
      cloudSandboxHour: null,
      ownedHostHour: null,
    }, new Date("2026-10-27T12:00:00.000Z"), null, 2);
    expect(inputs.verdicts.has("d4-delta")).toBe(true);
    expect(inputs.verdicts.has("d3-gamma")).toBe(true);
    expect(inputs.verdicts.has("d1-alpha")).toBe(false);
    expect(seen.size).toBe(0);
    expect(logged.size).toBe(0);
    const model = buildDashboard(inputs);
    const work = model.panels[1] as (typeof model.panels)[number];
    expect(work.tables[0]?.note).toBe("showing 2 of 4 items");
  });
});

describe("dashboard work items (mutation: ignore status rule 1)", () => {
  test("Parked tasks counts parked items and status rule 1 wins", async () => {
    const parked = await loadWorkItemFixture("work-item-parked.json");
    const running = await loadWorkItemFixture("work-item.json");
    const inputs = await loadInputs(FIXTURE);
    const withItems: DashboardInputs = { ...inputs, workItems: [parked, running] };
    const model = buildDashboard(withItems);
    const autonomy = model.panels[4] as (typeof model.panels)[number];
    expect(textOf(autonomy, "Parked tasks")).toBe("1");
    const all = new Set([
      ...inputs.ledger.ok ? inputs.ledger.value.records.map((record) => record.workItemId) : [],
      ...inputs.ledger.ok ? inputs.ledger.value.pending.map((entry) => entry.workItemId) : [],
      "w1-contracts",
      "w2-parked-example",
    ]);
    expect(all.has("w2-parked-example")).toBe(true);
    expect(all.has("w1-contracts")).toBe(true);
    const work = model.panels[1] as (typeof model.panels)[number];
    const table = work.tables[0] as (typeof work.tables)[number];
    const rows = new Map(
      table.rows.map((cells) => [(cells[0] as { text?: string }).text ?? "", cells]),
    );
    const parkedRow = rows.get("w2-parked-example");
    if (parkedRow === undefined) {
      throw new Error("missing w2-parked-example row");
    }
    expect((parkedRow[1] as { text?: string }).text).toBe(
      "parked (no newly met DoD item for 3 rounds)",
    );
    expect((parkedRow[3] as { text?: string }).text).toBe("17-loop-stall");
    const runningRow = rows.get("w1-contracts");
    if (runningRow === undefined) {
      throw new Error("missing w1-contracts row");
    }
    expect((runningRow[1] as { text?: string }).text).toBe("running");
  });
});

describe("dashboard input failures (mutation: collapse error into no-data; drop the caps)", () => {
  test("ledger-invalid poisons every ledger cell and the caps still stand", async () => {
    const model = buildDashboard(await loadInputs(INVALID));
    const usage = model.panels[2] as (typeof model.panels)[number];
    // Order matches the success path: spent, cap, spent, cap, requests, admission.
    expect(usage.figures.map((figure) => figure.label)).toEqual([
      "Spent today (UTC 2026-10-27)",
      "Day cap",
      "Spent total",
      "Total cap",
      "NVIDIA Build requests today (UTC 2026-10-27)",
      "New sessions",
    ]);
    expect(figureOf(usage, "Spent today (UTC 2026-10-27)").cell).toEqual({
      kind: "error",
      code: "ledger-invalid",
    });
    expect(figureOf(usage, "Spent total").cell).toEqual({
      kind: "error",
      code: "ledger-invalid",
    });
    expect(textOf(usage, "Day cap")).toBe("$12.0000");
    expect(textOf(usage, "Total cap")).toBe("$140.0000");
    const savings = model.panels[3] as (typeof model.panels)[number];
    for (const figure of savings.figures) {
      if (figure.label !== "Scope") {
        expect(figure.cell).toEqual({ kind: "error", code: "ledger-invalid" });
      }
    }
    const autonomy = model.panels[4] as (typeof model.panels)[number];
    for (const figure of autonomy.figures) {
      expect(figure.cell).toEqual({ kind: "error", code: "ledger-invalid" });
    }
  });

  test("pricing-unavailable poisons money cells and keeps baselines", async () => {
    const inputs = await loadInputs(FIXTURE, VERDICTS, { ...PRICED_BASELINES });
    if (!inputs.pricing.ok) {
      throw new Error("expected pricing to load");
    }
    // A missing descriptor for a ledger provider fails pricing under the
    // same code gatherInputs reports for an unreadable descriptor file.
    const priced = { ...inputs, pricing: { ok: false as const, failure: { kind: "error" as const, code: "pricing-unavailable" as const } } };
    const withoutBaseline: DashboardInputs = { ...priced, baselines: { frontierTokens: null, cloudSandboxHour: null, ownedHostHour: null } };
    const model = buildDashboard(withoutBaseline);
    const usage = model.panels[2] as (typeof model.panels)[number];
    expect(figureOf(usage, "Spent today (UTC 2026-10-27)").cell).toEqual({
      kind: "error",
      code: "pricing-unavailable",
    });
    const savings = model.panels[3] as (typeof model.panels)[number];
    expect(figureOf(savings, "Frontier-token baseline").cell).toEqual({
      kind: "no-data",
      reason: "no frontierTokens baseline in config/dashboard.json",
    });
    expect(figureOf(savings, "Actual token cost").cell).toEqual({
      kind: "error",
      code: "pricing-unavailable",
    });
  });

  test("missing verdict store is no-data without touching the caps", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE, `${import.meta.dir}/verdicts-missing`));
    const work = model.panels[1] as (typeof model.panels)[number];
    const d1 = work.tables[0]?.rows.find(
      (cells) => (cells[0] as { text?: string }).text === "d1-alpha",
    );
    if (d1 === undefined) {
      throw new Error("missing d1-alpha row");
    }
    expect(d1[5]).toEqual({ kind: "no-data", reason: "no verdict store" });
    const usage = model.panels[2] as (typeof model.panels)[number];
    expect(textOf(usage, "Day cap")).toBe("$12.0000");
  });
});

describe("dashboard baselines null (mutation: treat null as 0)", () => {
  test("null baselines give the 5.4 no-data figures and guard the derived ones", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE));
    const savings = model.panels[3] as (typeof model.panels)[number];
    for (const [label, reason] of [
      ["Frontier-token baseline", "no frontierTokens baseline in config/dashboard.json"],
      ["Cloud sandbox baseline", "no cloudSandboxHour baseline in config/dashboard.json"],
      ["Owned compute cost", "no ownedHostHour baseline in config/dashboard.json"],
    ] as const) {
      const figure = figureOf(savings, label);
      expect(figure.cell).toEqual({ kind: "no-data", reason });
      expect(figure.source).toContain("config/dashboard.json");
    }
    for (const label of ["Token savings", "Compute-hour savings", "Total savings"]) {
      expect(figureOf(savings, label).cell).toEqual({
        kind: "no-data",
        reason: "needs every figure it is computed from",
      });
    }
    // Actual token cost needs no baseline and still prices the records.
    expect(textOf(savings, "Actual token cost")).toBe("$0.2400");
  });
});

describe("dashboard fleet (mutation: raw cause in a cell; free capacity copied from idle)", () => {
  test("the real collector feeds the 10.2 rows", async () => {
    const config = loadHostStateConfig("config/host-state.json");
    const control = createMemoryHostStatePort(["desktop", "laptop-a", "laptop-mac"]);
    const now = new Date("2026-10-27T12:00:00.000Z");
    const desktop = JSON.parse(
      (await Bun.file("contracts/v1/fixtures/host-capacity.json").text()).replace(
        /"timestamp": "[^"]*"/,
        `"timestamp": "${now.toISOString()}"`,
      ),
    ) as unknown;
    const busy = JSON.parse(
      (await Bun.file("contracts/v1/fixtures/host-capacity-busy.json").text()).replace(
        /"timestamp": "[^"]*"/,
        `"timestamp": "${now.toISOString()}"`,
      ),
    ) as unknown;
    const identity = {
      packageId: "moc.host-state",
      version: "0.1.0",
      digest: config.package.sourceDigest,
    };
    control.set("desktop", { kind: "reply", reply: { identity, stdout: JSON.stringify(desktop) } });
    control.set("laptop-a", { kind: "reply", reply: { identity, stdout: JSON.stringify(busy) } });
    control.set("laptop-mac", { kind: "fail", failure: "host-unreachable", code: null });
    const collector = createCollector({
      port: control.port,
      config,
      now: () => new Date(now.getTime()),
      sleep: () => new Promise<void>(() => {}),
      log: () => {},
    });
    const inputs = await loadInputs(FIXTURE, VERDICTS, {
      frontierTokens: null,
      cloudSandboxHour: null,
      ownedHostHour: null,
    }, now, collector);
    const model = buildDashboard(inputs);
    const fleet = model.panels[0] as (typeof model.panels)[number];
    const table = fleet.tables[0] as (typeof fleet.tables)[number];
    const rows = new Map(
      table.rows.map((cells) => [
        (cells[0] as { aliases?: readonly string[] }).aliases?.join(",") ?? "",
        cells,
      ]),
    );
    const asText = (row: readonly (typeof fleet.tables)[number]["rows"][number][number]): string => {
      if (row.kind === "text") {
        return row.text;
      }
      if (row.kind === "no-data" || row.kind === "error") {
        return `${row.kind}:${row.kind === "no-data" ? row.reason : row.code}`;
      }
      return row.kind;
    };
    const desktopRow = rows.get("desktop");
    if (desktopRow === undefined) {
      throw new Error("missing desktop row");
    }
    expect(asText(desktopRow[1] as never)).toBe("idle");
    expect(asText(desktopRow[2] as never)).toBe(
      "CPU 91% free, memory 21,000 of 32,768 MB free, no GPU",
    );
    const busyRow = rows.get("laptop-a");
    if (busyRow === undefined) {
      throw new Error("missing laptop-a row");
    }
    expect(asText(busyRow[1] as never)).toBe("not idle: user input 40 seconds ago");
    expect(asText(busyRow[2] as never)).toBe(
      "CPU 90% free, memory 48,000 of 65,536 MB free, GPU 8,192 MB free",
    );
    const ledgerOnly = rows.get("laptop-b");
    if (ledgerOnly === undefined) {
      throw new Error("missing laptop-b row");
    }
    expect(asText(ledgerOnly[1] as never)).toBe("no-data:not in this collector round");
    const unreachable = rows.get("laptop-mac");
    if (unreachable === undefined) {
      throw new Error("missing laptop-mac row");
    }
    expect(asText(unreachable[1] as never)).toBe("unavailable: unreachable");
    // Every state goes through CAUSE_LABELS, never as the raw cause enum.
    expect(JSON.stringify(model)).not.toContain("host-unreachable");
  });

  test("a failing collector gives error (fleet-round-failed)", async () => {
    const failing: HostStateCollector = {
      collect: () => Promise.reject(new Error("boom")),
    };
    const model = buildDashboard(await loadInputs(FIXTURE, VERDICTS, {
      frontierTokens: null,
      cloudSandboxHour: null,
      ownedHostHour: null,
    }, new Date("2026-10-27T12:00:00.000Z"), failing));
    const fleet = model.panels[0] as (typeof model.panels)[number];
    const table = fleet.tables[0] as (typeof fleet.tables)[number];
    for (const row of table.rows) {
      expect(row[1]).toEqual({ kind: "error", code: "fleet-round-failed" });
    }
  });
});

describe("dashboard unknown spend 10.2 (mutation: ?? 0 on null tokens; summary regardless)", () => {
  test("ledger-unknown hides spend and refuses new sessions", async () => {
    const priced = { ...PRICED_BASELINES };
    const model = buildDashboard(await loadInputs(UNKNOWN, VERDICTS, priced));
    const usage = model.panels[2] as (typeof model.panels)[number];
    expect(figureOf(usage, "Spent today (UTC 2026-10-27)").cell).toEqual({
      kind: "no-data",
      reason: "spend unknown for d1-alpha",
    });
    expect(figureOf(usage, "Spent total").cell).toEqual({
      kind: "no-data",
      reason: "spend unknown for d1-alpha",
    });
    expect(textOf(usage, "New sessions")).toBe("refused (spend unknown)");
    const savings = model.panels[3] as (typeof model.panels)[number];
    expect(figureOf(savings, "Frontier-token baseline").cell).toEqual({
      kind: "no-data",
      reason: "token counts not reported for d1-alpha",
    });
    expect(figureOf(savings, "Actual token cost").cell).toEqual({
      kind: "no-data",
      reason: "token counts not reported for d1-alpha",
    });
  });
});

describe("dashboard failures (mutation: message text in the page, or missing log path)", () => {
  test("ledger-invalid page carries the code only, never the message", async () => {
    const model = buildDashboard(await loadInputs(INVALID));
    const usage = model.panels[2] as (typeof model.panels)[number];
    const total = figureOf(usage, "Spent total");
    expect(total.cell).toEqual({ kind: "error", code: "ledger-invalid" });
    expect(JSON.stringify(model)).not.toContain("not valid JSON");
  });
});

describe("dashboard artifacts used by the model", () => {
  test("fixture ledger and pricing load outside the dashboard", async () => {
    const contents = await readLedger("Dashboard ledger", FIXTURE);
    expect(contents.records.length).toBe(3);
    const pricing = await loadPricingForIds("config/providers", ["meta-api"]);
    expect(pricing.get("meta-api")?.inputNanoPer1M).toBe(100_000_000n);
  });
});

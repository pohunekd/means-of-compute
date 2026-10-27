// Dashboard model tests. Fresh cases come from the design fixture 10.1:
// every number is recomputed below from the fixture text, never from the
// code under test. Each test names the mutation it must catch.
import { describe, expect, test } from "bun:test";
import { loadBudgetConfig } from "../../src/budget/config.js";
import { loadPricingForIds } from "../../src/budget/pricing.js";
import { readLedger } from "../../src/ledger/read.js";
import { loadProviderRoute } from "../../src/providers/route.js";
import { providerDescriptorExists } from "../../src/providers/config.js";
import { gatherInputs, type DashboardInputs } from "../../src/dashboard/inputs.js";
import { buildDashboard, type Figure } from "../../src/dashboard/model.js";
import { formatUsd, tokenCostScaled } from "../../src/dashboard/money.js";

const FIXTURE = "tests/fixtures/dashboard/ledger.jsonl";
const UNKNOWN = "tests/fixtures/dashboard/ledger-unknown.jsonl";
const INVALID = "tests/fixtures/dashboard/ledger-invalid.jsonl";
const VERDICTS = "tests/fixtures/dashboard/verdicts";

const FIXED_BASELINES = {
  frontierTokens: {
    label: "synthetic frontier",
    inputNanoPer1M: 3_000_000_000n,
    outputNanoPer1M: 15_000_000_000n,
    source: "synthetic price, never billed",
    asOf: "2026-10-26",
  },
  cloudSandboxHour: {
    label: "synthetic cloud",
    nanoPerHour: 160_000_000n,
    source: "synthetic price, never billed",
    asOf: "2026-10-26",
  },
  ownedHostHour: {
    label: "synthetic owned",
    nanoPerHour: 30_000_000n,
    source: "synthetic price, never billed",
    asOf: "2026-10-26",
  },
} as const;

async function loadInputs(
  ledgerPath: string,
  verdictDir: string = VERDICTS,
  baselines: DashboardInputs["baselines"] = {
    frontierTokens: null,
    cloudSandboxHour: null,
    ownedHostHour: null,
  },
  now = new Date("2026-10-27T12:00:00.000Z"),
): Promise<DashboardInputs> {
  const budget = await loadBudgetConfig();
  const route = await loadProviderRoute("config/providers/route.json", providerDescriptorExists);
  const inputs = await gatherInputs(
    { ledgerPath, verdictDir, hostState: null, registryPath: "" },
    { budget, route, baselines, workRowLimit: 50, logPath: "logs/dashboard.jsonl" },
    now,
    () => {},
  );
  return inputs;
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

describe("dashboard spend (mutation: show summary partial sums when a priced provider count is null)", () => {
  test("Spent today/total hide the partial sum when d1-alpha input is unknown", async () => {
    const model = buildDashboard(await loadInputs(UNKNOWN));
    const usage = model.panels[2] as (typeof model.panels)[number];
    const today = figureOf(usage, "Spent today (UTC 2026-10-27)");
    expect(today.cell).toEqual({ kind: "no-data", reason: "spend unknown for d1-alpha" });
    const total = figureOf(usage, "Spent total");
    expect(total.cell).toEqual({ kind: "no-data", reason: "spend unknown for d1-alpha" });
  });
});

describe("dashboard usage figures (mutation: 3600 missing from spend, or caps shown from the ledger)", () => {
  test("Spent today/total and caps cite config prices", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE));
    const usage = model.panels[2] as (typeof model.panels)[number];
    const today = figureOf(usage, "Spent today (UTC 2026-10-27)");
    // d1-alpha meta-api 1M in + 0.5M out at 0.1/0.2 per 1M = $0.20; d3-gamma
    // and d4-delta nvidia rows are unpriced (0/0), d2-beta is yesterday.
    expect(cellTextOf(today)).toBe("$0.2200");
    const total = figureOf(usage, "Spent total");
    // plus d2-beta meta-api 0.2M in + 0.1M out = $0.04.
    expect(cellTextOf(total)).toBe("$0.2600");
    expect(figureOf(usage, "Day cap").source).toContain("config/budget.json dayCapUsd");
    expect(figureOf(usage, "Total cap").source).toContain("config/budget.json totalCapUsd");
    expect(today.source).toContain("per 1M");
  });
});

describe("dashboard fleet (mutation: hostname or address reaches the page)", () => {
  test("ledger-only aliases render, registry column is not wired", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE));
    const fleet = model.panels[0] as (typeof model.panels)[number];
    const table = fleet.tables[0] as (typeof fleet.tables)[number];
    const hosts = table.rows.map((row) => {
      const cell = row[0] as { kind: string; aliases?: readonly string[] };
      if (cell.kind !== "aliases" || cell.aliases === undefined) {
        throw new Error("host cell is not aliases");
      }
      return cell.aliases.join(",");
    });
    expect(hosts).toEqual(["desktop", "laptop-a", "laptop-b"]);
  });
});

describe("dashboard savings (mutation: case-insensitive host- leak, or baseline without a source)", () => {
  test("frontier baseline total matches the recomputed token sums", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE, VERDICTS, { ...FIXED_BASELINES }));
    const savings = model.panels[3] as (typeof model.panels)[number];
    const baseline = figureOf(savings, "Frontier-token baseline");
    const expected =
      tokenCostScaled(1_000_000, 3_000_000_000n) +
      tokenCostScaled(500_000, 15_000_000_000n) +
      tokenCostScaled(2_000_000, 3_000_000_000n) +
      tokenCostScaled(400_000, 15_000_000_000n) +
      tokenCostScaled(3_000_000, 3_000_000_000n) +
      tokenCostScaled(600_000, 15_000_000_000n) +
      tokenCostScaled(200_000, 3_000_000_000n) +
      tokenCostScaled(100_000, 15_000_000_000n) +
      tokenCostScaled(500_000, 3_000_000_000n) +
      tokenCostScaled(100_000, 15_000_000_000n);
    expect(cellTextOf(baseline)).toBe(formatUsd(expected));
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

describe("dashboard failures (mutation: message text in the page, or missing log path)", () => {
  test("ledger-invalid page carries the code only, never the message", async () => {
    const model = buildDashboard(await loadInputs(INVALID));
    const usage = model.panels[2] as (typeof model.panels)[number];
    const total = figureOf(usage, "Spent total");
    expect(total.cell).toEqual({ kind: "error", code: "ledger-invalid" });
    expect(JSON.stringify(model)).not.toContain("not valid JSON");
  });
});

describe("dashboard baseline wiring", () => {
  test("null baselines give no data with the config source (mutation: invented numbers)", async () => {
    const model = buildDashboard(await loadInputs(FIXTURE));
    const savings = model.panels[3] as (typeof model.panels)[number];
    const baseline = figureOf(savings, "Frontier-token baseline");
    expect(baseline.cell).toEqual({
      kind: "no-data",
      reason: "no frontierTokens baseline in config/dashboard.json",
    });
    expect(baseline.source).toContain("config/dashboard.json baselines.frontierTokens");
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

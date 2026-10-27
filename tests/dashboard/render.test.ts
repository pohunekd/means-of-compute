// Dashboard render tests. Expected values come from design sections 4.3,
// 4.4 and 4.5, never from the code under test. Each test names the mutation
// it must catch.
import { describe, expect, test } from "bun:test";
import { renderDashboard } from "../../src/dashboard/render.js";
import { buildDashboard } from "../../src/dashboard/model.js";
import { loadBudgetConfig } from "../../src/budget/config.js";
import { loadProviderRoute } from "../../src/providers/route.js";
import { providerDescriptorExists } from "../../src/providers/config.js";
import { gatherInputs } from "../../src/dashboard/inputs.js";

async function renderFixture(): Promise<string> {
  const budget = await loadBudgetConfig();
  const route = await loadProviderRoute("config/providers/route.json", providerDescriptorExists);
  const inputs = await gatherInputs(
    {
      ledgerPath: "tests/fixtures/dashboard/ledger.jsonl",
      verdictDir: "tests/fixtures/dashboard/verdicts",
      hostState: null,
      registryPath: "",
    },
    {
      budget,
      route,
      baselines: { frontierTokens: null, cloudSandboxHour: null, ownedHostHour: null },
      workRowLimit: 50,
      logPath: "logs/dashboard.jsonl",
    },
    new Date("2026-10-27T12:00:00.000Z"),
    () => {},
  );
  return renderDashboard(buildDashboard(inputs));
}

describe("dashboard markup shape (mutation: client JS, auto-refresh or external resource added)", () => {
  test("no script, form or external resource appears", async () => {
    const page = await renderFixture();
    const lower = page.toLowerCase();
    expect(lower).not.toContain("<script");
    expect(lower).not.toContain("<form");
    expect(lower).not.toContain("http://");
    expect(lower).not.toContain("https://");
    expect(lower).not.toContain("auto-refresh");
  });

  test("skeleton carries all five panel sections in PanelId order", async () => {
    const page = await renderFixture();
    const ids = [...page.matchAll(/<section id="([a-z]+)">/g)].map((match) => match[1]);
    expect(ids).toEqual(["fleet", "work", "usage", "savings", "autonomy"]);
  });

  test("every figure and table names its source", async () => {
    const page = await renderFixture();
    const figures = [...page.matchAll(/<div class="figure">/g)].length;
    const cites = [...page.matchAll(/<p class="cite">source: /g)].length;
    expect(figures).toBeGreaterThan(0);
    expect(cites).toBeGreaterThanOrEqual(figures);
  });

  test("no data and error cells use the exact 4.4 texts", async () => {
    const page = await renderFixture();
    expect(page).toContain("no data (dispatcher registry not wired)");
    expect(page).not.toContain("no-data");
  });
});

describe("dashboard fixed-text rule (mutation: a host- label, class, id or reason added)", () => {
  test("no fixed text contains host- case-insensitively", async () => {
    const page = (await renderFixture()).toLowerCase();
    expect(page).not.toContain("host-");
  });
});

describe("dashboard escaping (mutation: string interpolation without escapeHtml)", () => {
  test("verdict auditor and sha text cannot break markup", async () => {
    const page = await renderFixture();
    expect(page).toContain("muse-spark-1.3-contributor");
    expect(page).not.toContain("<muse");
  });
});

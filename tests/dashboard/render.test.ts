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
import type { UnavailableCause } from "../../src/hoststate/collector.js";

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

  test("a baseline label escapes and the page has no <script (mutation: skip escapeHtml)", async () => {
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
        baselines: {
          frontierTokens: {
            label: `<script>x</script>&"'`,
            inputNanoPer1M: 3_000_000_000n,
            outputNanoPer1M: 15_000_000_000n,
            source: "synthetic test value, not a price",
            asOf: "2026-10-01",
          },
          cloudSandboxHour: null,
          ownedHostHour: null,
        },
        workRowLimit: 50,
        logPath: "logs/dashboard.jsonl",
      },
      new Date("2026-10-27T12:00:00.000Z"),
      () => {},
    );
    const page = renderDashboard(buildDashboard(inputs));
    expect(page).toContain("&lt;script&gt;x&lt;/script&gt;&amp;&quot;&#39;");
    expect(page).not.toContain("<script");
  });

  test("a bad alias throws without the value (mutation: skip the alias guard)", async () => {
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
    const model = buildDashboard(inputs);
    const fleet = model.panels[0] as (typeof model.panels)[number];
    const bad = {
      ...model,
      panels: [
        {
          ...fleet,
          tables: [
            {
              ...fleet.tables[0],
              rows: [[{ kind: "aliases", aliases: ["Bad Alias"] }]],
            },
          ],
        },
        ...model.panels.slice(1),
      ],
    };
    let message = "";
    try {
      renderDashboard(bad as never);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("Bad Alias");
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("dashboard unavailable causes (mutation: wrong cause label in model.ts)", () => {
  test("every cause renders its design 5.1 label, never host- or the raw cause", async () => {
    const { HOST_STATE_FAILURES } = await import("../../src/hoststate/port.js");
    const { COLLECTOR_ONLY_CAUSES } = await import("../../src/hoststate/collector.js");
    // Expected values copied from design 5.1 CAUSE_LABELS, never from model.ts.
    const expected: readonly (readonly [UnavailableCause, string])[] = [
      ["host-unreachable", "unreachable"],
      ["request-timeout", "request timed out"],
      ["daemon-unsupported", "daemon too old"],
      ["daemon-rejected", "daemon rejected the request"],
      ["plugin-missing", "plugin not installed"],
      ["plugin-disabled", "plugin disabled"],
      ["plugin-busy", "plugin busy"],
      ["plugin-failed", "plugin failed"],
      ["plugin-timeout", "plugin timed out"],
      ["output-too-large", "output too large"],
      ["output-invalid", "output not UTF-8"],
      ["package-mismatch", "other plugin package"],
      ["version-not-accepted", "plugin version not accepted"],
      ["not-json", "output not JSON"],
      ["contract-invalid", "output fails the HostCapacity contract"],
      ["alias-mismatch", "reported alias differs"],
      ["stale", "report too old"],
      ["future-timestamp", "report from the future"],
    ];
    // The table key set must equal every cause the source exports, so a
    // newly added cause fails here until it gains its design label.
    expect(new Set([...HOST_STATE_FAILURES, ...COLLECTOR_ONLY_CAUSES]).size).toBe(18);
    expect(new Set(expected.map(([cause]) => cause))).toEqual(
      new Set([...HOST_STATE_FAILURES, ...COLLECTOR_ONLY_CAUSES]),
    );
    const causes: readonly UnavailableCause[] = expected.map(([cause]) => cause);
    expect(new Set(causes).size).toBe(18);
    const budget = await loadBudgetConfig();
    const route = await loadProviderRoute("config/providers/route.json", providerDescriptorExists);
    const inputs = await gatherInputs(
      {
        ledgerPath: "tests/fixtures/dashboard/ledger.jsonl",
        verdictDir: "tests/fixtures/dashboard/verdicts",
        hostState: {
          collect: () =>
            Promise.resolve(
              causes.map((cause, index) => ({
                kind: "unavailable" as const,
                hostAlias: `a${String(index).padStart(2, "0")}`,
                observedAt: "2026-10-27T12:00:00.000Z",
                cause,
                detail: cause,
              })),
            ),
        },
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
    const page = renderDashboard(buildDashboard(inputs));
    for (const [cause, label] of expected) {
      expect(page).toContain(`unavailable: ${label}`);
      if (cause !== label) {
        expect(page).not.toContain(cause);
      }
    }
    expect(page.toLowerCase()).not.toContain("host-");
  });
});

describe("dashboard CSP and fixed texts (mutation: inline style without the hash; raw cause in a cell)", () => {
  test("the style text hashes to CSS_HASH and no page holds a sentinel text", async () => {
    const { createHash } = await import("node:crypto");
    const { DASHBOARD_CSS, CSS_HASH } = await import("../../src/dashboard/render.js");
    const digest = `sha256-${createHash("sha256").update(DASHBOARD_CSS, "utf8").digest("base64")}`;
    expect(CSS_HASH).toBe(digest);
    const { startDashboard } = await import("../../src/dashboard/server.js");
    const budget = await loadBudgetConfig();
    const route = await loadProviderRoute("config/providers/route.json", providerDescriptorExists);
    const logged: { event: string }[] = [];
    const server = await startDashboard({
      config: {
        listenEnv: "MOC_DASHBOARD_LISTEN",
        listenAlias: "dashboard",
        logPath: "logs/dashboard.jsonl",
        maxRequestBytes: 1024,
        idleTimeoutSec: 10,
        workRowLimit: 50,
        baselines: { frontierTokens: null, cloudSandboxHour: null, ownedHostHour: null },
      },
      listen: { host: "127.0.0.1", port: 0 },
      fixed: {
        budget,
        route,
        baselines: { frontierTokens: null, cloudSandboxHour: null, ownedHostHour: null },
        workRowLimit: 50,
        logPath: "logs/dashboard.jsonl",
      },
      sources: {
        ledgerPath: "tests/fixtures/dashboard/ledger.jsonl",
        verdictDir: "tests/fixtures/dashboard/verdicts",
        hostState: null,
        registryPath: "",
      },
      now: () => new Date("2026-10-27T12:00:00.000Z"),
      log: (event) => {
        logged.push(event);
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}/`, {
        headers: { host: `127.0.0.1:${String(server.port)}` },
      });
      expect(response.headers.get("content-security-policy") ?? "").toBe(
        `default-src 'none'; style-src '${CSS_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      );
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(logged.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
    const page = await renderFixture();
    expect(page.toLowerCase()).not.toContain("host-");
    for (const needle of ["sentinel", "192.168.", "198.51.100.", ".internal"]) {
      expect(page).not.toContain(needle);
    }
  });

  test("the served style text hashes to the CSP header hash (mutation: style text changed, hash kept)", async () => {
    const { createHash } = await import("node:crypto");
    const { startDashboard } = await import("../../src/dashboard/server.js");
    const budget = await loadBudgetConfig();
    const route = await loadProviderRoute("config/providers/route.json", providerDescriptorExists);
    const logged: { event: string }[] = [];
    const server = await startDashboard({
      config: {
        listenEnv: "MOC_DASHBOARD_LISTEN",
        listenAlias: "dashboard",
        logPath: "logs/dashboard.jsonl",
        maxRequestBytes: 1024,
        idleTimeoutSec: 10,
        workRowLimit: 50,
        baselines: { frontierTokens: null, cloudSandboxHour: null, ownedHostHour: null },
      },
      listen: { host: "127.0.0.1", port: 0 },
      fixed: {
        budget,
        route,
        baselines: { frontierTokens: null, cloudSandboxHour: null, ownedHostHour: null },
        workRowLimit: 50,
        logPath: "logs/dashboard.jsonl",
      },
      sources: {
        ledgerPath: "tests/fixtures/dashboard/ledger.jsonl",
        verdictDir: "tests/fixtures/dashboard/verdicts",
        hostState: null,
        registryPath: "",
      },
      now: () => new Date("2026-10-27T12:00:00.000Z"),
      log: (event) => {
        logged.push(event);
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}/`, {
        headers: { host: `127.0.0.1:${String(server.port)}` },
      });
      const header = response.headers.get("content-security-policy") ?? "";
      const page = await response.text();
      expect(page.match(/<style>/g)?.length).toBe(1);
      const extracted = page.match(/<style>([\s\S]*?)<\/style>/);
      expect(extracted?.[1]).toBeDefined();
      const digest = `sha256-${createHash("sha256")
        .update(extracted?.[1] ?? "", "utf8")
        .digest("base64")}`;
      expect(header).toContain(`style-src '${digest}'`);
    } finally {
      await server.stop();
    }
  });
});

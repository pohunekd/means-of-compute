// Renderer presentation tests: the key-figure strip reuses panel figures
// with their notes under the value, Work rows carry status pills and a
// placement <details>, timestamps and long identifiers are compact with the
// full value in a title attribute, and every data string stays escaped,
// titles and summaries included.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CSS_HASH, DASHBOARD_CSS, renderDashboard } from "../../src/dashboard/render.js";
import type { Cell, DashboardModel } from "../../src/dashboard/model.js";

function text(value: string): Cell {
  return { kind: "text", text: value };
}

const PLACEMENT =
  "desktop is idle, on AC power, no battery, CPU 97% free, memory 80% free, GPU present, " +
  "inside its policy window, 0/2 agents running, score 0.9117; " +
  "laptop-a: excluded: not idle (user input 0 seconds ago); laptop-b: eligible, score 0.8758";
const BRANCH = 'moc/branch-with-<tag>-and-"quote"-123456789';
const MODEL = "nvidia-build/meta/muse-glimmer-30b";
const STAMP = "2026-11-01T13:03:54.114Z";

function fixture(): DashboardModel {
  return {
    renderedAt: STAMP,
    utcDay: "2026-11-01",
    logPath: "logs/dashboard.jsonl",
    panels: [
      {
        id: "work",
        title: "Work",
        figures: [],
        tables: [
          {
            caption: "Work",
            columns: [
              "item",
              "status",
              "host",
              "placement",
              "branch",
              "model",
              "verdicts",
              "last activity",
            ],
            rows: [
              [
                text("w1-demo"),
                text("parked (operator: audit-failed)"),
                { kind: "aliases", aliases: ["desktop"] },
                text(PLACEMENT),
                text(BRANCH),
                text(MODEL),
                text("4e639dabfdff by muse-spark-1.3-contributor: high 0, medium 0, low 0"),
                text(STAMP),
              ],
              [
                text("w2-demo"),
                text("done"),
                { kind: "aliases", aliases: ["laptop-b"] },
                { kind: "no-data", reason: "not recorded" },
                text("moc/w2-demo"),
                text("meta-api/muse-spark-1.3-contributor"),
                text("none"),
                { kind: "no-data", reason: "no timestamp" },
              ],
            ],
            source: "work store; placement: decision recorded on the newest registry entry",
            note: "showing 2 of 2 items",
          },
        ],
      },
      {
        id: "usage",
        title: "Usage",
        figures: [
          {
            label: "Spent today (UTC 2026-11-01)",
            cell: text("$0.0087"),
            note: null,
            source: "ledger records",
          },
          {
            label: "Spent total",
            cell: text("$0.1892"),
            note: "includes the upper bound for unmeasured calls of w1-demo",
            source: "ledger records",
          },
        ],
        tables: [],
      },
      {
        id: "savings",
        title: "Savings",
        figures: [
          { label: "Total savings", cell: text("$3.1131"), note: null, source: "ledger records" },
        ],
        tables: [],
      },
      {
        id: "autonomy",
        title: "Autonomy",
        figures: [
          {
            label: "Finished tasks",
            cell: text("33 succeeded, 0 blocked"),
            note: null,
            source: "ledger records result",
          },
          {
            label: "Parked tasks",
            cell: text("2"),
            note: null,
            source: "work items with status parked (work store)",
          },
        ],
        tables: [],
      },
    ],
  };
}

test("the page carries the key figures, pills, placement details and compact values", () => {
  const page = renderDashboard(fixture());
  expect(page).toContain(
    "An autonomous software factory on company-owned machines, running on Meta models.",
  );
  expect(page).toContain(
    `<time datetime="${STAMP}" title="${STAMP}">2026-11-01 13:03:54 UTC</time>`,
  );
  const savingsAt = page.indexOf("Total savings");
  const workAt = page.indexOf('<section id="work">');
  expect(savingsAt).toBeGreaterThan(-1);
  expect(savingsAt).toBeLessThan(workAt);
  for (const label of ["Spent total", "Finished tasks", "Parked tasks"]) {
    expect(page.slice(0, workAt)).toContain(label);
  }
  expect(page.slice(0, workAt)).toContain("source: ledger records result");
  expect(page.slice(0, workAt)).toContain(
    '<span class="value">$0.1892</span>\n    <p class="note">includes the upper bound for unmeasured calls of w1-demo</p>',
  );
  expect(page).toContain('<span class="pill pill-parked">parked (operator: audit-failed)</span>');
  expect(page).toContain('<span class="pill pill-done">done</span>');
  expect(page).toContain("<summary>desktop · score 0.9117</summary>");
  expect(page).toContain(`<p class="placement-full">${PLACEMENT}</p>`);
  expect(page).toContain('<td class="nodata">no data (not recorded)</td>');
  expect(page).toContain(`title="moc/branch-with-&lt;tag&gt;-and-&quot;quote&quot;-123456789"`);
  expect(page).not.toContain("<tag>");
  expect(page).toContain(`title="${MODEL}"`);
  expect(page).toContain("nvidia-build/meta/…glimmer-30b");
  expect(page).toContain(
    `<time class="time" datetime="${STAMP}" title="${STAMP}">2026-11-01 13:03:54 UTC</time>`,
  );
  expect(page).toContain("prefers-color-scheme: dark");
  expect(page).toContain(".tablewrap{overflow-x:auto}");
  expect(page).not.toContain("<script");
});

test("the style hash follows the CSS and a bad alias still throws without its value", () => {
  const expected = `sha256-${createHash("sha256").update(DASHBOARD_CSS, "utf8").digest("base64")}`;
  expect(CSS_HASH).toBe(expected);
  const model = fixture();
  const work = model.panels[0]?.tables[0];
  if (work === undefined) {
    throw new Error("expected a work table");
  }
  const broken: DashboardModel = {
    ...model,
    panels: [
      {
        id: "work",
        title: "Work",
        figures: [],
        tables: [
          {
            ...work,
            rows: [
              [
                text("w1-demo"),
                text("done"),
                { kind: "aliases", aliases: ["Bad Alias!"] },
                text("x"),
                text("moc/x"),
                text("m"),
                text("none"),
                text(STAMP),
              ],
            ],
          },
        ],
      },
    ],
  };
  expect(() => renderDashboard(broken)).toThrow("dashboard: invalid host alias in model");
  expect(() => renderDashboard(broken)).not.toThrow("Bad Alias!");
});

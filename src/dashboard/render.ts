// Dashboard page renderer. renderDashboard is pure: it turns the model of
// src/dashboard/model.ts into one HTML string. Aliases are checked against
// the host-alias pattern; a failure throws without the value (a 500 in the
// server). Error messages, paths other than the log path, and the forbidden
// fields of rule 4.6 never reach a cell source.
import { createHash } from "node:crypto";
import { constantHtml, html, SafeHtml } from "./html.js";
import type { Cell, DashboardModel, Figure, Panel, PanelId, Table } from "./model.js";

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const DASHBOARD_CSS = [
  ":root{color-scheme:light;--bg:#f4f6f8;--surface:#ffffff;--surface-2:#eef2f5;--text:#16202b;--muted:#47596b;--border:#c9d4de;--row:#f7f9fb;--accent:#0b5fa5;--error:#8b1e24;--done-bg:#dcf2e3;--done-text:#14532d;--running-bg:#dbeafe;--running-text:#1e3f7a;--parked-bg:#fdeec9;--parked-text:#6b4e00;--bad-bg:#fadfe0;--bad-text:#7a1f24;--neutral-bg:#e5ebf0;--neutral-text:#33475e;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
  "@media (prefers-color-scheme: dark){:root{color-scheme:dark;--bg:#0f151c;--surface:#17212c;--surface-2:#1e2c3a;--text:#e8eff6;--muted:#a9bccd;--border:#33475e;--row:#192634;--accent:#7db8ec;--error:#f3a8ad;--done-bg:#173d27;--done-text:#9fe3b6;--running-bg:#1e3a5f;--running-text:#a9ccf5;--parked-bg:#453a12;--parked-text:#f5d67a;--bad-bg:#4a2226;--bad-text:#f3a8ad;--neutral-bg:#2a3a4a;--neutral-text:#c3d3e2}}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:17px;line-height:1.45;padding:2rem 1.25rem 3rem}",
  "header,main{max-width:110rem;margin:0 auto}",
  "h1{font-size:2.2rem;line-height:1.15;margin:0}",
  ".tagline{font-size:1.15rem;color:var(--muted);margin:0.5rem 0 0}",
  ".meta{color:var(--muted);margin:0.75rem 0 0}",
  ".keyfigures{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem;margin-top:1.25rem}",
  ".keycard{background:var(--surface);border:1px solid var(--border);border-top:4px solid var(--accent);border-radius:12px;padding:1rem 1.1rem}",
  "section{background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px rgb(0 0 0/0.08);margin-top:1.5rem;padding:1.25rem 1.5rem 1.5rem}",
  "h2{font-size:1.45rem;margin:0 0 1rem}",
  ".figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:1rem;margin:0 0 1rem}",
  ".figure{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;margin:0;padding:0.85rem 1rem}",
  ".label{display:block;font-size:0.8rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--muted)}",
  ".keycard .label{font-size:0.78rem}",
  ".value{font-variant-numeric:tabular-nums}",
  ".figure .value,.keycard .value{font-weight:700;font-size:1.25rem}",
  ".keycard .value{font-size:1.55rem}",
  ".figure .nodata,.figure .error,.keycard .nodata,.keycard .error{font-size:1rem}",
  ".nodata{color:var(--muted);font-style:italic}",
  ".error{color:var(--error);font-weight:700}",
  ".cite{font-size:0.78rem;color:var(--muted);margin:0.45rem 0 0;overflow-wrap:anywhere}",
  ".note{font-size:0.85rem;color:var(--muted)}",
  ".tablewrap{overflow-x:auto}",
  "table{border-collapse:collapse;width:100%;margin:0.5rem 0;font-size:0.94rem}",
  ".table-work{min-width:64rem}",
  "caption{font-weight:700;font-size:1.02rem;text-align:left;padding:0.25rem 0 0.6rem}",
  ".caption-same{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
  "thead th{font-size:0.78rem;letter-spacing:0.05em;text-transform:uppercase;color:var(--muted);text-align:left;border-bottom:2px solid var(--border);padding:0.5rem 0.6rem;white-space:nowrap}",
  "th.num,td.num{text-align:right}",
  "td{border-bottom:1px solid var(--border);padding:0.55rem 0.6rem;vertical-align:top}",
  "tbody tr:nth-child(even){background:var(--row)}",
  ".mono{font-family:var(--mono);font-size:0.86em;overflow-wrap:anywhere}",
  ".nowrap{white-space:nowrap}",
  ".verdicts{display:inline-block;min-width:22rem;overflow-wrap:normal}",
  ".time{white-space:nowrap}",
  ".pill{display:inline-block;border-radius:999px;padding:0.12rem 0.6rem;font-size:0.85rem;font-weight:700}",
  ".pill-done{background:var(--done-bg);color:var(--done-text)}",
  ".pill-running{background:var(--running-bg);color:var(--running-text)}",
  ".pill-parked{background:var(--parked-bg);color:var(--parked-text)}",
  ".pill-bad{background:var(--bad-bg);color:var(--bad-text)}",
  ".pill-neutral{background:var(--neutral-bg);color:var(--neutral-text)}",
  "details summary{cursor:pointer;font-weight:600;color:var(--accent);white-space:nowrap}",
  ".placement-full{margin:0.5rem 0 0;color:var(--muted);font-size:0.88rem;max-width:38rem}",
  "@media (max-width:640px){body{padding:1rem 0.6rem 2rem;font-size:16px}section{padding:1rem}h1{font-size:1.7rem}.keyfigures,.figures{grid-template-columns:1fr}}",
].join("\n");

const STYLE_ELEMENT = "<style>" + DASHBOARD_CSS + "</style>";
const STYLE_HTML = constantHtml(STYLE_ELEMENT);

export const CSS_HASH = `sha256-${createHash("sha256").update(DASHBOARD_CSS, "utf8").digest("base64")}`;

const NUMERIC_COLUMNS = new Set([
  "running",
  "input tokens",
  "output tokens",
  "requests",
  "hours",
  "sessions",
  "ended ok",
  "rounds",
  "successes",
  "failures",
  "excluded",
  "success rate",
]);

const TIME_COLUMNS = new Set(["observed", "last activity"]);

// Key cards reuse figures the panels already compute, with their sources;
// the renderer derives no new number for the strip.
const KEY_FIGURES: readonly { readonly panel: PanelId; readonly label: string }[] = [
  { panel: "savings", label: "Total savings" },
  { panel: "usage", label: "Spent total" },
  { panel: "usage", label: "Spent today" },
  { panel: "autonomy", label: "Finished tasks" },
  { panel: "autonomy", label: "Parked tasks" },
];

function checkAliases(aliases: readonly string[]): void {
  for (const alias of aliases) {
    if (!ALIAS_PATTERN.test(alias)) {
      throw new Error("dashboard: invalid host alias in model");
    }
  }
}

function cellText(cell: Cell): string {
  switch (cell.kind) {
    case "text": {
      return cell.text;
    }
    case "aliases": {
      checkAliases(cell.aliases);
      return cell.aliases.join(", ");
    }
    case "no-data": {
      return `no data (${cell.reason})`;
    }
    case "error": {
      return `error (${cell.code})`;
    }
  }
}

function cellClass(cell: Cell): string {
  switch (cell.kind) {
    case "text":
    case "aliases": {
      return "value";
    }
    case "no-data": {
      return "nodata";
    }
    case "error": {
      return "error";
    }
  }
}

function compactTime(iso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(iso)) {
    return null;
  }
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function shortenMiddle(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const keep = limit - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function statusPillClass(text: string): string {
  const status = text.toLowerCase();
  if (status === "done" || status.startsWith("done ") || status.startsWith("session finished")) {
    return "pill pill-done";
  }
  if (status.startsWith("parked")) {
    return "pill pill-parked";
  }
  if (
    status.startsWith("blocked") ||
    status.startsWith("failed") ||
    status.startsWith("session failed") ||
    status.startsWith("session lost") ||
    status.startsWith("session cancelled")
  ) {
    return "pill pill-bad";
  }
  if (
    status === "running" ||
    status === "starting" ||
    status === "review" ||
    status.startsWith("session ended, not finalized")
  ) {
    return "pill pill-running";
  }
  return "pill pill-neutral";
}

function keyFigures(model: DashboardModel): readonly Figure[] {
  const figures: Figure[] = [];
  for (const spec of KEY_FIGURES) {
    const panel = model.panels.find((candidate) => candidate.id === spec.panel);
    const figure = panel?.figures.find(
      (candidate) => candidate.label === spec.label || candidate.label.startsWith(spec.label),
    );
    if (figure !== undefined) {
      figures.push(figure);
    }
  }
  return figures;
}

function renderFigure(figure: Figure, cardClass: string): SafeHtml {
  return html`<div class="${cardClass}">
    <span class="label">${figure.label}</span>
    <span class="${cellClass(figure.cell)}">${cellText(figure.cell)}</span>
    <p class="cite">source: ${figure.source}</p>
  </div>`;
}

function renderPlacement(text: string): SafeHtml {
  const first = text.split("; ")[0] ?? text;
  const alias = first.split(" is ")[0] ?? "";
  const score = /, score (\S+)$/.exec(first)?.[1];
  const summary =
    ALIAS_PATTERN.test(alias) && score !== undefined ? `${alias} · score ${score}` : first;
  return html`<details>
    <summary>${summary}</summary>
    <p class="placement-full">${text}</p>
  </details>`;
}

function renderCell(cell: Cell, panelId: PanelId, column: string): SafeHtml {
  const numeric = NUMERIC_COLUMNS.has(column) ? " num" : "";
  const base = `${cellClass(cell)}${numeric}`;
  if (cell.kind === "aliases") {
    return html`<td class="${base}"><span class="mono nowrap">${cellText(cell)}</span></td>`;
  }
  if (cell.kind !== "text") {
    return html`<td class="${base}">${cellText(cell)}</td>`;
  }
  const text = cell.text;
  if (panelId === "work" && column === "status") {
    return html`<td class="${base}"><span class="${statusPillClass(text)}">${text}</span></td>`;
  }
  if (panelId === "work" && column === "placement") {
    return html`<td class="${base}">${renderPlacement(text)}</td>`;
  }
  if (TIME_COLUMNS.has(column)) {
    const compact = compactTime(text);
    if (compact !== null) {
      return html`<td class="${base}">
        <time class="time" datetime="${text}" title="${text}">${compact}</time>
      </td>`;
    }
  }
  if (column === "model" || column === "branch" || column === "provider") {
    const limit = column === "branch" ? 32 : 30;
    const shown = shortenMiddle(text, limit);
    return shown === text
      ? html`<td class="${base}"><span class="mono nowrap">${text}</span></td>`
      : html`<td class="${base}"><span class="mono nowrap" title="${text}">${shown}</span></td>`;
  }
  if (panelId === "work" && column === "item") {
    return html`<td class="${base}"><span class="mono nowrap">${text}</span></td>`;
  }
  if (panelId === "work" && column === "verdicts") {
    return html`<td class="${base}"><span class="mono verdicts">${text}</span></td>`;
  }
  return html`<td class="${base}">${text}</td>`;
}

function renderTable(table: Table, panelId: PanelId, panelTitle: string): SafeHtml {
  const captionClass = table.caption === panelTitle ? "caption-same" : "";
  const heads = table.columns.map(
    (column) => html`<th class="${NUMERIC_COLUMNS.has(column) ? "num" : ""}">${column}</th>`,
  );
  const rows = table.rows.map(
    (row) =>
      html`<tr>
        ${row.map((cell, index) => renderCell(cell, panelId, table.columns[index] ?? ""))}
      </tr>`,
  );
  const cite = html`<p class="cite">source: ${table.source}</p>`;
  const note = table.note === null ? constantHtml("") : html`<p class="note">${table.note}</p>`;
  return html`<div class="tablewrap">
      <table class="table-${panelId}">
        <caption class="${captionClass}">
          ${table.caption}
        </caption>
        <thead>
          <tr>
            ${heads}
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    ${cite}${note}`;
}

function renderPanel(panel: Panel): SafeHtml {
  const figures =
    panel.figures.length === 0
      ? constantHtml("")
      : html`<div class="figures">
          ${panel.figures.map((figure) => renderFigure(figure, "figure"))}
        </div>`;
  const tables = panel.tables.map((table) => renderTable(table, panel.id, panel.title));
  return html`<section id="${panel.id}">
    <h2>${panel.title}</h2>
    ${figures}${tables}
  </section>`;
}

export function renderDashboard(model: DashboardModel): string {
  const sections = model.panels.map(renderPanel);
  const cards = keyFigures(model).map((figure) => renderFigure(figure, "keycard"));
  const rendered = compactTime(model.renderedAt) ?? model.renderedAt;
  return (
    "<!doctype html>\n" +
    html`<html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Means of Compute dashboard</title>
        ${STYLE_HTML}
      </head>
      <body>
        <header>
          <h1>Means of Compute</h1>
          <p class="tagline">
            An autonomous software factory on company-owned machines, running on Meta models.
          </p>
          <p class="meta">
            Rendered
            <time datetime="${model.renderedAt}" title="${model.renderedAt}">${rendered}</time>, UTC
            day ${model.utcDay}. Every figure names its source. "no data" means an input is missing;
            "error" means an input could not be read (details in ${model.logPath}).
          </p>
          <div class="keyfigures">${cards}</div>
        </header>
        <main>${sections}</main>
      </body>
    </html>`.value
  );
}

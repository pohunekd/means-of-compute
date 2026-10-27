// Dashboard page renderer. renderDashboard is pure: it turns the model of
// src/dashboard/model.ts into one HTML string. Aliases are checked against
// the host-alias pattern; a failure throws without the value (a 500 in the
// server). Error messages, paths other than the log path, and the forbidden
// fields of rule 4.6 never reach a cell source.
import { createHash } from "node:crypto";
import { constantHtml, html, SafeHtml } from "./html.js";
import type { Cell, DashboardModel, Panel, Table } from "./model.js";

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const DASHBOARD_CSS = [
  "body{font-family:system-ui,sans-serif;max-width:72rem;margin:0 auto;padding:1rem}",
  "header p{color:#333}",
  "section{margin-top:2rem;border-top:2px solid #222;padding-top:1rem}",
  ".figure{margin:0.5rem 0}",
  ".label{font-weight:bold}",
  ".value{font-variant-numeric:tabular-nums}",
  ".nodata{color:#666;font-style:italic}",
  ".error{color:#900;font-weight:bold}",
  ".cite{font-size:0.85rem;color:#444}",
  ".note{font-size:0.85rem;color:#444}",
  "table{border-collapse:collapse;margin:1rem 0}",
  "th,td{border:1px solid #999;padding:0.25rem 0.5rem;text-align:left}",
  "caption{font-weight:bold;text-align:left;padding-bottom:0.25rem}",
].join("\n");

const STYLE_ELEMENT = "<style>" + DASHBOARD_CSS + "</style>";
const STYLE_HTML = constantHtml(STYLE_ELEMENT);

export const CSS_HASH = `sha256-${createHash("sha256").update(DASHBOARD_CSS, "utf8").digest("base64")}`;

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

function renderFigure(label: string, cell: Cell, source: string): SafeHtml {
  return html`<div class="figure">
    <span class="label">${label}</span> <span class="${cellClass(cell)}">${cellText(cell)}</span>
    <p class="cite">source: ${source}</p>
  </div>`;
}

function renderCell(cell: Cell): SafeHtml {
  return html`<td class="${cellClass(cell)}">${cellText(cell)}</td>`;
}

function renderTable(table: Table): SafeHtml {
  const heads = table.columns.map((column) => html`<th>${column}</th>`);
  const rows = table.rows.map(
    (row) =>
      html`<tr>
        ${row.map(renderCell)}
      </tr>`,
  );
  const cite = html`<p class="cite">source: ${table.source}</p>`;
  const note = table.note === null ? constantHtml("") : html`<p class="note">${table.note}</p>`;
  return html`<table>
      <caption>
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
    ${cite}${note}`;
}

function renderPanel(panel: Panel): SafeHtml {
  const figures = panel.figures.map((figure) =>
    renderFigure(figure.label, figure.cell, figure.source),
  );
  const tables = panel.tables.map(renderTable);
  return html`<section id="${panel.id}">
    <h2>${panel.title}</h2>
    ${figures}${tables}
  </section>`;
}

export function renderDashboard(model: DashboardModel): string {
  const sections = model.panels.map(renderPanel);
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
          <p>
            Rendered <time datetime="${model.renderedAt}">${model.renderedAt}</time>, UTC day
            ${model.utcDay}. Every figure names its source. "no data" means an input is missing;
            "error" means an input could not be read (details in ${model.logPath}).
          </p>
        </header>
        <main>${sections}</main>
      </body>
    </html>`.value
  );
}

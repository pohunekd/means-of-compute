// Dashboard visual system and page renderers. One stylesheet (DASHBOARD_CSS,
// hashed as CSS_HASH for the CSP) and one set of components (header, tab
// bar, subtitle, cards, boxes, tables, pills, chips) serve every page: the
// stacked snapshot page, the Work, Models and Savings tabs, and the Live tab
// in live-render.ts. Renderers are pure; aliases are checked against the
// host-alias pattern and a failure throws without the value (a 500 in the
// server). Error messages, paths other than the log path, and the forbidden
// fields of rule 4.6 never reach a cell source.
import { createHash } from "node:crypto";
import { constantHtml, html, SafeHtml } from "./html.js";
import type { Cell, DashboardModel, Figure, Panel, PanelId, Table } from "./model.js";

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// Light tokens by default, dark under prefers-color-scheme. Only source
// cites (.cite, .srccol) and the tile legend go below 15 px.
export const DASHBOARD_CSS = [
  ":root{color-scheme:light;--bg:#f2f6fa;--panel:#ffffff;--panel2:#eef4f9;--line:#c9d8e6;--ink:#12222f;--dim:#476173;--faint:#5f7a8f;--acc:#0b6bc4;--run:#128a4c;--eli:#0b6bc4;--blk:#9a6a00;--busy:#5c7185;--off:#b9c9d6;--amber:#b25f00;--real:#0b6bc4;--bad:#b3261e;--on-strong:#ffffff}",
  "@media (prefers-color-scheme: dark){:root{color-scheme:dark;--bg:#0a1118;--panel:#101c28;--panel2:#0d1722;--line:#22374d;--ink:#e8f1f8;--dim:#9db4c8;--faint:#7d95a9;--acc:#57b6ff;--run:#43d17c;--eli:#7cc7ff;--blk:#e8b64c;--busy:#8d9eb0;--off:#3d4f63;--amber:#ffb454;--real:#57b6ff;--bad:#ff8a80;--on-strong:#08131d}}",
  "*{box-sizing:border-box}",
  "html{background:var(--bg)}",
  "body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}",
  "a{color:var(--acc);text-decoration:none}",
  "a:hover{text-decoration:underline}",
  "a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}",
  ".page{max-width:1880px;margin:0 auto;padding:9px 20px 12px}",
  ".frame{height:100vh;display:flex;flex-direction:column}",
  ".frame>main{flex:1;min-height:0;display:flex;flex-direction:column}",
  "header.top{display:flex;align-items:baseline;gap:6px 18px;flex-wrap:wrap}",
  "h1{font-size:23px;margin:0;font-weight:650;line-height:1.25}",
  ".clock{color:var(--dim);font-size:15px;font-variant-numeric:tabular-nums}",
  ".clock b{color:var(--ink);font-weight:600}",
  ".paused{background:var(--amber);color:var(--on-strong);border-radius:5px;padding:1px 9px;font-size:15px;font-weight:700}",
  ".tagline{color:var(--dim);font-size:15px;margin:0 0 0 auto}",
  "nav.tabs{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 0;padding-bottom:8px;border-bottom:1px solid var(--line)}",
  ".tab{font-size:17px;color:var(--dim);padding:6px 16px;border-radius:999px;border:1px solid transparent}",
  ".tab.active{color:var(--ink);border-color:var(--acc);background:var(--panel)}",
  ".controls{margin-left:auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:17px}",
  ".controls a{border:1px solid var(--line);border-radius:999px;padding:5px 15px;color:var(--ink);background:var(--panel)}",
  ".controls a.on{border-color:var(--acc);color:var(--acc)}",
  ".sub{color:var(--dim);font-size:16px;margin:6px 0 0}",
  ".sub b{color:var(--ink)}",
  "main{min-width:0}",
  ".cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:12px;margin:10px 0}",
  ".card{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--acc);border-radius:10px;padding:10px 14px;margin:0;min-width:0}",
  ".card>.label{display:block;font-size:15px;letter-spacing:0.04em;color:var(--dim);text-transform:uppercase}",
  ".card>.value{display:block;font-size:31px;font-weight:650;line-height:1.2;margin:2px 0}",
  ".card>.nodata,.card>.error{display:block;font-size:17px;margin:4px 0}",
  ".big .card>.value{font-size:42px}",
  ".card.good{border-top-color:var(--run)}",
  ".card.good>.value{color:var(--run)}",
  "section,.panel{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin:0 0 10px;min-width:0}",
  "h2{font-size:19px;margin:0 0 4px;font-weight:650}",
  "h2 .cnt{color:var(--dim);font-weight:500;font-size:16px}",
  "h3{font-size:17px;margin:0 0 4px;font-weight:650}",
  ".value{font-variant-numeric:tabular-nums}",
  ".nodata{color:var(--dim);font-style:italic}",
  ".error{color:var(--bad);font-weight:700}",
  ".note{font-size:15px;color:var(--dim);margin:2px 0 0}",
  ".cite{font-size:12.5px;color:var(--faint);margin:4px 0 0;overflow-wrap:anywhere}",
  ".shown{font-size:15px;color:var(--dim);margin:6px 0 0}",
  ".frame .card .note,.frame section .note{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}",
  ".frame .card .cite,.frame .big .card .note{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".chip{display:inline-block;font-size:15px;font-weight:700;letter-spacing:0.04em;border-radius:5px;padding:0 7px;line-height:1.35;vertical-align:1px;white-space:nowrap}",
  ".chip-real{background:var(--real);color:var(--on-strong)}",
  ".simtag{display:inline-block;font-size:15px;font-weight:700;letter-spacing:0.04em;border-radius:5px;padding:0 7px;line-height:1.3;vertical-align:1px;white-space:nowrap;border:1.5px dashed var(--dim);color:var(--dim)}",
  ".pill{display:inline-block;border-radius:999px;padding:1px 10px;font-size:15px;font-weight:650;white-space:nowrap}",
  ".pill-done{background:var(--run);color:var(--on-strong)}",
  ".pill-running{background:var(--eli);color:var(--on-strong)}",
  ".pill-parked{background:var(--amber);color:var(--on-strong)}",
  ".pill-bad{background:var(--bad);color:var(--on-strong)}",
  ".pill-neutral{background:var(--panel);color:var(--ink);border:1px solid var(--line)}",
  ".tablewrap{overflow-x:auto}",
  "table{border-collapse:collapse;width:100%;margin:0;font-size:15px}",
  ".table-work{min-width:64rem}",
  "caption{font-weight:650;font-size:17px;text-align:left;padding:2px 0 6px}",
  ".caption-same{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
  "th{text-align:left;color:var(--dim);font-size:15px;font-weight:600;padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap}",
  "td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}",
  "th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}",
  "td.srccol{font-size:12.5px;color:var(--faint);max-width:26rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  "td.figsrc{font-size:12.5px;color:var(--faint);overflow-wrap:anywhere}",
  ".mono{overflow-wrap:anywhere}",
  ".nowrap{white-space:nowrap}",
  ".verdicts{display:inline-block;min-width:20rem;overflow-wrap:normal}",
  ".time{white-space:nowrap}",
  "details summary{cursor:pointer;font-weight:600;color:var(--acc);white-space:nowrap}",
  ".placement-full{margin:4px 0 0;color:var(--dim);font-size:15px;max-width:38rem}",
  "meter{display:block;width:100%;min-width:12rem;height:14px;margin-top:4px}",
  "td.fignote{color:var(--dim)}",
  "td.figlabel,td.figamount{white-space:nowrap}",
  ".table-savings{table-layout:fixed}",
  ".table-savings td{padding:4px 8px;line-height:1.35}",
  ".table-savings .c-label{width:14%}",
  ".table-savings .c-amount{width:8%}",
  ".table-savings .c-note{width:34%}",
  "meter::-webkit-meter-bar{background:var(--panel);border:1px solid var(--line);border-radius:5px}",
  "meter::-webkit-meter-optimum-value{background:var(--run);border-radius:5px}",
  ".cols2{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;align-items:start}",
  ".realwork{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:6px 0 8px}",
  ".rw{border:1.5px solid var(--real);border-top-width:1.5px;padding:8px 12px}",
  ".rw.idle{border-color:var(--line)}",
  ".rw .al{font-size:19px;font-weight:650;color:var(--ink)}",
  ".rw .task{font-size:16px;font-weight:600;margin:3px 0 2px;line-height:1.3;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}",
  ".rw .task.idle-task{color:var(--dim)}",
  ".rw .meta{font-size:15px;color:var(--dim);margin:1px 0;line-height:1.35}",
  ".rw .meta b{color:var(--ink);font-weight:650}",
  ".fin{display:flex;gap:12px;margin:0 0 10px;align-items:stretch}",
  ".fin .fi{flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:5px 12px;font-size:15px;line-height:1.35}",
  ".fin .fi.fin-label{flex:0 0 auto;background:none;border:none;padding:5px 0;font-size:16px}",
  ".live-layout{display:grid;grid-template-columns:minmax(0,1fr) 600px;gap:12px;flex:1;min-height:0}",
  ".live-layout>section{margin:0}",
  ".rail{display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto}",
  ".rail>section{margin:0}",
  ".groups{display:flex;flex-direction:column;gap:6px;margin:6px 0 0}",
  ".live-group{display:flex;flex-wrap:wrap;gap:5px;align-items:center}",
  ".ghead{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin-right:6px;font-size:15px}",
  ".ghead b{font-weight:650}",
  ".gcount{color:var(--dim)}",
  ".tile{display:inline-flex;align-items:baseline;gap:6px;padding:2px 7px 2px 6px;border:1px solid var(--line);border-left:5px solid var(--off);border-radius:7px;background:var(--panel);color:var(--ink);font-size:15px;line-height:1.35;white-space:nowrap;font-variant-numeric:tabular-nums}",
  ".tile:hover{text-decoration:none;border-color:var(--acc)}",
  ".tile .alias{font-weight:650}",
  ".tile .load{color:var(--dim)}",
  ".tile-running{border-left-color:var(--run)}",
  ".tile-eligible{border-left-color:var(--eli)}",
  ".tile-blocked{border-left-color:var(--blk)}",
  ".tile-busy{border-left-color:var(--busy)}",
  ".tile-offline{border-left-color:var(--off);color:var(--dim)}",
  ".tile-reported{border-left-color:var(--eli)}",
  ".tile-unavailable{border-left-color:var(--bad)}",
  ".tile-flagged{border-color:var(--amber);box-shadow:0 0 0 1px var(--amber)}",
  ".flag{color:var(--amber);font-weight:700}",
  ".legend{font-size:13.5px;color:var(--dim);margin:6px 0 0}",
  ".dot{display:inline-block;width:11px;height:11px;border-radius:3px;margin:0 4px 0 10px;vertical-align:-1px;background:var(--off)}",
  ".dot.tile-running{background:var(--run)}",
  ".dot.tile-eligible{background:var(--eli)}",
  ".dot.tile-blocked{background:var(--blk)}",
  ".dot.tile-busy{background:var(--busy)}",
  ".dot.tile-flagged{background:none;border:2px solid var(--amber)}",
  ".tick{list-style:none;margin:0;padding:0;font-size:15px}",
  ".tick li{padding:3px 0;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".tick time{color:var(--dim);margin-right:6px;font-variant-numeric:tabular-nums}",
  ".tick .sim{border-left:3px dashed var(--dim);padding-left:6px}",
  ".panel .row{font-size:15px;margin:3px 0;color:var(--dim)}",
  ".panel ul{margin:2px 0 4px;padding-left:20px;font-size:15px}",
  ".panel li{margin:1px 0;overflow-wrap:anywhere}",
  ".panel h3{font-size:19px}",
  ".breadcrumb{font-size:15px;color:var(--dim)}",
  "@media (max-width:900px){.frame{height:auto}.live-layout,.cols2{grid-template-columns:1fr}.realwork{grid-template-columns:repeat(2,minmax(0,1fr))}.fin{flex-wrap:wrap}.tagline{margin-left:0}}",
].join("\n");

const STYLE_HTML = constantHtml("<style>" + DASHBOARD_CSS + "</style>");

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

// Long id lists that cite where a row came from; on a framed tab they are
// one clipped source line with the full text in the title.
const SOURCE_COLUMNS = new Set(["sources"]);

// Key cards reuse figures the panels already compute, with their sources;
// the renderer derives no new number for the strip.
const KEY_FIGURES: readonly { readonly panel: PanelId; readonly label: string }[] = [
  { panel: "savings", label: "Total savings" },
  { panel: "usage", label: "Spent total" },
  { panel: "usage", label: "Spent today" },
  { panel: "autonomy", label: "Finished tasks" },
  { panel: "autonomy", label: "Parked tasks" },
];

export type TabId = "live" | "work" | "models" | "savings";

export const TAB_LABELS: Readonly<Record<TabId, string>> = {
  live: "Live",
  work: "Work",
  models: "Models",
  savings: "Savings",
};

export const TAB_SUBTITLES: Readonly<Record<TabId, string>> = {
  live: "the real machines and their work first; below, the simulated company evening replayed through the real placement engine.",
  work: "every task the factory has taken: its status, its machine, its model and its audit verdict. All real.",
  models:
    "every real model call the factory made: which model, which provider, how many tokens, what it cost.",
  savings:
    "what the same work would have cost at frontier prices, what it cost here, and the budget cap. All real, from the ledger.",
};

const LIVE_TAGLINE =
  "Real placement engine, synthetic fleet; the four real machines and the model calls are live.";
const REAL_TAGLINE =
  "An autonomous software factory on company-owned machines, running on Meta models.";

// Rows a framed tab shows before `showing N of M`; with the row and card
// sizes of DASHBOARD_CSS these keep every tab inside one 1920x1080 frame.
const FRAME_ROWS = {
  work: 17,
  modelsTable: 6,
  calls: 4,
} as const;

export type SelectionKey = "host" | "task" | "call" | "audit";

export interface Selection {
  readonly key: SelectionKey;
  readonly value: string;
}

// Replay state of the simulated evening, present when live sources are wired.
export interface ReplayClock {
  readonly simAt: string | null;
  readonly simMinute: number | null;
  readonly durationMinutes: number | null;
  readonly refreshSeconds: number | null;
  readonly nextMinute: number | null;
}

export interface PageChrome {
  readonly view: TabId;
  readonly liveAvailable: boolean;
  readonly renderedAt: string;
  readonly t: number;
  readonly paused: boolean;
  readonly replay: ReplayClock | null;
  readonly selection: Selection | null;
}

export interface RenderContext {
  readonly linkItems: boolean;
  readonly frame: boolean;
  readonly chrome: PageChrome | null;
  readonly knownWorkIds: ReadonlySet<string>;
}

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

export function compactTime(iso: string): string | null {
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

function panelOf(model: DashboardModel, id: PanelId): Panel | null {
  return model.panels.find((panel) => panel.id === id) ?? null;
}

function keyFigures(model: DashboardModel): readonly Figure[] {
  const figures: Figure[] = [];
  for (const spec of KEY_FIGURES) {
    const panel = panelOf(model, spec.panel);
    const figure = panel?.figures.find(
      (candidate) => candidate.label === spec.label || candidate.label.startsWith(spec.label),
    );
    if (figure !== undefined) {
      figures.push(figure);
    }
  }
  return figures;
}

// Value, note and source line are separate elements, in falling size: the
// qualifier never sits inside the value.
function renderFigure(figure: Figure, cardClass: string): SafeHtml {
  const note = figure.note === null ? constantHtml("") : html`<p class="note">${figure.note}</p>`;
  const title =
    figure.note === null ? `source: ${figure.source}` : `${figure.note}; source: ${figure.source}`;
  return html`<div class="${cardClass}" title="${title}">
    <span class="label">${figure.label}</span>
    <span class="${cellClass(figure.cell)}">${cellText(figure.cell)}</span>
    ${note}
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

function renderCell(cell: Cell, panelId: PanelId, column: string, ctx?: RenderContext): SafeHtml {
  const numeric = NUMERIC_COLUMNS.has(column) ? " num" : "";
  const base = `${cellClass(cell)}${numeric}`;
  if (cell.kind === "aliases") {
    return html`<td class="${base}"><span class="mono nowrap">${cellText(cell)}</span></td>`;
  }
  if (cell.kind !== "text") {
    return html`<td class="${base}">${cellText(cell)}</td>`;
  }
  const text = cell.text;
  if (ctx?.frame === true && SOURCE_COLUMNS.has(column)) {
    return html`<td class="srccol" title="${text}">${text}</td>`;
  }
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
    const chrome = ctx?.chrome ?? null;
    if (
      ctx !== undefined &&
      chrome !== null &&
      ctx.linkItems &&
      chrome.liveAvailable &&
      ctx.knownWorkIds.has(text) &&
      text.trim() !== ""
    ) {
      const href = pageHref("live", chrome.t, chrome.paused, { key: "task", value: text });
      return html`<td class="${base}">
        <span class="mono nowrap"><a href="${href}">${text}</a></span>
      </td>`;
    }
    return html`<td class="${base}"><span class="mono nowrap">${text}</span></td>`;
  }
  if (panelId === "work" && column === "verdicts") {
    return html`<td class="${base}"><span class="mono verdicts">${text}</span></td>`;
  }
  return html`<td class="${base}">${text}</td>`;
}

function renderTable(
  table: Table,
  panelId: PanelId,
  panelTitle: string,
  ctx?: RenderContext,
): SafeHtml {
  const captionClass = table.caption === panelTitle ? "caption-same" : "";
  const heads = table.columns.map(
    (column) => html`<th class="${NUMERIC_COLUMNS.has(column) ? "num" : ""}">${column}</th>`,
  );
  const rows = table.rows.map(
    (row) =>
      html`<tr>
        ${row.map((cell, index) => renderCell(cell, panelId, table.columns[index] ?? "", ctx))}
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
      : html`<div class="cards">
          ${panel.figures.map((figure) => renderFigure(figure, "card"))}
        </div>`;
  const tables = panel.tables.map((table) => renderTable(table, panel.id, panel.title));
  return html`<section id="${panel.id}">
    <h2>${panel.title}</h2>
    ${figures}${tables}
  </section>`;
}

function documentHtml(title: string, head: SafeHtml, body: SafeHtml): string {
  return (
    "<!doctype html>\n" +
    html`<html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        ${head}
        <title>${title}</title>
        ${STYLE_HTML}
      </head>
      <body>
        ${body}
      </body>
    </html>`.value
  );
}

// The stacked page: every panel in order, real only, for the offline snapshot.
export function renderDashboard(model: DashboardModel): string {
  const sections = model.panels.map(renderPanel);
  const cards = keyFigures(model).map((figure) => renderFigure(figure, "card"));
  const rendered = compactTime(model.renderedAt) ?? model.renderedAt;
  return documentHtml(
    "Means of Compute dashboard",
    constantHtml(""),
    html`<div class="page">
      <header class="top">
        <h1>Means of Compute</h1>
        <span class="clock"
          >rendered
          <b><time datetime="${model.renderedAt}" title="${model.renderedAt}">${rendered}</time></b>
          · UTC day ${model.utcDay}</span
        >
        <p class="tagline">${REAL_TAGLINE}</p>
      </header>
      <p class="sub">
        Every figure names its source. "no data" means an input is missing; "error" means an input
        could not be read (details in ${model.logPath}).
      </p>
      <div class="cards">${cards}</div>
      <main>${sections}</main>
    </div>`,
  );
}

export function pageHref(
  view: TabId,
  t: number,
  paused: boolean,
  selection: Selection | null,
): string {
  const params = new URLSearchParams();
  params.set("view", view);
  if (t !== 0) {
    params.set("t", String(t));
  }
  if (paused) {
    params.set("pause", "1");
  }
  if (selection !== null) {
    params.set(selection.key, selection.value);
  }
  return `/?${params.toString()}`;
}

function tabsOf(chrome: PageChrome): readonly TabId[] {
  return chrome.liveAvailable
    ? ["live", "work", "models", "savings"]
    : ["work", "models", "savings"];
}

function renderClock(chrome: PageChrome): SafeHtml {
  const rendered = compactTime(chrome.renderedAt) ?? chrome.renderedAt;
  const real = html`real
    <b><time datetime="${chrome.renderedAt}" title="${chrome.renderedAt}">${rendered}</time></b>`;
  const replay = chrome.replay;
  if (replay === null) {
    return html`<span class="clock">${real}</span>`;
  }
  const sim =
    replay.simAt === null
      ? html` · no simulated input`
      : html` · simulated evening
          <b
            >${compactTime(replay.simAt) ?? replay.simAt} (minute ${String(replay.simMinute ?? 0)}
            of ${String(replay.durationMinutes ?? 0)})</b
          >`;
  return html`<span class="clock">${real}${sim}</span>`;
}

// Replay controls keep the view and the open panel; tab links drop the panel.
function renderControls(chrome: PageChrome): SafeHtml {
  const replay = chrome.replay;
  if (replay === null) {
    return constantHtml("");
  }
  const duration = replay.durationMinutes ?? 240;
  const href = (t: number, paused: boolean): string =>
    pageHref(chrome.view, t, paused, chrome.selection);
  const toggle = chrome.paused
    ? html`<a href="${href(chrome.t, false)}">resume</a>`
    : html`<a href="${href(chrome.t, true)}">pause</a>`;
  const jumps = [0, 60, 120, 180, 240]
    .filter((minute) => minute <= duration)
    .map((minute) =>
      minute === chrome.t
        ? html`<a class="on" href="${href(minute, chrome.paused)}">${String(minute)}</a>`
        : html`<a href="${href(minute, chrome.paused)}">${String(minute)}</a>`,
    );
  return html`<span class="controls">
    ${toggle}
    <a href="${href(0, chrome.paused)}">restart</a>
    <a href="${href(Math.max(0, chrome.t - 5), chrome.paused)}">-5</a>
    <a href="${href(Math.min(duration, chrome.t + 5), chrome.paused)}">+5</a>
    ${jumps}
  </span>`;
}

function renderTabBar(chrome: PageChrome): SafeHtml {
  const links = tabsOf(chrome).map((tab) => {
    const href = pageHref(tab, chrome.t, chrome.paused, null);
    return tab === chrome.view
      ? html`<a class="tab active" href="${href}" aria-current="page">${TAB_LABELS[tab]}</a>`
      : html`<a class="tab" href="${href}">${TAB_LABELS[tab]}</a>`;
  });
  return html`<nav class="tabs" aria-label="Views">${links}${renderControls(chrome)}</nav>`;
}

function renderRefresh(chrome: PageChrome): SafeHtml {
  const replay = chrome.replay;
  if (
    replay === null ||
    chrome.paused ||
    replay.nextMinute === null ||
    replay.refreshSeconds === null
  ) {
    return constantHtml("");
  }
  const target = pageHref(chrome.view, replay.nextMinute, false, chrome.selection);
  return html`<meta
    http-equiv="refresh"
    content="${String(replay.refreshSeconds)};url=${target}"
  />`;
}

// One framed page: header, tab bar with replay controls, the tab's one-line
// subtitle, then the tab's own content in a 1920x1080 frame.
export function renderFramedPage(chrome: PageChrome, main: SafeHtml): string {
  const paused = chrome.paused ? html`<span class="paused">paused</span>` : constantHtml("");
  const tagline = chrome.liveAvailable ? LIVE_TAGLINE : REAL_TAGLINE;
  return documentHtml(
    `Means of Compute - ${TAB_LABELS[chrome.view]}`,
    renderRefresh(chrome),
    html`<div class="page frame">
      <header class="top">
        <h1>Means of Compute</h1>
        ${renderClock(chrome)} ${paused}
        <p class="tagline">${tagline}</p>
      </header>
      ${renderTabBar(chrome)}
      <p class="sub"><b>${TAB_LABELS[chrome.view]}</b> - ${TAB_SUBTITLES[chrome.view]}</p>
      <main>${main}</main>
    </div>`,
  );
}

// A presentation column placed after a named column; it shows the row's own
// cells another way and adds no figure.
interface ExtraColumn {
  readonly after: string;
  readonly header: string;
  readonly cell: (row: readonly Cell[]) => SafeHtml;
}

// A panel table inside a box: heading, the first `limit` rows, the
// `showing N of M` line when rows are left out, note and source.
function frameTable(
  table: Table,
  panelId: PanelId,
  ctx: RenderContext,
  options: {
    readonly heading: SafeHtml;
    readonly limit: number;
    readonly total: number;
    readonly unit: string;
    readonly alwaysShown: boolean;
    readonly keepNote: boolean;
    readonly extraColumn?: ExtraColumn;
  },
): SafeHtml {
  const extra = options.extraColumn;
  const heads = table.columns.map((column) => {
    const head = html`<th class="${NUMERIC_COLUMNS.has(column) ? "num" : ""}">${column}</th>`;
    return extra !== undefined && extra.after === column
      ? html`${head}
          <th>${extra.header}</th>`
      : head;
  });
  const shownRows = table.rows.slice(0, options.limit);
  const rows = shownRows.map(
    (row) =>
      html`<tr>
        ${row.map((cell, index) => {
          const column = table.columns[index] ?? "";
          const rendered = renderCell(cell, panelId, column, ctx);
          return extra !== undefined && extra.after === column
            ? html`${rendered}
                <td class="meterwrap">${extra.cell(row)}</td>`
            : rendered;
        })}
      </tr>`,
  );
  const shown =
    options.alwaysShown || shownRows.length < options.total
      ? html`<p class="shown">
          showing ${String(shownRows.length)} of ${String(options.total)} ${options.unit}
        </p>`
      : constantHtml("");
  const note =
    !options.keepNote || table.note === null
      ? constantHtml("")
      : html`<p class="note" title="${table.note}">${table.note}</p>`;
  return html`<section class="box">
    <h2>${options.heading}</h2>
    <div class="tablewrap">
      <table class="table-${panelId}" aria-label="${table.caption}">
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
    ${shown}${note}
    <p class="cite" title="source: ${table.source}">source: ${table.source}</p>
  </section>`;
}

function tableOf(panel: Panel | null, caption: string): Table | null {
  return panel?.tables.find((table) => table.caption === caption) ?? null;
}

// Figures in the given label order, then any the order does not name.
function orderedFigures(panel: Panel | null, order: readonly string[]): readonly Figure[] {
  if (panel === null) {
    return [];
  }
  const rank = (figure: Figure): number => {
    const index = order.findIndex(
      (label) => figure.label === label || figure.label.startsWith(label),
    );
    return index === -1 ? order.length : index;
  };
  return [...panel.figures].sort((a, b) => rank(a) - rank(b));
}

function simpleTable(table: Table, panelId: PanelId, ctx: RenderContext, limit: number): SafeHtml {
  return frameTable(table, panelId, ctx, {
    heading: html`${table.caption}`,
    limit,
    total: table.rows.length,
    unit: "rows",
    alwaysShown: false,
    keepNote: true,
  });
}

export interface TabPageInputs {
  readonly model: DashboardModel;
  readonly chrome: PageChrome;
  readonly knownWorkIds: ReadonlySet<string>;
  // Every work item the Work table could list, before any row limit.
  readonly workTotal: number;
  // Latest real meter calls for the Models tab, rendered by live-render
  // with the row limit of this frame.
  readonly calls: ((limit: number) => SafeHtml) | null;
}

function renderWorkTab(inputs: TabPageInputs, ctx: RenderContext): SafeHtml {
  const work = panelOf(inputs.model, "work");
  const autonomy = panelOf(inputs.model, "autonomy");
  const cards = orderedFigures(autonomy, [
    "Finished tasks",
    "Parked tasks",
    "Human interventions",
    "Retries",
  ]).map((figure) => renderFigure(figure, "card"));
  const table = tableOf(work, "Work");
  const linkHint = inputs.chrome.liveAvailable
    ? "newest first; click an item for its goal, audit and cost"
    : "newest first";
  return html`<div class="cards">${cards}</div>
    ${
      table === null
        ? constantHtml("")
        : frameTable(table, "work", ctx, {
            heading: html`Work items <span class="cnt">· ${linkHint}</span>`,
            limit: FRAME_ROWS.work,
            total: inputs.workTotal,
            unit: "items",
            alwaysShown: true,
            keepNote: false,
          })
    }`;
}

function renderModelsTab(inputs: TabPageInputs, ctx: RenderContext): SafeHtml {
  const usage = panelOf(inputs.model, "usage");
  const models = panelOf(inputs.model, "models");
  const autonomy = panelOf(inputs.model, "autonomy");
  const cards = (usage?.figures ?? []).map((figure) => renderFigure(figure, "card"));
  const pick = (panel: Panel | null, caption: string, panelId: PanelId): SafeHtml => {
    const table = tableOf(panel, caption);
    return table === null
      ? constantHtml("")
      : simpleTable(table, panelId, ctx, FRAME_ROWS.modelsTable);
  };
  return html`<div class="cards">${cards}</div>
    <div class="cols2">
      <div>
        ${pick(models, "Models", "models")}
        ${pick(autonomy, "Sessions per model (finished tasks)", "autonomy")}
        ${inputs.calls === null ? constantHtml("") : inputs.calls(FRAME_ROWS.calls)}
      </div>
      <div>
        ${pick(usage, "Tokens by provider (finished tasks)", "usage")}
        ${pick(usage, "Session hours by host (finished tasks)", "usage")}
      </div>
    </div>`;
}

const USD_TEXT = /^\$(\d+(?:\.\d+)?)$/;

function usdOf(cell: Cell | undefined): string | null {
  if (cell === undefined || cell.kind !== "text") {
    return null;
  }
  return USD_TEXT.exec(cell.text)?.[1] ?? null;
}

// A bar of a budget pool row's spent total against its total cap, both read
// from the row's own cells; a row without both dollar values has no bar.
function capMeter(columns: readonly string[]): ExtraColumn {
  return {
    after: "spent total",
    header: "of total cap",
    cell: (row) => {
      const spent = usdOf(row[columns.indexOf("spent total")]);
      const cap = usdOf(row[columns.indexOf("total cap")]);
      if (spent === null || cap === null || Number(cap) <= 0) {
        return constantHtml("");
      }
      return html`<meter min="0" max="${cap}" value="${spent}"></meter>`;
    },
  };
}

function renderSavingsTab(inputs: TabPageInputs, ctx: RenderContext): SafeHtml {
  const savings = panelOf(inputs.model, "savings");
  const usage = panelOf(inputs.model, "usage");
  const figures = savings?.figures ?? [];
  const big = ["Frontier-token baseline", "Actual token cost", "Token savings"].flatMap((label) => {
    const figure = figures.find((candidate) => candidate.label === label);
    return figure === undefined
      ? []
      : [renderFigure(figure, label === "Token savings" ? "card good" : "card")];
  });
  const pools = tableOf(usage, "Budget pools");
  const poolsBox =
    pools === null
      ? constantHtml("")
      : frameTable(pools, "usage", ctx, {
          heading: html`Budget caps
            <span class="cnt">· the guard refuses new sessions at a cap</span>`,
          limit: pools.rows.length,
          total: pools.rows.length,
          unit: "rows",
          alwaysShown: false,
          keepNote: true,
          extraColumn: capMeter(pools.columns),
        });
  const rows = figures.map((figure) => {
    const value = html`<td class="${cellClass(figure.cell)} num figamount">
      ${cellText(figure.cell)}
    </td>`;
    return html`<tr>
      <td class="figlabel">${figure.label}</td>
      ${value}
      <td class="fignote">${figure.note ?? ""}</td>
      <td class="figsrc">source: ${figure.source}</td>
    </tr>`;
  });
  return html`<div class="cards big">${big}</div>
    ${poolsBox}
    <section class="box">
      <h2>Where the saving comes from <span class="cnt">· every figure names its source</span></h2>
      <div class="tablewrap">
        <table class="table-savings" aria-label="Savings figures">
          <thead>
            <tr>
              <th class="c-label">figure</th>
              <th class="num c-amount">amount</th>
              <th class="c-note">note</th>
              <th>source</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <p class="cite">All figures real, from the ledger; no simulated number enters this tab.</p>
    </section>`;
}

// Work, Models or Savings in the shared frame. Every figure and cell comes
// from the panels buildDashboard computed; nothing here derives a number.
export function renderTabPage(view: "work" | "models" | "savings", inputs: TabPageInputs): string {
  const ctx: RenderContext = {
    linkItems: true,
    frame: true,
    chrome: inputs.chrome,
    knownWorkIds: inputs.knownWorkIds,
  };
  const main =
    view === "work"
      ? renderWorkTab(inputs, ctx)
      : view === "models"
        ? renderModelsTab(inputs, ctx)
        : renderSavingsTab(inputs, ctx);
  return renderFramedPage(inputs.chrome, main);
}

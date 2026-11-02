// Live view renderer. renderLive is pure: it turns the model of
// src/dashboard/live.ts into one HTML string. The style element is the
// dashboard stylesheet plus the live rules, hashed as LIVE_CSS_HASH for
// the CSP. Aliases are checked against the host-alias pattern; a failure
// throws without the value (a 500 in the server). There is no script:
// frames advance through a meta refresh and a plain next-frame link.
import { createHash } from "node:crypto";
import { constantHtml, html, SafeHtml } from "./html.js";
import { DASHBOARD_CSS } from "./render.js";
import type {
  LiveActivityRow,
  LiveCell,
  LiveCounter,
  LiveGroup,
  LiveModel,
  LiveSection,
  LiveTile,
  LiveTickerRow,
} from "./live.js";

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const LIVE_CSS = [
  ".live-head{display:flex;flex-wrap:wrap;gap:0.5rem 2rem;align-items:baseline}",
  ".live-clocks{font-variant-numeric:tabular-nums;color:var(--muted);font-size:1.05rem}",
  ".live-clocks strong{color:var(--text)}",
  ".live-layout{display:grid;grid-template-columns:minmax(0,1.62fr) minmax(0,1fr);gap:1.5rem;align-items:start}",
  ".live-side{display:grid;gap:1.5rem}",
  ".live-side section{margin-top:0}",
  ".live-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(7.8rem,1fr));gap:6px}",
  ".live-group h3{font-size:0.95rem;margin:1rem 0 0.45rem;color:var(--muted)}",
  ".live-group:first-child h3{margin-top:0}",
  ".live-tile{border:1px solid var(--border);border-radius:8px;padding:0.32rem 0.45rem;min-height:3.9rem;background:var(--surface-2)}",
  ".live-tile .alias{font-family:var(--mono);font-size:0.8rem;font-weight:700;white-space:nowrap}",
  ".live-tile .tag{display:block;font-size:0.55rem;font-weight:700;letter-spacing:0.05em;margin-bottom:0.15rem}",
  ".live-tile .state{font-size:0.75rem}",
  ".tile-eligible{background:var(--done-bg);color:var(--done-text)}",
  ".tile-running{background:var(--running-bg);color:var(--running-text)}",
  ".tile-blocked{background:var(--parked-bg);color:var(--parked-text)}",
  ".tile-busy{background:var(--neutral-bg);color:var(--neutral-text)}",
  ".tile-offline{background:var(--surface);color:var(--muted);border-style:dashed}",
  ".tile-reported{background:var(--neutral-bg);color:var(--neutral-text)}",
  ".tile-unavailable{background:var(--bad-bg);color:var(--bad-text)}",
  ".tile-sim{border-style:dashed}",
  ".live-legend{font-size:0.78rem;color:var(--muted);margin:0.8rem 0 0}",
  ".live-ticker{list-style:none;margin:0;padding:0}",
  ".live-ticker li{font-size:0.9rem;padding:0.42rem 0.5rem;border-bottom:1px solid var(--border)}",
  ".live-ticker .badge{font-size:0.62rem;font-weight:700;letter-spacing:0.05em;border:1px solid currentColor;border-radius:4px;padding:0 0.25rem;margin-right:0.4rem;white-space:nowrap}",
  ".live-ticker .sim{border-left:4px dashed var(--accent)}",
  ".live-ticker li:nth-child(1){opacity:1}.live-ticker li:nth-child(2){opacity:.95}.live-ticker li:nth-child(3){opacity:.9}.live-ticker li:nth-child(4){opacity:.85}.live-ticker li:nth-child(5){opacity:.8}.live-ticker li:nth-child(6){opacity:.75}.live-ticker li:nth-child(7){opacity:.7}.live-ticker li:nth-child(8){opacity:.65}.live-ticker li:nth-child(n+9){opacity:.55}",
  ".live-ticker time{font-variant-numeric:tabular-nums;color:var(--muted);margin-right:0.4rem;white-space:nowrap}",
  ".keycard.live-simcard{border-top-style:dashed}",
  ".live-nav{font-size:1rem;margin:0.5rem 0 0}",
  "@media (max-width:900px){.live-layout{grid-template-columns:1fr}}",
].join("\n");

export const LIVE_CSS_HASH = `sha256-${createHash("sha256")
  .update(DASHBOARD_CSS + "\n" + LIVE_CSS, "utf8")
  .digest("base64")}`;

const LIVE_STYLE_HTML = constantHtml("<style>" + DASHBOARD_CSS + "\n" + LIVE_CSS + "</style>");

function compactTime(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(iso)) {
    return iso;
  }
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function clockTime(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso) ? iso.slice(11, 19) : iso;
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

function cellText(cell: LiveCell): string {
  switch (cell.kind) {
    case "text": {
      return cell.text;
    }
    case "no-data": {
      return `no data (${cell.reason})`;
    }
    case "error": {
      return `error (${cell.code})`;
    }
  }
}

function cellClass(cell: LiveCell): string {
  return cell.kind === "text" ? "value" : cell.kind === "no-data" ? "nodata" : "error";
}

function renderCounter(counter: LiveCounter): SafeHtml {
  const label = counter.simulated ? `${counter.label} (simulated)` : counter.label;
  return html`<div class="keycard ${counter.simulated ? "live-simcard" : ""}">
    <span class="label">${label}</span>
    <span class="${cellClass(counter.cell)}">${cellText(counter.cell)}</span>
    <p class="cite">
      source: ${counter.simulated ? "simulated fleet trace" : "real factory inputs"}
    </p>
  </div>`;
}

function renderTile(tile: LiveTile): SafeHtml {
  if (!ALIAS_PATTERN.test(tile.alias)) {
    throw new Error("dashboard live: invalid host alias in model");
  }
  const load =
    tile.maxAgents === null
      ? `${String(tile.running)} running`
      : `(${String(tile.running)}/${String(tile.maxAgents)})`;
  const stateLine = tile.state === "running" ? `running ${load}` : `${tile.state} ${load}`;
  const battery = tile.batteryPercent === null ? "" : `, bat ${String(tile.batteryPercent)}%`;
  return html`<div
    class="live-tile tile-${tile.state} ${tile.simulated ? "tile-sim" : "tile-real"}"
    title="${tile.detail}"
  >
    <span class="tag">${tile.simulated ? "SIMULATED" : "REAL"}</span>
    <span class="alias">${tile.alias}</span>
    <div class="state">${stateLine}${battery}</div>
  </div>`;
}

function renderGroup(group: LiveGroup): SafeHtml {
  return html`<div class="live-group">
    <h3>${group.title}</h3>
    <div class="live-grid">${group.tiles.map((tile) => renderTile(tile))}</div>
  </div>`;
}

function sectionText<T>(section: LiveSection<T>): SafeHtml {
  if (section.kind === "no-data") {
    return html`<p class="nodata">no data (${section.reason})</p>`;
  }
  if (section.kind === "error") {
    return html`<p class="error">error (${section.code})</p>`;
  }
  return constantHtml("");
}

function renderActivityRow(row: LiveActivityRow): SafeHtml {
  const model = shortenMiddle(row.model, 30);
  const tokens = (value: number | null): string =>
    value === null ? "no data" : value.toLocaleString("en-US");
  return html`<tr>
    <td><time class="time" datetime="${row.at}" title="${row.at}">${clockTime(row.at)}</time></td>
    <td>
      ${
        model === row.model
          ? html`<span class="mono nowrap">${row.model}</span>`
          : html`<span class="mono nowrap" title="${row.model}">${model}</span>`
      }
    </td>
    <td>${row.role ?? "-"}</td>
    <td class="num">${tokens(row.inputTokens)}</td>
    <td class="num">${tokens(row.outputTokens)}</td>
    <td class="num">${row.ms.toLocaleString("en-US")}</td>
    <td class="${cellClass(row.cost)}">${cellText(row.cost)}</td>
  </tr>`;
}

function renderTickerRow(row: LiveTickerRow): SafeHtml {
  return html`<li class="${row.simulated ? "sim" : "real"}">
    <span class="badge">${row.simulated ? "SIM" : "REAL"}</span
    ><time datetime="${row.at}" title="${row.at}">${clockTime(row.at)}</time>${row.text}
  </li>`;
}

export function renderLive(model: LiveModel): string {
  const refresh =
    model.refreshSeconds !== null && model.nextMinute !== null
      ? constantHtml(
          `<meta http-equiv="refresh" content="${String(model.refreshSeconds)};url=/live?t=${String(model.nextMinute)}" />`,
        )
      : constantHtml("");
  const nextLink =
    model.nextMinute === null
      ? constantHtml("")
      : html`<a href="/live?t=${String(model.nextMinute)}">next frame</a> · `;
  const simClock =
    model.simAt === null
      ? "no simulated input"
      : `simulated evening ${compactTime(model.simAt)} (minute ${String(model.simMinute ?? 0)} of ${String(model.durationMinutes ?? 0)})`;
  const realFleet =
    model.realFleet.kind === "ok"
      ? renderGroup({ title: "Real fleet", tiles: model.realFleet.value })
      : sectionText(model.realFleet);
  const simFleet =
    model.simFleet.kind === "ok"
      ? model.simFleet.value.map((group) => renderGroup(group))
      : sectionText(model.simFleet);
  const activity =
    model.activity.kind === "ok"
      ? html`<div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>time</th>
                <th>model</th>
                <th>role</th>
                <th class="num">in</th>
                <th class="num">out</th>
                <th class="num">ms</th>
                <th>cost</th>
              </tr>
            </thead>
            <tbody>
              ${model.activity.value.map((row) => renderActivityRow(row))}
            </tbody>
          </table>
        </div>`
      : sectionText(model.activity);
  const tickerNote =
    model.tickerNote === null ? constantHtml("") : html`<p class="note">${model.tickerNote}</p>`;
  return (
    "<!doctype html>\n" +
    html`<html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        ${refresh}
        <title>Means of Compute - live</title>
        ${LIVE_STYLE_HTML}
      </head>
      <body>
        <header>
          <div class="live-head">
            <h1>Means of Compute - live</h1>
            <p class="live-clocks">
              real <strong>${compactTime(model.renderedAt)}</strong> · ${simClock}
            </p>
          </div>
          <p class="tagline">
            Real placement engine, synthetic fleet. The four real machines and the model calls are
            live.
          </p>
          <p class="live-nav">
            ${nextLink}<a href="/live">restart replay</a> · <a href="/">full dashboard</a>
          </p>
          <div class="keyfigures">${model.counters.map((counter) => renderCounter(counter))}</div>
        </header>
        <main>
          <div class="live-layout">
            <section id="live-fleet">
              <h2>Fleet</h2>
              ${realFleet} ${simFleet}
              <p class="live-legend">
                eligible: can take work now; running: simulated or real work on the host; blocked:
                idle but excluded (reason in the tile title); busy: user present; offline: left the
                site network. Dashed outline and the SIMULATED tag mark simulated hosts.
              </p>
              <p class="cite">
                source: real recorded probes and dispatcher registry; simulated fleet trace
                (sim-trace-v1)
              </p>
            </section>
            <div class="live-side">
              <section id="live-activity">
                <h2>Model activity (real)</h2>
                ${activity}
                <p class="cite">source: real meter call-end records from the meter usage log</p>
              </section>
              <section id="live-ticker">
                <h2>Events</h2>
                <ul class="live-ticker">
                  ${model.ticker.map((row) => renderTickerRow(row))}
                </ul>
                ${tickerNote}
                <p class="cite">
                  source: real loop results; simulated host and placement trace lines
                </p>
              </section>
            </div>
          </div>
        </main>
      </body>
    </html>`.value
  );
}

// Live view renderer. renderLive is pure: it turns the model of
// src/dashboard/live.ts into one HTML string. The style element is the
// dashboard stylesheet plus the live rules, hashed as LIVE_CSS_HASH for
// the CSP. Aliases are checked against the host-alias pattern; a failure
// throws without the value (a 500 in the server). There is no script:
// frames advance through a meta refresh and a plain next-frame link.
// The layout fits one 1920x1080 frame: real tiles stay large, simulated
// tiles are compact colour blocks whose state word and exclusion reason
// sit in the tile title, under a group heading that carries the
// SIMULATED tag.
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
} from "./live.js";

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const LIVE_CSS = [
  "body{padding:0.6rem 0.9rem 0.6rem;font-size:15px}",
  "h1{font-size:1.35rem}",
  ".tagline{font-size:0.92rem;margin:0.25rem 0 0}",
  ".live-head{display:flex;flex-wrap:wrap;gap:0.3rem 2rem;align-items:baseline}",
  ".live-clocks{font-variant-numeric:tabular-nums;color:var(--muted);font-size:0.95rem;margin:0}",
  ".live-clocks strong{color:var(--text)}",
  ".live-nav{font-size:0.9rem;margin:0.25rem 0 0}",
  ".keyfigures{grid-template-columns:repeat(6,1fr);gap:0.6rem;margin-top:0.6rem}",
  ".keycard{padding:0.35rem 0.55rem;border-radius:8px}",
  ".keycard .label{font-size:0.62rem}",
  ".keycard .value{font-size:1.15rem}",
  ".keycard .cite{font-size:0.62rem;margin:0.15rem 0 0}",
  ".keycard.live-simcard{border-top-style:dashed}",
  "section{padding:0.6rem 0.8rem 0.7rem;margin-top:0.7rem;border-radius:10px}",
  "h2{font-size:1.05rem;margin:0 0 0.4rem}",
  ".live-layout{display:grid;grid-template-columns:minmax(0,1.66fr) minmax(0,1fr);gap:0.8rem;align-items:start}",
  ".live-side{display:grid;gap:0.8rem}",
  ".live-side section{margin-top:0}",
  ".live-group h3{font-size:0.8rem;margin:0.28rem 0 0.15rem;color:var(--muted)}",
  ".live-group:first-child h3{margin-top:0}",
  ".live-group .simtag{font-size:0.58rem;font-weight:700;letter-spacing:0.05em;border:1px solid currentColor;border-radius:4px;padding:0 0.25rem;margin-left:0.4rem}",
  ".live-grid-real{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}",
  ".live-tile{border:1px solid var(--border);border-radius:8px;padding:0.32rem 0.45rem;min-height:2.7rem;background:var(--surface-2)}",
  ".live-tile .alias{font-family:var(--mono);font-size:0.8rem;font-weight:700;white-space:nowrap}",
  ".live-tile .tag{display:block;font-size:0.55rem;font-weight:700;letter-spacing:0.05em;margin-bottom:0.15rem}",
  ".live-tile .state{font-size:0.75rem}",
  ".live-grid-sim{display:grid;grid-template-columns:repeat(auto-fill,minmax(7.2rem,1fr));gap:3px}",
  ".group-desk .live-grid-sim{grid-template-columns:repeat(auto-fill,minmax(4.9rem,1fr))}",
  ".group-laptop .live-grid-sim{grid-template-columns:repeat(auto-fill,minmax(5.7rem,1fr))}",
  ".group-signage .live-grid-sim{grid-template-columns:repeat(auto-fill,minmax(9rem,1fr))}",
  ".tile-flagged{box-shadow:inset 3px 0 0 var(--parked-text)}",
  ".tile-flagged .alias{color:var(--parked-text)}",
  ".flag{color:var(--parked-text);font-weight:700}",
  ".sim-tile{display:flex;justify-content:space-between;align-items:baseline;gap:0.2rem;border:1px dashed;border-radius:4px;padding:0.08rem 0.22rem;line-height:1.2;overflow:hidden}",
  ".sim-tile .alias{font-family:var(--mono);font-size:0.58rem;font-weight:700;white-space:nowrap;overflow:hidden}",
  ".sim-tile .load{font-size:0.6rem;font-variant-numeric:tabular-nums}",
  ".tile-eligible{background:var(--done-bg);color:var(--done-text)}",
  ".tile-running{background:var(--running-bg);color:var(--running-text)}",
  ".tile-blocked{background:var(--parked-bg);color:var(--parked-text)}",
  ".tile-busy{background:var(--neutral-bg);color:var(--neutral-text)}",
  ".tile-offline{background:var(--surface);color:var(--muted)}",
  ".tile-reported{background:var(--neutral-bg);color:var(--neutral-text)}",
  ".tile-unavailable{background:var(--bad-bg);color:var(--bad-text)}",
  ".live-legend{font-size:0.72rem;color:var(--muted);margin:0.5rem 0 0}",
  ".dot{display:inline-block;width:0.6rem;height:0.6rem;border-radius:2px;margin:0 0.15rem 0 0.55rem;vertical-align:-1px}",
  ".live-activity-table{font-size:0.78rem}",
  ".live-activity-table td,.live-activity-table th{padding:0.2rem 0.35rem;white-space:nowrap}",
  ".live-ticker{list-style:none;margin:0;padding:0}",
  ".live-layout>*{min-width:0}",
  ".live-side{min-width:0}",
  ".live-side section{min-width:0;overflow:hidden}",
  ".live-activity-table{max-width:100%}",
  ".live-ticker{overflow:hidden}",
  ".live-ticker li{font-size:0.8rem;padding:0.25rem 0.4rem;border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".live-ticker .sim{border-left:4px dashed var(--accent)}",
  ".live-ticker time{font-variant-numeric:tabular-nums;color:var(--muted);margin-right:0.4rem;white-space:nowrap}",
  ".live-events h3{font-size:0.8rem;margin:0.5rem 0 0.25rem;color:var(--muted)}",
  ".live-events h3:first-child{margin-top:0}",
  "@media (max-width:900px){.live-layout{grid-template-columns:1fr}.keyfigures{grid-template-columns:repeat(2,1fr)}}",
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

function checkAlias(tile: LiveTile): void {
  if (!ALIAS_PATTERN.test(tile.alias)) {
    throw new Error("dashboard live: invalid host alias in model");
  }
}

function renderRealTile(tile: LiveTile): SafeHtml {
  checkAlias(tile);
  const load =
    tile.maxAgents === null
      ? `${String(tile.running)} running`
      : `(${String(tile.running)}/${String(tile.maxAgents)})`;
  const stateLine = tile.state === "running" ? `running ${load}` : `${tile.state} ${load}`;
  const battery = tile.batteryPercent === null ? "" : `, bat ${String(tile.batteryPercent)}%`;
  return html`<div class="live-tile tile-${tile.state}" title="${tile.detail}">
    <span class="tag">REAL</span>
    <span class="alias">${tile.alias}</span>
    <div class="state">${stateLine}${battery}</div>
  </div>`;
}

function renderSimTile(tile: LiveTile): SafeHtml {
  checkAlias(tile);
  const flagMark = tile.flagged ? html`<span class="flag">!</span>` : "";
  const load =
    tile.maxAgents === null
      ? String(tile.running)
      : `${String(tile.running)}/${String(tile.maxAgents)}`;
  const battery = tile.batteryPercent === null ? "" : `, battery ${String(tile.batteryPercent)}%`;
  const title =
    tile.detail === ""
      ? `${tile.alias}: ${tile.state}${battery}`
      : `${tile.alias}: ${tile.state} - ${tile.detail}${battery}`;
  return html`<div
    class="sim-tile tile-${tile.state}${tile.flagged ? " tile-flagged" : ""}"
    title="${title}"
  >
    <span class="load">${load}${flagMark}</span><span class="alias">${tile.alias}</span>
  </div>`;
}

function renderGroup(group: LiveGroup): SafeHtml {
  const simulated = group.tiles.length > 0 && (group.tiles[0]?.simulated ?? false);
  if (simulated) {
    const kind = group.tiles[0]?.hostKind ?? "";
    return html`<div class="live-group group-${kind}">
      <h3>${group.title}<span class="simtag">SIMULATED</span></h3>
      <div class="live-grid-sim">${group.tiles.map((tile) => renderSimTile(tile))}</div>
    </div>`;
  }
  return html`<div class="live-group">
    <h3>${group.title}</h3>
    <div class="live-grid-real">${group.tiles.map((tile) => renderRealTile(tile))}</div>
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
  const cost =
    row.cost.kind === "no-data"
      ? html`<td class="nodata" title="${row.cost.reason}">no data</td>`
      : html`<td class="${cellClass(row.cost)}">${cellText(row.cost)}</td>`;
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
    ${cost}
  </tr>`;
}

function renderTickerBlock(model: LiveModel, simulated: boolean): SafeHtml {
  const rows = model.ticker.filter((row) => row.simulated === simulated).slice(0, 6);
  const items = rows.map(
    (row) =>
      html`<li class="${row.simulated ? "sim" : "real"}" title="${row.text}">
        <time datetime="${row.at}" title="${row.at}">${clockTime(row.at)}</time>${row.text}
      </li>`,
  );
  return html`<h3>${simulated ? "Simulated events (sim clock)" : "Real events"}</h3>
    <ul class="live-ticker">
      ${items}
    </ul>`;
}

export function renderLive(model: LiveModel): string {
  const refresh =
    model.refreshSeconds === null || model.nextMinute === null
      ? constantHtml("")
      : html`<meta
          http-equiv="refresh"
          content="${model.refreshSeconds};url=/live?t=${model.nextMinute}"
        />`;
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
          <table class="live-activity-table">
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
            <p class="live-nav">
              ${nextLink}<a href="/live">restart replay</a> · <a href="/">full dashboard</a>
            </p>
          </div>
          <p class="tagline">
            Real placement engine, synthetic fleet. The four real machines and the model calls are
            live.
          </p>
          <div class="keyfigures">${model.counters.map((counter) => renderCounter(counter))}</div>
        </header>
        <main>
          <div class="live-layout">
            <section id="live-fleet">
              <h2>Fleet</h2>
              ${realFleet} ${simFleet}
              <p class="live-legend">
                <span class="dot tile-eligible"></span>eligible
                <span class="dot tile-running"></span>running
                <span class="dot tile-blocked"></span>blocked (reason in the tile title)
                <span class="dot tile-busy"></span>busy
                <span class="dot tile-offline"></span>offline · dashed outline and the SIMULATED
                group tag mark simulated hosts · amber edge with <span class="flag">!</span>:
                running, now excluded for a reason other than its agent limit (reason in the title)
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
              <section id="live-ticker" class="live-events">
                <h2>Events</h2>
                ${renderTickerBlock(model, false)} ${renderTickerBlock(model, true)} ${tickerNote}
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

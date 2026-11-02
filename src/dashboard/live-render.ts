// Live view renderer. renderLive is pure: it turns the model of
// src/dashboard/live.ts into one HTML string. The style element is the
// dashboard stylesheet plus the live rules, hashed as LIVE_CSS_HASH for
// the CSP. Aliases are checked against the host-alias pattern; a failure
// throws without the value (a 500 in the server). There is no script:
// frames advance through a meta refresh and a plain next-frame link.
// The layout fits one 1920x1080 frame: one tile design for real and
// simulated, compact, with real group first.
import { createHash } from "node:crypto";
import { constantHtml, html, SafeHtml } from "./html.js";
import { DASHBOARD_CSS } from "./render.js";
import type {
  HostPanel,
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
  "body{padding:0.15rem 0.5rem 0.1rem;font-size:12px;line-height:1.1}",
  "h1{font-size:0.9rem;margin:0}",
  ".tagline{font-size:0.6rem;margin:0.05rem 0 0}",
  ".tabs{display:flex;gap:0.25rem;flex-wrap:wrap;margin:0.2rem 0 0;padding-bottom:0.25rem;border-bottom:1px solid var(--border)}",
  ".tab{padding:0.14rem 0.4rem;border-radius:999px;font-size:0.68rem;font-weight:600;text-decoration:none;color:var(--muted);border:1px solid transparent;line-height:1}",
  ".tab.active{color:var(--text);background:var(--surface-2);border-color:var(--border)}",
  ".live-head{display:flex;flex-wrap:wrap;gap:0.15rem 0.8rem;align-items:baseline;margin-top:0.08rem}",
  ".live-clocks{font-variant-numeric:tabular-nums;color:var(--muted);font-size:0.6rem;margin:0}",
  ".live-clocks strong{color:var(--text)}",
  ".paused-badge{display:inline-block;margin-left:0.3rem;padding:0.05rem 0.25rem;border-radius:3px;background:var(--parked-bg);color:var(--parked-text);font-weight:700;font-size:0.62rem;border:1px solid var(--border)}",
  ".replay{font-size:0.6rem;margin:0.08rem 0 0;display:flex;flex-wrap:wrap;gap:0.15rem 0.4rem;align-items:center}",
  ".replay a{color:var(--accent);text-decoration:none}",
  ".replay a:hover{text-decoration:underline}",
  ".jumps{display:flex;gap:0.2rem;flex-wrap:wrap}",
  ".jumps a{padding:0.1rem 0.3rem;border:1px solid var(--border);border-radius:999px;font-size:0.62rem}",
  ".keyfigures{grid-template-columns:repeat(6,1fr);gap:0.2rem;margin-top:0.15rem}",
  ".keycard{padding:0.08rem 0.25rem;border-radius:4px}",
  ".keycard .label{font-size:0.45rem;line-height:1}",
  ".keycard .value{font-size:0.7rem;line-height:1}",
  ".keycard .cite{font-size:0.42rem;margin:0.02rem 0 0;line-height:1}",
  ".keycard.live-simcard{border-top-style:dashed}",
  "section{padding:0.2rem 0.3rem 0.2rem;margin-top:0.2rem;border-radius:4px}",
  "h2{font-size:0.7rem;margin:0 0 0.12rem}",
  ".live-layout{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(0,0.9fr);gap:0.3rem;align-items:start}",
  ".live-side{display:grid;gap:0.4rem}",
  ".live-side section{margin-top:0}",
  ".live-group h3{font-size:0.52rem;margin:0.08rem 0 0.04rem;color:var(--muted);line-height:1}",
  ".live-group:first-child h3{margin-top:0}",
  ".live-group .simtag{font-size:0.48rem;font-weight:700;letter-spacing:0.05em;border:1px solid currentColor;border-radius:3px;padding:0 0.2rem;margin-left:0.25rem}",
  ".tile-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(3.2rem,1fr));gap:1px}",
  ".tile{border-radius:2px;padding:0.05rem 0.12rem;min-height:1.15rem;background:var(--surface-2);display:flex;flex-direction:column;gap:0;justify-content:center;line-height:1}",
  ".tile-real{border:1px solid var(--border)}",
  ".tile-sim{border:1px dashed var(--border)}",
  ".tile .alias{font-family:var(--mono);font-size:0.48rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1}",
  ".tile .meta{font-size:0.44rem;display:flex;justify-content:space-between;align-items:baseline;gap:0.1rem;line-height:1;min-width:0;overflow:hidden}",
  ".tile .load{font-variant-numeric:tabular-nums;font-weight:600}",
  ".tile .state{font-size:0.42rem;text-transform:uppercase;letter-spacing:0.02em}",
  ".tile-flagged{box-shadow:inset 3px 0 0 var(--parked-text)}",
  ".tile-flagged .alias{color:var(--parked-text)}",
  ".flag{color:var(--parked-text);font-weight:700}",
  ".chip{font-size:0.42rem;font-weight:700;letter-spacing:0.05em;border:1px solid currentColor;border-radius:3px;padding:0 0.15rem}",
  ".chip-real{color:var(--accent)}",
  ".tile-eligible{background:var(--done-bg);color:var(--done-text)}",
  ".tile-running{background:var(--running-bg);color:var(--running-text)}",
  ".tile-blocked{background:var(--parked-bg);color:var(--parked-text)}",
  ".tile-busy{background:var(--neutral-bg);color:var(--neutral-text)}",
  ".tile-offline{background:var(--surface);color:var(--muted)}",
  ".tile-reported{background:var(--neutral-bg);color:var(--neutral-text)}",
  ".tile-unavailable{background:var(--bad-bg);color:var(--bad-text)}",
  ".live-legend{font-size:0.48rem;color:var(--muted);margin:0.08rem 0 0;line-height:1}",
  ".dot{display:inline-block;width:0.4rem;height:0.4rem;border-radius:1px;margin:0 0.1rem 0 0.3rem;vertical-align:-1px}",
  ".live-activity-table{font-size:0.55rem;line-height:1}",
  ".live-activity-table td,.live-activity-table th{padding:0.06rem 0.15rem;white-space:nowrap}",
  ".live-ticker{list-style:none;margin:0;padding:0}",
  ".live-layout>*{min-width:0}",
  ".live-side{min-width:0}",
  ".live-side section{min-width:0;overflow:hidden}",
  ".live-activity-table{max-width:100%}",
  ".live-ticker{overflow:hidden}",
  ".live-ticker li{font-size:0.55rem;padding:0.06rem 0.15rem;border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1}",
  ".live-ticker .sim{border-left:4px dashed var(--accent)}",
  ".live-ticker time{font-variant-numeric:tabular-nums;color:var(--muted);margin-right:0.4rem;white-space:nowrap}",
  ".live-events h3{font-size:0.62rem;margin:0.15rem 0 0.08rem;color:var(--muted)}",
  ".live-events h3:first-child{margin-top:0}",
  ".host-panel{border:1px solid var(--border);border-radius:10px;padding:0.6rem 0.8rem;background:var(--surface-2);margin-top:0.6rem}",
  ".host-panel h3{font-size:0.95rem;margin:0 0 0.4rem}",
  ".host-panel .row{font-size:0.82rem;margin:0.2rem 0;color:var(--muted)}",
  ".host-panel .mono{font-family:var(--mono)}",
  ".host-panel ul{margin:0.3rem 0 0;padding-left:1.2rem;font-size:0.8rem}",
  ".host-panel a{color:var(--accent);text-decoration:none}",
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

function buildHref(
  model: LiveModel,
  overrides: Partial<Record<string, string | number | null>>,
): string {
  const params = new URLSearchParams();
  const view = overrides["view"] !== undefined ? (overrides["view"] as string | null) : model.view;
  const tVal: number | null =
    overrides["t"] !== undefined ? (overrides["t"] as number | null) : model.t;
  const paused =
    overrides["paused"] !== undefined ? (overrides["paused"] as boolean | null) : model.paused;
  const host =
    overrides["host"] !== undefined
      ? (overrides["host"] as string | null)
      : (model.hostPanel?.alias ?? null);
  if (view !== null) {
    params.set("view", view);
  }
  if (tVal !== null && tVal !== 0) {
    params.set("t", String(tVal));
  }
  if (paused === true) {
    params.set("pause", "1");
  }
  if (host !== null) {
    params.set("host", host);
  }
  const qs = params.toString();
  return qs.length > 0 ? `/?${qs}` : "/";
}

function shortenAlias(alias: string): string {
  if (alias.length <= 9) {
    return alias;
  }
  return `${alias.slice(0, 3)}...${alias.slice(-3)}`;
}

function renderTile(tile: LiveTile, model: LiveModel): SafeHtml {
  checkAlias(tile);
  const href = buildHref(model, { host: tile.alias });
  const load =
    tile.maxAgents === null
      ? String(tile.running)
      : `${String(tile.running)}/${String(tile.maxAgents)}`;
  const battery = tile.batteryPercent === null ? "" : ` bat ${String(tile.batteryPercent)}%`;
  const displayAlias = shortenAlias(tile.alias);
  const title =
    tile.detail === ""
      ? `${tile.alias}: ${tile.state}${battery}`
      : `${tile.alias}: ${tile.state} - ${tile.detail}${battery}`;
  const chip = html`<span class="chip chip-real">REAL</span>`;
  const stateWord = tile.state;
  const flagMark = tile.flagged ? html`<span class="flag">!</span>` : constantHtml("");
  const tileClass = tile.simulated ? "tile-sim" : "tile-real";
  const secondLine = tile.simulated
    ? html`<span class="load">${load}${flagMark}</span><span class="state">${stateWord}</span>`
    : html`<span class="load">${load}${flagMark}</span>${chip}`;
  return html`<a
    href="${href}"
    class="tile ${tileClass} tile-${tile.state}${tile.flagged ? " tile-flagged" : ""}"
    title="${title}"
  >
    <span class="meta"><span class="alias">${displayAlias}</span></span>
    <span class="meta">${secondLine}</span>
  </a>`;
}

function renderGroup(group: LiveGroup, model: LiveModel): SafeHtml {
  const hasSim = group.tiles.some((t) => t.simulated);
  const heading = hasSim
    ? html`<h3>${group.title}<span class="simtag">SIMULATED</span></h3>`
    : html`<h3>${group.title}</h3>`;
  return html`<div class="live-group">
    ${heading}
    <div class="tile-grid">${group.tiles.map((tile) => renderTile(tile, model))}</div>
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
    <td>${row.providerId}</td>
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

function renderTabs(model: LiveModel): SafeHtml {
  const tabs = ["overview", "fleet", "work", "usage", "savings", "autonomy", "models"];
  const links = tabs.map((tab) => {
    const active = tab === model.view ? " active" : "";
    const aria = tab === model.view ? ' aria-current="page"' : "";
    // Tab links keep t and pause, drop selection.
    const params = new URLSearchParams();
    params.set("view", tab);
    if (model.t !== 0) {
      params.set("t", String(model.t));
    }
    if (model.paused) {
      params.set("pause", "1");
    }
    const href = `/?${params.toString()}`;
    return html`<a class="tab${active}" href="${href}" ${constantHtml(aria)}>${tab}</a>`;
  });
  return html`<nav class="tabs" aria-label="Views">${links}</nav>`;
}

function renderReplay(model: LiveModel): SafeHtml {
  const jumpMinutes = [0, 60, 120, 180, 240];
  const duration = model.durationMinutes ?? 240;
  const jumps = jumpMinutes
    .filter((m) => m <= duration)
    .map((m) => {
      const params = new URLSearchParams();
      params.set("view", model.view);
      params.set("t", String(m));
      if (model.paused) {
        params.set("pause", "1");
      }
      if (model.hostPanel !== null) {
        params.set("host", model.hostPanel.alias);
      }
      return html`<a href="/?${params.toString()}">${String(m)}</a>`;
    });
  // Helper for controls that preserve view/host.
  const ctrlHref = (t: number, paused: boolean | null): string => {
    const params = new URLSearchParams();
    params.set("view", model.view);
    if (t !== 0) {
      params.set("t", String(t));
    }
    if (paused === true) {
      params.set("pause", "1");
    } else if (paused === null) {
      if (model.paused) {
        params.set("pause", "1");
      }
    }
    if (model.hostPanel !== null) {
      params.set("host", model.hostPanel.alias);
    }
    const qs = params.toString();
    return qs.length > 0 ? `/?${qs}` : "/";
  };
  const pauseHref = ctrlHref(model.t, true);
  const resumeHref = ctrlHref(model.t, false);
  const restartHref = ctrlHref(0, model.paused ? true : null);
  const backHref = ctrlHref(Math.max(0, model.t - 5), model.paused ? true : null);
  const forwardHref = ctrlHref(Math.min(duration, model.t + 5), model.paused ? true : null);
  return html`<div class="replay">
    <span>Replay:</span>
    ${
      model.paused
        ? html`<a href="${resumeHref}">resume</a>`
        : html`<a href="${pauseHref}">pause</a>`
    }
    <a href="${restartHref}">restart</a>
    <a href="${backHref}">-5</a>
    <a href="${forwardHref}">+5</a>
    <span class="jumps">${jumps}</span>
  </div>`;
}

function renderHostPanel(panel: HostPanel, model: LiveModel): SafeHtml {
  const backHref = buildHref(model, { host: null });
  if (panel.kind === "sim") {
    const status = panel.eligible ? "eligible" : (panel.excludeReason ?? "excluded");
    const battery = panel.batteryPercent === null ? "" : `battery ${String(panel.batteryPercent)}%`;
    const task = panel.task === null ? "" : `${panel.task.kind}: ${panel.task.title}`;
    return html`<div class="host-panel" id="host-panel">
      <h3>${panel.alias} <span class="chip">SIMULATED</span></h3>
      <p class="row">Site: ${panel.site} · Kind: ${panel.hostKind}</p>
      <p class="row">State: ${panel.state} · ${status}</p>
      <p class="row">Running: ${String(panel.running)}/${String(panel.maxAgents)} ${battery}</p>
      ${task === "" ? constantHtml("") : html`<p class="row">Task: ${task}</p>`}
      <p class="row">Running tasks:</p>
      <ul>
        ${panel.runningTasks.map((t) => html`<li>${t.workItemId} at ${t.at}</li>`)}
      </ul>
      <p class="row">Events (up to 6):</p>
      <ul>
        ${panel.events.map((e) => html`<li>${e.text} at ${e.at}</li>`)}
      </ul>
      <p class="row">Placements (up to 6):</p>
      <ul>
        ${panel.placements.map((p) => html`<li>${p.workItemId} -> ${p.chosenHostAlias ?? "none"}: ${p.reason}</li>`)}
      </ul>
      <p><a href="${backHref}">back to live</a></p>
    </div>`;
  }
  const probeText =
    panel.probe === null
      ? "no probe"
      : panel.probe.kind === "reported"
        ? "reported"
        : `unavailable: ${panel.probe.cause ?? ""}`;
  return html`<div class="host-panel" id="host-panel">
    <h3>${panel.alias} <span class="chip chip-real">REAL</span></h3>
    <p class="row">Probe: ${probeText}</p>
    <p class="row">Running sessions: ${String(panel.running)}</p>
    <p class="row">Recent results:</p>
    <ul>
      ${panel.results.map((r) => html`<li>${r.workItemId} ${r.outcome} at ${r.at}</li>`)}
    </ul>
    <p class="row">Recent meter calls:</p>
    <ul>
      ${panel.meterCalls.map((c) => html`<li>${c.model} ${c.at}</li>`)}
    </ul>
    <p><a href="${backHref}">back to live</a></p>
  </div>`;
}

export function renderLive(model: LiveModel): string {
  const nextMinute = model.nextMinute;
  const refreshHref = (() => {
    if (model.paused || nextMinute === null) {
      return null;
    }
    const params = new URLSearchParams();
    params.set("view", model.view);
    params.set("t", String(nextMinute));
    if (model.hostPanel !== null) {
      params.set("host", model.hostPanel.alias);
    }
    return `/?${params.toString()}`;
  })();
  const refresh =
    refreshHref === null || model.refreshSeconds === null
      ? constantHtml("")
      : html`<meta
          http-equiv="refresh"
          content="${String(model.refreshSeconds)};url=${refreshHref}"
        />`;
  const simClock =
    model.simAt === null
      ? "no simulated input"
      : `simulated evening ${compactTime(model.simAt)} (minute ${String(model.simMinute ?? 0)} of ${String(model.durationMinutes ?? 0)})`;
  const pausedBadge = model.paused
    ? html`<span class="paused-badge">paused</span>`
    : constantHtml("");
  const realFleet =
    model.realFleet.kind === "ok"
      ? renderGroup({ title: "Real fleet", tiles: model.realFleet.value }, model)
      : sectionText(model.realFleet);
  const simFleet =
    model.simFleet.kind === "ok"
      ? model.simFleet.value.map((group) => renderGroup(group, model))
      : sectionText(model.simFleet);
  const activity =
    model.activity.kind === "ok"
      ? html`<div class="tablewrap">
          <table class="live-activity-table">
            <thead>
              <tr>
                <th>time</th>
                <th>model</th>
                <th>provider</th>
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
  const hostPanel =
    model.hostPanel === null ? constantHtml("") : renderHostPanel(model.hostPanel, model);
  const fleetContent = html`<h2>Fleet</h2>
    ${realFleet} ${simFleet}
    <p class="live-legend">
      <span class="dot tile-eligible"></span>eligible <span class="dot tile-running"></span>running
      <span class="dot tile-blocked"></span>blocked (reason in the title)
      <span class="dot tile-busy"></span>busy <span class="dot tile-offline"></span>offline · dashed
      outline and the SIMULATED group tag mark simulated hosts · amber edge with
      <span class="flag">!</span>: running, now excluded for a reason other than its agent limit
      (reason in the title)
    </p>
    <p class="cite">
      source: real recorded probes and dispatcher registry; simulated fleet trace (sim-trace-v1)
    </p>`;
  const sideContent =
    model.hostPanel === null
      ? html`<section id="live-activity">
            <h2>Model activity (real)</h2>
            ${activity}
            <p class="cite">source: real meter call-end records from the meter usage log</p>
          </section>
          <section id="live-ticker" class="live-events">
            <h2>Events</h2>
            ${renderTickerBlock(model, false)} ${renderTickerBlock(model, true)} ${tickerNote}
            <p class="cite">source: real loop results; simulated host and placement trace lines</p>
          </section>`
      : html`<nav class="breadcrumb">
            <a href="${buildHref(model, { host: null })}">Fleet</a> / ${model.hostPanel.alias}
            <a href="${buildHref(model, { host: null })}">back to live</a>
          </nav>
          ${hostPanel}`;
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
              real <strong>${compactTime(model.renderedAt)}</strong> · ${simClock}${pausedBadge}
            </p>
          </div>
          ${renderTabs(model)} ${renderReplay(model)}
          <p class="tagline">
            Real placement engine, synthetic fleet. The four real machines and the model calls are
            live.
          </p>
          <div class="keyfigures">${model.counters.map((counter) => renderCounter(counter))}</div>
        </header>
        <main>
          <div class="live-layout">
            <section id="live-fleet">${fleetContent}</section>
            <div class="live-side">${sideContent}</div>
          </div>
        </main>
      </body>
    </html>`.value
  );
}

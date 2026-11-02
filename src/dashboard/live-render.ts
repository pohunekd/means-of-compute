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
import { groupDigits } from "./money.js";
import { stripProvider } from "./live.js";
import { verdictCounts } from "../auditor/verdict.js";
import type {
  AuditPanel,
  CallPanel,
  HostPanel,
  JustFinishedEntry,
  LiveActivityRow,
  LiveCell,
  LiveCounter,
  LiveGroup,
  LiveModel,
  LiveSection,
  LiveTile,
  RealWorkCard,
  TaskPanel,
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
  ".tile .load{font-variant-numeric:tabular-nums;font-weight:600;flex:none;white-space:nowrap}",
  ".tile .state{font-size:0.42rem;text-transform:uppercase;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
  ".tile-flagged{box-shadow:inset 3px 0 0 var(--parked-text)}",
  ".tile-flagged .alias{color:var(--parked-text)}",
  ".flag{color:var(--parked-text);font-weight:700}",
  ".chip{font-size:0.42rem;font-weight:700;letter-spacing:0.05em;border:1px solid currentColor;border-radius:3px;padding:0 0.15rem;flex-shrink:0}",
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
  ".realwork{display:grid;grid-template-columns:repeat(4,1fr);gap:0.3rem;margin:0.2rem 0}",
  ".rw{background:var(--surface-2);border:1.5px solid var(--accent);border-radius:8px;padding:0.35rem 0.4rem}",
  ".rw.idle{border-color:var(--border)}",
  ".rw .al{font-family:var(--mono);font-size:0.66rem;font-weight:700}",
  ".rw .task{font-size:0.6rem;font-weight:600;margin:0.15rem 0 0.08rem;min-height:1.2rem;line-height:1.2;overflow:hidden}",
  ".rw .meta{font-size:0.52rem;color:var(--muted);margin:0.05rem 0;line-height:1.1}",
  ".rw .meta b{color:var(--text);font-weight:700}",
  ".stage{display:inline-block;border-radius:999px;padding:0.04rem 0.28rem;font-size:0.52rem;font-weight:700;background:var(--running-bg);color:var(--running-text);border:1px solid var(--border)}",
  ".stage.audit{background:var(--parked-bg);color:var(--parked-text)}",
  ".stage.merge{background:var(--done-bg);color:var(--done-text)}",
  ".fin{display:flex;gap:0.3rem;margin:0.15rem 0 0.2rem}",
  ".fin .fi{flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:0.18rem 0.32rem;font-size:0.54rem;line-height:1.2}",
  ".fin .fi b{font-size:0.56rem}",
  "@media (max-width:900px){.live-layout{grid-template-columns:1fr}.keyfigures{grid-template-columns:repeat(2,1fr)}.realwork{grid-template-columns:repeat(2,1fr)}.fin{flex-wrap:wrap}}",
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

type LiveHrefOverrides = Partial<Record<string, string | number | boolean | null>>;

function buildHref(model: LiveModel, overrides: LiveHrefOverrides): string {
  const params = new URLSearchParams();
  const view = overrides["view"] !== undefined ? (overrides["view"] as string | null) : model.view;
  const tVal: number | null =
    overrides["t"] !== undefined ? (overrides["t"] as number | null) : model.t;
  const paused =
    overrides["paused"] !== undefined ? (overrides["paused"] as boolean | null) : model.paused;
  let host: string | null = null;
  let task: string | null = null;
  let call: string | null = null;
  let audit: string | null = null;
  if (overrides["host"] !== undefined) {
    host = overrides["host"] as string | null;
  } else if (overrides["task"] !== undefined) {
    task = overrides["task"] as string | null;
  } else if (overrides["call"] !== undefined) {
    call = overrides["call"] as string | null;
  } else if (overrides["audit"] !== undefined) {
    audit = overrides["audit"] as string | null;
  } else {
    host = model.hostPanel?.alias ?? null;
    task = model.taskPanel?.workItemId ?? null;
    if (model.callPanel !== null) {
      call = `${model.callPanel.endedAt}|${model.callPanel.workItemId ?? ""}`;
      task = null;
    }
    if (model.auditPanel !== null) {
      audit = `${model.auditPanel.workItemId}@${model.auditPanel.headSha}`;
      task = null;
      call = null;
    }
    if (host !== null) {
      task = null;
      call = null;
      audit = null;
    } else if (task !== null) {
      call = null;
      audit = null;
    } else if (call !== null) {
      audit = null;
    }
  }
  if (overrides["host"] !== undefined) {
    task = null;
    call = null;
    audit = null;
  } else if (overrides["task"] !== undefined) {
    host = null;
    call = null;
    audit = null;
  } else if (overrides["call"] !== undefined) {
    host = null;
    task = null;
    audit = null;
  } else if (overrides["audit"] !== undefined) {
    host = null;
    task = null;
    call = null;
  }
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
  } else if (task !== null) {
    params.set("task", task);
  } else if (call !== null) {
    params.set("call", call);
  } else if (audit !== null) {
    params.set("audit", audit);
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
    tile.running === null
      ? "err"
      : tile.maxAgents === null
        ? String(tile.running)
        : `${String(tile.running)}/${String(tile.maxAgents)}`;
  const battery = tile.batteryPercent === null ? "" : ` bat ${String(tile.batteryPercent)}%`;
  const displayAlias = shortenAlias(tile.alias);
  const baseTitle =
    tile.detail === ""
      ? `${tile.alias}: ${tile.state}${battery}`
      : `${tile.alias}: ${tile.state} - ${tile.detail}${battery}`;
  const title =
    tile.runningError !== null ? `${baseTitle} - registry error (${tile.runningError})` : baseTitle;
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

function renderRealWorkCard(card: RealWorkCard, model: LiveModel): SafeHtml {
  if (!ALIAS_PATTERN.test(card.alias)) {
    throw new Error("dashboard live: invalid host alias in model");
  }
  const hostHref = buildHref(model, { host: card.alias });
  const taskHref = card.workItemId === null ? null : buildHref(model, { task: card.workItemId });
  const stageLabel = card.stage === "idle" ? (card.idleReason ?? "idle") : card.stage;
  const stageClass =
    card.stage === "implement"
      ? "stage"
      : card.stage === "audit"
        ? "stage audit"
        : card.stage === "merge"
          ? "stage merge"
          : "stage";
  const idleCls = card.stage === "idle" ? " idle" : "";
  const titleLine =
    card.title === null
      ? html`<p class="task"><span class="nodata">no work</span></p>`
      : taskHref === null
        ? html`<p class="task">${card.title}</p>`
        : html`<p class="task"><a href="${taskHref}">${card.title}</a></p>`;
  const issueLine =
    card.issue === null ? constantHtml("") : html`<span>#${String(card.issue)}</span>`;
  const prLine =
    card.pullNumber === null ? constantHtml("") : html`<span>PR #${String(card.pullNumber)}</span>`;
  const elapsedLine =
    card.elapsed === null
      ? constantHtml("")
      : html`<p class="meta">elapsed <b>${card.elapsed}</b></p>`;
  const tokensLine =
    card.tokens === null
      ? constantHtml("")
      : html`<p class="meta">
          tokens in ${groupDigits(card.tokens.input)} out ${groupDigits(card.tokens.output)}
        </p>`;
  const costLine =
    card.cost === null
      ? constantHtml("")
      : html`<p class="meta">
          cost <b class="${cellClass(card.cost)}">${cellText(card.cost)}</b>
        </p>`;
  const callLine =
    card.latestCall === null
      ? constantHtml("")
      : html`<p class="meta">
          last call ${clockTime(card.latestCall.at)} ${groupDigits(card.latestCall.ms)}ms
        </p>`;
  return html`<div class="rw${idleCls}">
    <div>
      <a class="al" href="${hostHref}">${card.alias}</a> <span class="chip chip-real">REAL</span>
      <span class="${stageClass}">${stageLabel}</span>
    </div>
    ${titleLine}
    <p class="meta">${issueLine} ${prLine}</p>
    ${elapsedLine} ${tokensLine} ${costLine} ${callLine}
  </div>`;
}

function renderJustFinished(entry: JustFinishedEntry, model: LiveModel): SafeHtml {
  const taskHref = buildHref(model, { task: entry.workItemId });
  const costText =
    entry.cost === null
      ? constantHtml("no cost")
      : html`<span class="${cellClass(entry.cost)}">${cellText(entry.cost)}</span>`;
  const title = entry.title ?? entry.workItemId;
  return html`<div class="fi">
    <a href="${taskHref}">${title}</a> ${entry.outcome} · ${costText} · ${clockTime(entry.at)}
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

function renderActivityRow(row: LiveActivityRow, liveModel: LiveModel): SafeHtml {
  const model = shortenMiddle(row.model, 30);
  const tokens = (value: number | null): string =>
    value === null ? "no data" : groupDigits(value);
  const cost =
    row.cost.kind === "no-data"
      ? html`<td class="nodata" title="${row.cost.reason}">no data</td>`
      : html`<td class="${cellClass(row.cost)}">${cellText(row.cost)}</td>`;
  const canLinkCall = row.workItemId !== null;
  const callKey = canLinkCall ? `${row.at}|${row.workItemId}` : "";
  const modelLink = canLinkCall
    ? html`<a
        href="${buildHref(liveModel, { call: callKey })}"
        class="mono nowrap"
        title="${row.model}"
        >${model === row.model ? row.model : model}</a
      >`
    : html`<span class="mono nowrap" title="${row.model}"
        >${model === row.model ? row.model : model}</span
      >`;
  const modelCell = html`<td>${modelLink}</td>`;
  return html`<tr>
    <td><time class="time" datetime="${row.at}" title="${row.at}">${clockTime(row.at)}</time></td>
    ${modelCell}
    <td>${row.providerId}</td>
    <td>${row.role ?? "-"}</td>
    <td class="num">${tokens(row.inputTokens)}</td>
    <td class="num">${tokens(row.outputTokens)}</td>
    <td class="num">${groupDigits(row.ms)}</td>
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
  const addSelection = (params: URLSearchParams): void => {
    if (model.hostPanel !== null) {
      params.set("host", model.hostPanel.alias);
    } else if (model.taskPanel !== null) {
      params.set("task", model.taskPanel.workItemId);
    } else if (model.callPanel !== null) {
      params.set("call", `${model.callPanel.endedAt}|${model.callPanel.workItemId ?? ""}`);
    } else if (model.auditPanel !== null) {
      params.set("audit", `${model.auditPanel.workItemId}@${model.auditPanel.headSha}`);
    }
  };
  const jumps = jumpMinutes
    .filter((m) => m <= duration)
    .map((m) => {
      const params = new URLSearchParams();
      params.set("view", model.view);
      params.set("t", String(m));
      if (model.paused) {
        params.set("pause", "1");
      }
      addSelection(params);
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
    addSelection(params);
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
    const battery = panel.batteryPercent === null ? "" : `battery ${String(panel.batteryPercent)}%`;
    const task = panel.task === null ? "" : `${panel.task.kind}: ${panel.task.title}`;
    const stateLine =
      !panel.eligible && panel.excludeReason !== null
        ? `State: ${panel.state} · ${panel.excludeReason}`
        : `State: ${panel.state}`;
    return html`<div class="host-panel" id="host-panel">
      <h3>${panel.alias} <span class="chip">SIMULATED</span></h3>
      <p class="row">Site: ${panel.site} · Kind: ${panel.hostKind}</p>
      <p class="row">${stateLine}</p>
      <p class="row">Running: ${String(panel.running)}/${String(panel.maxAgents)} ${battery}</p>
      ${task === "" ? constantHtml("") : html`<p class="row">Task: ${task}</p>`}
      <p class="row">Running tasks:</p>
      <ul>
        ${panel.runningTasks.map((t) => html`<li><a href="${buildHref(model, { task: t.workItemId })}">${t.workItemId}</a> at ${t.at}</li>`)}
      </ul>
      <p class="row">Events (up to 6):</p>
      <ul>
        ${panel.events.map((e) => html`<li>${e.text} at ${e.at}</li>`)}
      </ul>
      <p class="row">Placements (up to 6):</p>
      <ul>
        ${panel.placements.map((p) => html`<li><a href="${buildHref(model, { task: p.workItemId })}">${p.workItemId}</a> -> ${p.chosenHostAlias ?? "none"}: ${p.reason}</li>`)}
      </ul>
      <p><a href="${backHref}">back to live</a></p>
    </div>`;
  }
  // Probe block with time and cause
  const probeBlock =
    panel.probe.kind !== "ok"
      ? sectionText(panel.probe)
      : panel.probe.value === null
        ? html`<p class="row">Probe: no probe</p>`
        : html`<p class="row">
            Probe: ${panel.probe.value.kind} at
            ${panel.probe.value.at}${panel.probe.value.cause === null ? "" : ` cause ${panel.probe.value.cause}`}
          </p>`;
  // Registry block: open sessions with details
  const registryBlock =
    panel.registry.kind !== "ok"
      ? panel.registry.kind === "error"
        ? html`<p class="row">Open sessions:</p>
            <p class="error">error (${panel.registry.code})</p>`
        : html`<p class="row">Open sessions:</p>
            <p class="nodata">no data (${panel.registry.reason})</p>`
      : panel.registry.value.length === 0
        ? html`<p class="row">Open sessions: none</p>`
        : html`<div>
            <p class="row">Open sessions:</p>
            <ul>
              ${panel.registry.value.map(
                (s) =>
                  html`<li class="mono">
                    <a href="${buildHref(model, { task: s.workItemId })}">${s.workItemId}</a>
                    ${stripProvider(s.model.model)} (${s.model.providerId}) started ${s.startedAt}
                    lastSeen ${s.lastSeenAt}
                  </li>`,
              )}
            </ul>
          </div>`;
  const resultsBlock =
    panel.results.kind !== "ok"
      ? panel.results.kind === "error"
        ? html`<p class="row">Recent results:</p>
            <p class="error">error (${panel.results.code})</p>`
        : html`<p class="row">Recent results:</p>
            <p class="nodata">no data (${panel.results.reason})</p>`
      : html`<div>
          <p class="row">Recent results:</p>
          <ul>
            ${panel.results.value.map((r) =>
              r.known
                ? html`<li>
                    <a href="${buildHref(model, { task: r.workItemId })}">${r.workItemId}</a>
                    ${r.outcome} at ${r.at}
                  </li>`
                : html`<li>${r.workItemId} ${r.outcome} at ${r.at}</li>`,
            )}
          </ul>
        </div>`;
  const meterBlock =
    panel.meterCalls.kind !== "ok"
      ? panel.meterCalls.kind === "error"
        ? html`<p class="row">Recent meter calls:</p>
            <p class="error">error (${panel.meterCalls.code})</p>`
        : html`<p class="row">Recent meter calls:</p>
            <p class="nodata">no data (${panel.meterCalls.reason})</p>`
      : panel.meterCalls.value.length === 0
        ? html`<p class="row">Recent meter calls: none</p>`
        : html`<div>
            <p class="row">Recent meter calls:</p>
            <ul>
              ${panel.meterCalls.value.map((c) => {
                const canLink = c.workItemId !== null;
                return canLink
                  ? html`<li>
                      <a href="${buildHref(model, { call: `${c.at}|${c.workItemId}` })}"
                        >${c.model}</a
                      >
                      ${c.at}
                    </li>`
                  : html`<li>${c.model} ${c.at}</li>`;
              })}
            </ul>
          </div>`;
  return html`<div class="host-panel" id="host-panel">
    <h3>${panel.alias} <span class="chip chip-real">REAL</span></h3>
    ${probeBlock} ${registryBlock} ${resultsBlock} ${meterBlock}
    <p><a href="${backHref}">back to live</a></p>
  </div>`;
}

function renderTaskPanel(panel: TaskPanel, model: LiveModel): SafeHtml {
  const backHref = buildHref(model, { task: null });
  if (panel.kind === "sim") {
    const hostLink =
      panel.hostAlias === null
        ? "none"
        : html`<a href="${buildHref(model, { host: panel.hostAlias })}">${panel.hostAlias}</a>`;
    return html`<div class="host-panel" id="task-panel">
      <h3>${panel.workItemId} <span class="chip">SIMULATED</span></h3>
      <p class="row">Kind: ${panel.task.kind}</p>
      <p class="row">Title: ${panel.task.title}</p>
      <p class="row">Brief: ${panel.brief}</p>
      <p class="row">Placed at: ${panel.placedAt} on ${hostLink} because ${panel.reason}</p>
      <p class="row">Eligible count: ${String(panel.eligibleCount)}</p>
      <p class="row">
        Status: ${panel.status}${panel.endedAt === null ? "" : ` ended at ${panel.endedAt}`}
      </p>
      <p><a href="${backHref}">back to live</a></p>
    </div>`;
  }
  const goal =
    panel.workItem.kind === "ok"
      ? (() => {
          const full = panel.workItem.value.goal;
          const excerpt = full.length > 280 ? `${full.slice(0, 280)}…` : full;
          return html`<p class="row" title="${full}">Goal: ${excerpt}</p>`;
        })()
      : html`<p class="row">Goal:</p>
          <p class="${panel.workItem.kind}">
            ${panel.workItem.kind === "error" ? `error (${panel.workItem.code})` : `no data (${panel.workItem.reason})`}
          </p>`;
  const dodBlock =
    panel.dod.kind !== "ok"
      ? html`<p class="row">DoD:</p>
          <p class="${panel.dod.kind}">
            ${panel.dod.kind === "error" ? `error (${panel.dod.code})` : `no data (${panel.dod.reason})`}
          </p>`
      : html`<div>
          <p class="row">DoD:</p>
          <ul>
            ${panel.dod.value.map((d) => html`<li>${d.id}: ${d.text} ${d.done ? "done" : "pending"}</li>`)}
          </ul>
        </div>`;
  const roundsBlock =
    panel.rounds.kind !== "ok"
      ? html`<p class="row">Rounds:</p>
          <p class="${panel.rounds.kind}">
            ${panel.rounds.kind === "error" ? `error (${panel.rounds.code})` : `no data (${panel.rounds.reason})`}
          </p>`
      : html`<div>
          <p class="row">Rounds:</p>
          <ul>
            ${panel.rounds.value.map((r) => html`<li>${r.at} ${r.outcome} ${r.model} on ${r.hostAlias ?? "no host"}</li>`)}
          </ul>
        </div>`;
  const verdictsBlock =
    panel.verdicts.kind !== "ok"
      ? html`<p class="row">Verdicts:</p>
          <p class="${panel.verdicts.kind}">
            ${panel.verdicts.kind === "error" ? `error (${panel.verdicts.code})` : `no data (${panel.verdicts.reason})`}
          </p>`
      : html`<div>
          <p class="row">Verdicts:</p>
          <ul>
            ${panel.verdicts.value.map((v) => {
              const counted = verdictCounts(v);
              if (counted === "invalid") {
                return html`<li>
                  <a href="${buildHref(model, { audit: `${v.workItemId}@${v.headSha}` })}"
                    >${v.headSha.slice(0, 7)}: invalid (counts disagree)</a
                  >
                </li>`;
              }
              const t = `high ${String(counted.high)} medium ${String(counted.medium)} low ${String(counted.low)}`;
              return html`<li>
                <a href="${buildHref(model, { audit: `${v.workItemId}@${v.headSha}` })}"
                  >${v.headSha.slice(0, 7)} ${t}</a
                >
              </li>`;
            })}
          </ul>
        </div>`;
  const ledgerFailed =
    panel.ledger.kind === "error" ||
    panel.ledgerSessions.kind === "error" ||
    panel.ledgerMeta.kind === "error";
  const ledgerNoData =
    panel.ledger.kind === "no-data" ||
    panel.ledgerSessions.kind === "no-data" ||
    panel.ledgerMeta.kind === "no-data";
  const ledgerBlock = ledgerFailed
    ? (() => {
        const code =
          (panel.ledger.kind === "error" && panel.ledger.code) ||
          (panel.ledgerSessions.kind === "error" && panel.ledgerSessions.code) ||
          (panel.ledgerMeta.kind === "error" && panel.ledgerMeta.code) ||
          "unknown";
        return html`<p class="row">Ledger: error (${code})</p>`;
      })()
    : ledgerNoData
      ? (() => {
          const reason =
            (panel.ledger.kind === "no-data" && panel.ledger.reason) ||
            (panel.ledgerSessions.kind === "no-data" && panel.ledgerSessions.reason) ||
            (panel.ledgerMeta.kind === "no-data" && panel.ledgerMeta.reason) ||
            "unknown";
          return html`<p class="row">Ledger: no data (${reason})</p>`;
        })()
      : html`<div>
          <p class="row">Ledger tokens:</p>
          <ul>
            ${panel.ledger.value.map((t) => html`<li>${t.model} (${t.provider}) in ${t.inputTokens === null ? "no data" : groupDigits(t.inputTokens)} out ${t.outputTokens === null ? "no data" : groupDigits(t.outputTokens)} req ${t.requests === null ? "no data" : groupDigits(t.requests)} source ${t.source}</li>`)}
          </ul>
          <p class="row">Ledger sessions:</p>
          <ul>
            ${panel.ledgerSessions.value.map((s) => html`<li>${s.hostAlias} ${String(s.seconds)}s source ${s.source}</li>`)}
          </ul>
          ${
            panel.ledgerMeta.value === null
              ? html`<p class="row">Ledger meta: no data</p>`
              : html`<p class="row">
                  Ledger meta: ${panel.ledgerMeta.value.result} retries
                  ${String(panel.ledgerMeta.value.retries)} human
                  ${String(panel.ledgerMeta.value.humanInterventions)}
                </p>`
          }
        </div>`;
  const ledgerSessionsBlock = constantHtml("");
  const ledgerMetaBlock = constantHtml("");
  const title = panel.workItem.kind === "ok" ? panel.workItem.value.title : panel.workItemId;
  const statusLine =
    panel.workItem.kind === "ok"
      ? html`<p class="row">
          Status:
          ${panel.workItem.value.status}${panel.workItem.value.statusReason === null ? "" : ` (${panel.workItem.value.statusReason})`}
        </p>`
      : constantHtml("");
  const repoLine =
    panel.workItem.kind === "ok"
      ? html`<p class="row">Repo: ${panel.workItem.value.repo}</p>`
      : constantHtml("");
  const issueLine =
    panel.workItem.kind === "ok" && panel.workItem.value.issue !== null
      ? html`<p class="row">
          Issue:
          <a
            href="https://github.com/${panel.workItem.value.repo}/issues/${String(panel.workItem.value.issue)}"
            >#${String(panel.workItem.value.issue)}</a
          >
        </p>`
      : panel.workItem.kind === "ok" && panel.workItem.value.issue === null
        ? html`<p class="row">Issue: none</p>`
        : constantHtml("");
  const prLine =
    panel.workItem.kind === "ok" && panel.workItem.value.pullNumber !== null
      ? html`<p class="row">
          PR:
          <a
            href="https://github.com/${panel.workItem.value.repo}/pull/${String(panel.workItem.value.pullNumber)}"
            >#${String(panel.workItem.value.pullNumber)}</a
          >
        </p>`
      : panel.workItem.kind === "ok" && panel.workItem.value.pullNumber === null
        ? html`<p class="row">PR: none</p>`
        : constantHtml("");
  const branchLine =
    panel.workItem.kind === "ok"
      ? html`<p class="row">Branch: ${panel.workItem.value.branch ?? "none"}</p>`
      : constantHtml("");
  const assignedHostLine =
    panel.workItem.kind === "ok" && panel.workItem.value.assignedHostAlias !== null
      ? html`<p class="row">
          Host:
          <a href="${buildHref(model, { host: panel.workItem.value.assignedHostAlias })}"
            >${panel.workItem.value.assignedHostAlias}</a
          >
        </p>`
      : panel.workItem.kind === "ok"
        ? html`<p class="row">Host: none</p>`
        : constantHtml("");
  const modelLine =
    panel.workItem.kind === "ok"
      ? html`<p class="row">
          Model: ${stripProvider(panel.workItem.value.modelRouting.preferredModel)}
        </p>`
      : constantHtml("");
  const retryLine =
    panel.workItem.kind === "ok"
      ? html`<p class="row">Retries: ${String(panel.workItem.value.retryCount)}</p>`
      : constantHtml("");
  return html`<div class="host-panel" id="task-panel">
    <h3>${title} <span class="chip chip-real">REAL</span></h3>
    ${statusLine} ${repoLine} ${issueLine} ${prLine} ${branchLine} ${assignedHostLine} ${modelLine}
    ${retryLine} ${goal} ${dodBlock} ${roundsBlock} ${verdictsBlock} ${ledgerBlock}
    ${ledgerSessionsBlock} ${ledgerMetaBlock}
    <p><a href="${backHref}">back to live</a></p>
  </div>`;
}

function renderCallPanel(panel: CallPanel, model: LiveModel): SafeHtml {
  const backHref = buildHref(model, { call: null });
  if (panel.detail.kind !== "ok") {
    const err =
      panel.detail.kind === "error"
        ? html`<p class="error">error (${panel.detail.code})</p>`
        : html`<p class="nodata">no data (${panel.detail.reason})</p>`;
    return html`<div class="host-panel" id="call-panel">
      <h3>Call ${panel.endedAt}</h3>
      ${err}
      <p><a href="${backHref}">back to live</a></p>
    </div>`;
  }
  const detail = panel.detail.value;
  const costCell =
    detail.cost.kind === "no-data"
      ? html`<span class="nodata">no data (${detail.cost.reason})</span>`
      : detail.cost.kind === "error"
        ? html`<span class="error">error (${detail.cost.code})</span>`
        : html`<span class="value">${detail.cost.text}</span>`;
  const hostLink =
    detail.hostAlias === null
      ? "none"
      : html`<a href="${buildHref(model, { host: detail.hostAlias })}">${detail.hostAlias}</a>`;
  const taskLink =
    panel.workItemId === null
      ? "none"
      : html`<a href="${buildHref(model, { task: panel.workItemId })}">${panel.workItemId}</a>`;
  return html`<div class="host-panel" id="call-panel">
    <h3>Call ${panel.callId} <span class="chip chip-real">REAL</span></h3>
    <p class="row">Ended at: ${panel.endedAt}</p>
    <p class="row">Provider: ${detail.providerId}</p>
    <p class="row">Model: ${detail.model} (${detail.providerId})</p>
    <p class="row">Role: ${detail.role ?? "-"}</p>
    <p class="row">Task: ${taskLink}</p>
    <p class="row">Host: ${hostLink}</p>
    <p class="row">
      Tokens: in ${detail.inputTokens === null ? "no data" : groupDigits(detail.inputTokens)} out
      ${detail.outputTokens === null ? "no data" : groupDigits(detail.outputTokens)} ms
      ${groupDigits(detail.ms)}
    </p>
    <p class="row">Cost: ${costCell}</p>
    <p><a href="${backHref}">back to live</a></p>
  </div>`;
}

function renderAuditPanel(panel: AuditPanel, model: LiveModel): SafeHtml {
  const backHref = buildHref(model, { audit: null });
  const body =
    panel.verdict.kind !== "ok"
      ? html`<p class="row">
          ${panel.verdict.kind === "error" ? `error (${panel.verdict.code})` : `no data (${panel.verdict.reason})`}
        </p>`
      : (() => {
          const verdict = panel.verdict.value;
          const counted = verdictCounts(verdict);
          const c =
            counted === "invalid"
              ? "invalid (counts disagree)"
              : `high ${String(counted.high)} medium ${String(counted.medium)} low ${String(counted.low)}`;
          const countsLine = html`<p class="row">Counts: ${c}</p>`;
          const repoLine = html`<p class="row">Repo: ${verdict.repo}</p>`;
          const auditorLine = html`<p class="row">
            Auditor: ${stripProvider(verdict.auditorModel)}
          </p>`;
          const authorsLine = html`<p class="row">
            Authors: ${verdict.authorModels.map(stripProvider).join(", ") || "none"}
          </p>`;
          const prLine =
            verdict.pullNumber === null
              ? html`<p class="row">PR: none</p>`
              : panel.workItemRepo !== null && verdict.repo === panel.workItemRepo
                ? html`<p class="row">
                    PR:
                    <a href="https://github.com/${verdict.repo}/pull/${String(verdict.pullNumber)}"
                      >#${String(verdict.pullNumber)}</a
                    >
                  </p>`
                : panel.workItemRepo !== null
                  ? html`<p class="row">PR: #${String(verdict.pullNumber)} (repo differs)</p>`
                  : html`<p class="row">PR: #${String(verdict.pullNumber)}</p>`;
          return html`<div>
            <p class="row">Head: ${verdict.headSha}</p>
            ${countsLine} ${repoLine} ${auditorLine} ${authorsLine}
            <p class="row">Findings: ${String(verdict.findings.length)}</p>
            <ul>
              ${verdict.findings.map(
                (finding) =>
                  html`<li>
                    ${finding.severity} ${finding.location}: ${finding.defect} — ${finding.scenario}
                    -> ${finding.fixDirection}
                  </li>`,
              )}
            </ul>
            <p class="row">
              Task:
              <a href="${buildHref(model, { task: verdict.workItemId })}">${verdict.workItemId}</a>
            </p>
            ${prLine}
          </div>`;
        })();
  return html`<div class="host-panel" id="audit-panel">
    <h3>Audit ${panel.workItemId}@${panel.headSha.slice(0, 7)}</h3>
    ${body}
    <p><a href="${backHref}">back to live</a></p>
  </div>`;
}

function renderDetailBreadcrumb(model: LiveModel): SafeHtml {
  const fleetLink = html`<a href="${buildHref(model, { host: null })}">Fleet</a>`;
  if (model.hostPanel !== null) {
    return html`<nav class="breadcrumb">
      ${fleetLink} / ${model.hostPanel.alias}
      <a href="${buildHref(model, { host: null })}">back to live</a>
    </nav>`;
  }
  if (model.taskPanel !== null) {
    const hostPart =
      model.taskPanel.kind === "sim" && model.taskPanel.hostAlias !== null
        ? html` /
            <a href="${buildHref(model, { host: model.taskPanel.hostAlias })}"
              >${model.taskPanel.hostAlias}</a
            >`
        : constantHtml("");
    return html`<nav class="breadcrumb">
      ${fleetLink}${hostPart} / ${model.taskPanel.workItemId}
      <a href="${buildHref(model, { task: null })}">back to live</a>
    </nav>`;
  }
  if (model.callPanel !== null) {
    const taskPart =
      model.callPanel.workItemId !== null
        ? html` /
            <a href="${buildHref(model, { task: model.callPanel.workItemId })}"
              >${model.callPanel.workItemId}</a
            >`
        : constantHtml("");
    return html`<nav class="breadcrumb">
      ${fleetLink}${taskPart} / ${model.callPanel.callId}
      <a href="${buildHref(model, { call: null })}">back to live</a>
    </nav>`;
  }
  if (model.auditPanel !== null) {
    return html`<nav class="breadcrumb">
      ${fleetLink} / ${model.auditPanel.workItemId} / ${model.auditPanel.headSha.slice(0, 7)}
      <a href="${buildHref(model, { audit: null })}">back to live</a>
    </nav>`;
  }
  return constantHtml("");
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
    } else if (model.taskPanel !== null) {
      params.set("task", model.taskPanel.workItemId);
    } else if (model.callPanel !== null) {
      params.set("call", `${model.callPanel.endedAt}|${model.callPanel.workItemId ?? ""}`);
    } else if (model.auditPanel !== null) {
      params.set("audit", `${model.auditPanel.workItemId}@${model.auditPanel.headSha}`);
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
  const realWorkBlock = (() => {
    if (model.realWork.kind !== "ok") return sectionText(model.realWork);
    if (model.realWork.value.length === 0) return html`<p class="nodata">no real machines</p>`;
    return html`<div id="real-work" class="realwork">
      ${model.realWork.value.map((card) => renderRealWorkCard(card, model))}
    </div>`;
  })();
  const justFinishedBlock = (() => {
    if (model.justFinished.kind !== "ok") return sectionText(model.justFinished);
    if (model.justFinished.value.length === 0) return constantHtml("");
    return html`<div id="just-finished" class="fin">
      <div class="fi"><b>Just finished</b></div>
      ${model.justFinished.value.map((entry) => renderJustFinished(entry, model))}
    </div>`;
  })();
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
              ${model.activity.value.map((row) => renderActivityRow(row, model))}
            </tbody>
          </table>
        </div>`
      : sectionText(model.activity);
  const tickerNote =
    model.tickerNote === null ? constantHtml("") : html`<p class="note">${model.tickerNote}</p>`;
  const hostPanel =
    model.hostPanel === null ? constantHtml("") : renderHostPanel(model.hostPanel, model);
  const taskPanel =
    model.taskPanel === null ? constantHtml("") : renderTaskPanel(model.taskPanel, model);
  const callPanel =
    model.callPanel === null ? constantHtml("") : renderCallPanel(model.callPanel, model);
  const auditPanel =
    model.auditPanel === null ? constantHtml("") : renderAuditPanel(model.auditPanel, model);
  const detailPanel =
    model.hostPanel !== null
      ? hostPanel
      : model.taskPanel !== null
        ? taskPanel
        : model.callPanel !== null
          ? callPanel
          : auditPanel;
  const hasDetail =
    model.hostPanel !== null ||
    model.taskPanel !== null ||
    model.callPanel !== null ||
    model.auditPanel !== null;
  const fleetContent = html`<h2>Fleet</h2>
    ${simFleet}
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
  const sideContent = !hasDetail
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
    : html`${renderDetailBreadcrumb(model)} ${detailPanel}`;
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
        </header>
        <main>
          <section>
            <h2>
              Real work now
              <span style="color:var(--muted);font-weight:500;font-size:0.6rem"
                >· what the real machines are doing at this moment</span
              >
            </h2>
            ${realWorkBlock} ${justFinishedBlock}
          </section>
          <div class="live-layout">
            <section id="live-fleet">${fleetContent}</section>
            <div class="live-side">${sideContent}</div>
          </div>
        </main>
      </body>
    </html>`.value
  );
}

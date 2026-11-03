// Live tab renderer. renderLive is pure: it turns the model of
// src/dashboard/live.ts into one HTML string in the shared frame of
// render.ts (header, tab bar, cards, boxes, tables, chips; one stylesheet and
// one CSP hash). Aliases are checked against the host-alias pattern; a
// failure throws without the value (a 500 in the server). There is no
// script: frames advance through a meta refresh. The layout fits one
// 1920x1080 frame: Real work now, Just finished, then the compact simulated
// fleet beside the right rail, which holds a detail panel when one is open.
import { constantHtml, html, SafeHtml } from "./html.js";
import {
  modelLabel,
  renderFramedPage,
  type PageChrome,
  type Selection,
  type TabId,
} from "./render.js";
import { groupDigits } from "./money.js";
import { verdictCounts } from "../auditor/verdict.js";
import type {
  AuditPanel,
  CallPanel,
  HostPanel,
  LiveActivityRow,
  LiveFailure,
  LiveCell,
  LiveGroup,
  LiveModel,
  LiveSection,
  LiveTile,
  LiveTileState,
  RealWorkCard,
  TaskPanel,
} from "./live.js";

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// Rows the right rail shows so that it fits beside the fleet in the frame.
const RAIL_ROWS = {
  activity: 3,
  events: 3,
} as const;

// Tile states in legend and group-count order.
const STATE_ORDER = [
  "running",
  "eligible",
  "blocked",
  "busy",
  "offline",
  "reported",
  "unavailable",
] as const;

function clockTime(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso) ? iso.slice(11, 19) : iso;
}

function stripDate(iso: string, pageDay: string): string {
  const day = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day === pageDay) return clockTime(iso);
  return `${monthDay(iso)} ${clockTime(iso)}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function monthDay(iso: string): string {
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12)
    return iso.slice(0, 10);
  return `${MONTHS[month - 1] as string} ${String(day)}`;
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

function tileLoad(tile: LiveTile): string {
  return tile.running === null
    ? "err"
    : tile.maxAgents === null
      ? String(tile.running)
      : `${String(tile.running)}/${String(tile.maxAgents)}`;
}

// One line per tile: the full alias and the load; the state is the left
// border colour, the amber edge and `!` mark running-but-excluded.
function renderTile(tile: LiveTile, model: LiveModel): SafeHtml {
  checkAlias(tile);
  const href = buildHref(model, { host: tile.alias });
  const battery = tile.batteryPercent === null ? "" : ` bat ${String(tile.batteryPercent)}%`;
  const baseTitle =
    tile.detail === ""
      ? `${tile.alias}: ${tile.state}${battery}`
      : `${tile.alias}: ${tile.state}, ${tile.detail}${battery}`;
  const title =
    tile.runningError !== null ? `${baseTitle} - registry error (${tile.runningError})` : baseTitle;
  const flagMark = tile.flagged ? html`<span class="flag">!</span>` : constantHtml("");
  const chip = tile.simulated ? constantHtml("") : html`<span class="chip chip-real">REAL</span>`;
  const tileClass = tile.simulated ? "tile-sim" : "tile-real";
  const selected = model.hostPanel?.alias === tile.alias ? " selected" : "";
  return html`<a
    href="${href}"
    class="tile ${tileClass} tile-${tile.state}${tile.flagged ? " tile-flagged" : ""}${selected}"
    title="${title}"
    ><span class="alias">${tile.alias}</span
    ><span class="load">${tileLoad(tile)}${flagMark}</span>${chip}</a
  >`;
}

function stateCounts(tiles: readonly LiveTile[]): string {
  return STATE_ORDER.flatMap((state) => {
    const count = tiles.filter((tile) => tile.state === state).length;
    return count === 0 ? [] : [`${groupDigits(count)} ${state}`];
  }).join(" · ");
}

function renderGroup(group: LiveGroup, model: LiveModel): SafeHtml {
  const hasSim = group.tiles.some((t) => t.simulated);
  const tag = hasSim ? html`<span class="simtag">SIMULATED</span>` : constantHtml("");
  return html`<div class="live-group">
    <span class="ghead"
      ><b>${group.title}</b>${tag}<span class="gcount">${stateCounts(group.tiles)}</span></span
    >${group.tiles.map((tile) => renderTile(tile, model))}
  </div>`;
}

// A real card's state on the tile legend, read from the card's own fields
// (table in docs/dashboard.md): an open session is running; an idle card
// reads its probe-based idle reason; no recorded probe is offline.
const OFFLINE_CAUSES: ReadonlySet<string> = new Set([
  "host unreachable",
  "request timeout",
  "stale",
]);

function cardState(card: RealWorkCard): LiveTileState {
  if (card.stage !== "idle") {
    return "running";
  }
  const reason = card.idleReason;
  if (reason === null) {
    return "offline";
  }
  if (reason.startsWith("error (") || reason.startsWith("no data (")) {
    return "unavailable";
  }
  if (reason === "no work queued" || /^\d+ queued, not placed$/.test(reason)) {
    return "eligible";
  }
  if (reason.startsWith("person at the desk (")) {
    return "busy";
  }
  return OFFLINE_CAUSES.has(reason.split(" (")[0] ?? "") ? "offline" : "unavailable";
}

function renderRealWorkCard(card: RealWorkCard, model: LiveModel): SafeHtml {
  if (!ALIAS_PATTERN.test(card.alias)) {
    throw new Error("dashboard live: invalid host alias in model");
  }
  const hostHref = buildHref(model, { host: card.alias });
  const taskHref = card.workItemId === null ? null : buildHref(model, { task: card.workItemId });
  const repos = model.repos;
  const reposFailure = model.reposFailure;
  const repoAllowed = reposFailure === null && card.repo !== null && repos.has(card.repo);
  const stageLabel = "implement";
  const idleCls = card.stage === "idle" ? " idle" : "";
  const selected = model.hostPanel?.alias === card.alias ? " selected" : "";
  const stageHtml =
    card.stage === "idle"
      ? constantHtml("")
      : html`<span class="pill pill-running">${stageLabel}</span>`;
  const titleLine =
    card.stage === "idle"
      ? card.idleReason === null
        ? constantHtml("")
        : card.idleReason.startsWith("error (") || card.idleReason.startsWith("no data (")
          ? html`<p class="task idle-task">state: ${card.idleReason}</p>`
          : html`<p class="task idle-task">Idle: ${card.idleReason}</p>`
      : card.title === null
        ? html`<p class="task"><span class="nodata">no work</span></p>`
        : card.title.kind === "error"
          ? html`<p class="task"><span class="error">title: error (${card.title.code})</span></p>`
          : card.title.kind === "no-data"
            ? html`<p class="task">
                <span class="nodata">title: no data (${card.title.reason})</span>
              </p>`
            : taskHref === null
              ? html`<p class="task">${card.title.text}</p>`
              : html`<p class="task"><a href="${taskHref}">${card.title.text}</a></p>`;
  const issueLine =
    card.issue === null
      ? constantHtml("")
      : card.issue.kind === "error"
        ? html`<span class="error">issue: error (${card.issue.code})</span>`
        : card.issue.kind === "text"
          ? repoAllowed
            ? html`<a href="https://github.com/${card.repo}/issues/${card.issue.text}"
                >#${card.issue.text}</a
              >`
            : html`<span>#${card.issue.text}</span>`
          : card.issue.reason === "no issue linked"
            ? constantHtml("")
            : html`<span class="nodata">issue: no data (${card.issue.reason})</span>`;
  const prLine =
    card.pullNumber === null
      ? card.workItemId !== null && card.stage !== "idle"
        ? html`<span class="nodata">PR not opened yet</span>`
        : constantHtml("")
      : card.pullNumber.kind === "error"
        ? html`<span class="error">PR: error (${card.pullNumber.code})</span>`
        : card.pullNumber.kind === "no-data"
          ? html`<span class="nodata">PR: no data (${card.pullNumber.reason})</span>`
          : repoAllowed
            ? html`<a href="https://github.com/${card.repo}/pull/${card.pullNumber.text}"
                >PR #${card.pullNumber.text}</a
              >`
            : html`<span>PR #${card.pullNumber.text}</span>`;
  const elapsedLine =
    card.elapsed === null
      ? constantHtml("")
      : html`<p class="meta">elapsed <b>${card.elapsed}</b></p>`;
  const modelLine =
    card.modelText === null
      ? constantHtml("")
      : html`<p class="meta">${modelLabel(card.modelText, card.providerId)}</p>`;
  const tokensCostSoFar =
    card.meterFailure !== null
      ? card.meterFailure.kind === "error"
        ? html`<p class="meta">
            tokens: <span class="error">error (${card.meterFailure.code})</span> · cost:
            <span class="error">error (${card.meterFailure.code})</span>
          </p>`
        : html`<p class="meta">
            tokens:
            <span class="nodata">no data (${card.meterFailure.reason})</span> · cost:
            <span class="nodata">no data (${card.meterFailure.reason})</span>
          </p>`
      : card.tokens === null || card.cost === null
        ? constantHtml("")
        : html`<p class="meta">
            this task so far ${groupDigits(card.tokens.input)} in /
            ${groupDigits(card.tokens.output)} out tokens ·
            <b class="${cellClass(card.cost)}">${cellText(card.cost)}</b>
          </p>`;
  const callLine =
    card.meterFailure !== null
      ? card.meterFailure.kind === "error"
        ? html`<p class="meta">
            latest call: <span class="error">error (${card.meterFailure.code})</span>
          </p>`
        : html`<p class="meta">
            latest call:
            <span class="nodata">no data (${card.meterFailure.reason})</span>
          </p>`
      : card.latestCall === null
        ? constantHtml("")
        : card.latestCall.inputTokens === null || card.latestCall.outputTokens === null
          ? html`<p class="meta">
              latest call ${clockTime(card.latestCall.at)} ·
              <span class="nodata">no data (usage not reported)</span>
            </p>`
          : html`<p class="meta">
              latest call ${clockTime(card.latestCall.at)} ·
              ${groupDigits(card.latestCall.inputTokens)} in /
              ${groupDigits(card.latestCall.outputTokens)} out · ${groupDigits(card.latestCall.ms)}
              ms
            </p>`;
  const probeLine =
    card.stage !== "idle" || card.probeAt === null
      ? constantHtml("")
      : html`<p class="meta">reported ${clockTime(card.probeAt)}</p>`;
  const finishedDay = card.lastFinished === null ? null : card.lastFinished.at.slice(0, 10);
  const pageDay = model.renderedAt.slice(0, 10);
  const finishedWhen =
    card.lastFinished === null
      ? ""
      : finishedDay !== null && finishedDay !== pageDay
        ? `${monthDay(card.lastFinished.at)} ${clockTime(card.lastFinished.at)}`
        : clockTime(card.lastFinished.at);
  const lastRoundLine =
    card.lastFinishedNote === null
      ? constantHtml("")
      : html`<p class="meta">${card.lastFinishedNote}</p>`;
  const lastFinishedLine =
    card.lastFinished === null
      ? constantHtml("")
      : card.stage === "idle"
        ? html`<p class="meta">
            last finished
            <a href="${buildHref(model, { task: card.lastFinished.workItemId })}"
              >${card.lastFinished.workItemId}</a
            >
            at ${finishedWhen} (${card.lastFinished.outcome})
          </p>`
        : constantHtml("");
  const todayLine =
    card.today === null
      ? constantHtml("")
      : card.today.count === 0 && card.today.cost !== null
        ? html`<p class="meta">
            today (UTC):
            <span class="${cellClass(card.today.cost)}">${cellText(card.today.cost)}</span>
          </p>`
        : card.today.cost === null
          ? html`<p class="meta">
              today (UTC): ${String(card.today.count)} ${card.today.count === 1 ? "task" : "tasks"}
            </p>`
          : html`<p class="meta">
              today (UTC): ${String(card.today.count)} ${card.today.count === 1 ? "task" : "tasks"}
              ·
              <span class="${cellClass(card.today.cost)}">${cellText(card.today.cost)}</span>
            </p>`;
  return html`<div class="rw card${idleCls} tile-${cardState(card)}${selected}">
    <div>
      <a class="al" href="${hostHref}">${card.alias}</a> <span class="chip chip-real">REAL</span>
      ${stageHtml}
    </div>
    ${titleLine}
    ${
      reposFailure === null
        ? html`<p class="meta">${issueLine} ${prLine}</p>`
        : card.issue === null && card.pullNumber === null
          ? constantHtml("")
          : reposFailure.kind === "error"
            ? html`<p class="meta">
                links: <span class="error">error (${reposFailure.code})</span>
              </p>`
            : html`<p class="meta">
                links: <span class="nodata">no data (${reposFailure.reason})</span>
              </p>`
    }
    ${lastRoundLine} ${modelLine} ${elapsedLine} ${tokensCostSoFar} ${callLine} ${probeLine}
    ${lastFinishedLine} ${todayLine}
  </div>`;
}

function renderJustFinished(
  entry: {
    readonly workItemId: string;
    readonly title: LiveCell;
    readonly hostAlias: string | null;
    readonly verdictCounts:
      { readonly high: number; readonly medium: number; readonly low: number } | "invalid" | null;
    readonly verdictFailure: LiveFailure | null;
    readonly outcome: string;
    readonly cost: LiveCell | null;
    readonly at: string;
    readonly headSha: string | null;
  },
  model: LiveModel,
): SafeHtml {
  const taskHref = buildHref(model, { task: entry.workItemId });
  const auditHref =
    entry.headSha === null
      ? buildHref(model, { task: entry.workItemId })
      : buildHref(model, { audit: `${entry.workItemId}@${entry.headSha}` });
  const costText =
    entry.cost === null
      ? entry.verdictFailure === null
        ? constantHtml("no cost")
        : entry.verdictFailure.kind === "error"
          ? html`<span class="error">error (${entry.verdictFailure.code})</span>`
          : html`<span class="nodata">no data (${entry.verdictFailure.reason})</span>`
      : html`<span class="${cellClass(entry.cost)}">${cellText(entry.cost)}</span>`;
  // Every constantHtml argument stays a literal: dynamic strings run through html``.
  const titleText: SafeHtml =
    entry.title.kind === "text"
      ? html`${entry.title.text}`
      : entry.title.kind === "error"
        ? html`<span class="error">error (${entry.title.code})</span>`
        : html`<span class="nodata">no data (${entry.title.reason})</span>`;
  const counts = entry.verdictFailure !== null ? "failed" : entry.verdictCounts;
  const countsText: SafeHtml =
    counts === null
      ? constantHtml("no data (no verdict)")
      : counts === "failed"
        ? entry.verdictFailure !== null && entry.verdictFailure.kind === "error"
          ? html`<span class="error">counts: error (${entry.verdictFailure.code})</span>`
          : entry.verdictFailure !== null
            ? html`<span class="nodata">counts: no data (${entry.verdictFailure.reason})</span>`
            : constantHtml("no data (no verdict)")
        : counts === "invalid"
          ? html`<span class="error">invalid verdict counts</span>`
          : html`<a href="${auditHref}"
              >${String(counts.high)}/${String(counts.medium)}/${String(counts.low)}</a
            >`;
  const hostBadge = entry.hostAlias === null ? constantHtml("") : html` · ${entry.hostAlias}`;
  const pageDay = model.renderedAt.slice(0, 10);
  return html`<div class="fi">
    <a href="${taskHref}">${titleText}</a>${hostBadge} · ${entry.outcome} · ${countsText} ·
    ${costText} · ${stripDate(entry.at, pageDay)}
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
  const model = modelLabel(row.model, null);
  const tokens = (value: number | null): string =>
    value === null ? "no data" : groupDigits(value);
  const cost =
    row.cost.kind === "no-data"
      ? html`<td class="nodata" title="${row.cost.reason}">no data</td>`
      : html`<td class="${cellClass(row.cost)}">${cellText(row.cost)}</td>`;
  const canLinkCall = row.workItemId !== null;
  const callKey = canLinkCall ? `${row.at}|${row.workItemId}` : "";
  const modelLink = canLinkCall
    ? html`<a href="${buildHref(liveModel, { call: callKey })}" title="${row.model}"
        >${model === row.model ? row.model : model}</a
      >`
    : html`<span title="${row.model}">${model === row.model ? row.model : model}</span>`;
  const modelCell = html`<td class="modelcol">${modelLink}</td>`;
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
  const rows = model.ticker.filter((row) => row.simulated === simulated).slice(0, RAIL_ROWS.events);
  const items = rows.map(
    (row) =>
      html`<li class="${row.simulated ? "sim" : "real"}" title="${row.text}">
        <time datetime="${row.at}" title="${row.at}">${clockTime(row.at)}</time>${row.text}
      </li>`,
  );
  return html`<h3>${simulated ? "Simulated events (sim clock)" : "Real events"}</h3>
    <ul class="tick">
      ${items}
    </ul>`;
}

// Panel building blocks shared by the host panels: a labelled block, a table
// in the dashboard table style, and a time as HH:MM:SS UTC with the date only
// when it is not the page's UTC day.
function panelBlock(label: string, body: SafeHtml): SafeHtml {
  return html`<div class="pblock">
    <p class="plabel">${label}</p>
    ${body}
  </div>`;
}

function panelTable(heads: readonly string[], rows: readonly SafeHtml[]): SafeHtml {
  if (rows.length === 0) {
    return html`<p class="row">none</p>`;
  }
  return html`<table class="ptable">
    <thead>
      <tr>
        ${heads.map((head) => html`<th>${head}</th>`)}
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

function panelTime(iso: string, model: LiveModel): SafeHtml {
  return html`<time class="time" datetime="${iso}" title="${iso}"
    >${stripDate(iso, model.renderedAt.slice(0, 10))}</time
  >`;
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
    const running = panelTable(
      ["task", "since"],
      panel.runningTasks.map(
        (t) =>
          html`<tr>
            <td><a href="${buildHref(model, { task: t.workItemId })}">${t.workItemId}</a></td>
            <td>${panelTime(t.at, model)}</td>
          </tr>`,
      ),
    );
    const events = panelTable(
      ["time", "event"],
      panel.events.map(
        (e) =>
          html`<tr>
            <td>${panelTime(e.at, model)}</td>
            <td>${e.text}</td>
          </tr>`,
      ),
    );
    const placements = panelTable(
      ["time", "task", "placed on", "reason"],
      panel.placements.map(
        (p) =>
          html`<tr>
            <td>${panelTime(p.at, model)}</td>
            <td><a href="${buildHref(model, { task: p.workItemId })}">${p.workItemId}</a></td>
            <td>${p.chosenHostAlias ?? "none"}</td>
            <td>${p.reason}</td>
          </tr>`,
      ),
    );
    return html`<div class="panel" id="host-panel">
      <h3>${panel.alias} <span class="simtag">SIMULATED</span></h3>
      <p class="row">Site: ${panel.site} · Kind: ${panel.hostKind}</p>
      <p class="row">${stateLine}</p>
      <p class="row">Running: ${String(panel.running)}/${String(panel.maxAgents)} ${battery}</p>
      ${task === "" ? constantHtml("") : html`<p class="row">Task: ${task}</p>`}
      ${panelBlock("Running tasks", running)} ${panelBlock("Latest events (up to 6)", events)}
      ${panelBlock("Placements (up to 6)", placements)}
      <p><a href="${backHref}">back to live</a></p>
    </div>`;
  }
  const probeBlock =
    panel.probe.kind !== "ok"
      ? sectionText(panel.probe)
      : panel.probe.value === null
        ? html`<p class="row">no probe recorded</p>`
        : html`<p class="row">
            ${panel.probe.value.kind} at
            ${panelTime(panel.probe.value.at, model)}${
              panel.probe.value.cause === null ? "" : ` · cause ${panel.probe.value.cause}`
            }
          </p>`;
  const sessionsBlock =
    panel.registry.kind !== "ok"
      ? sectionText(panel.registry)
      : panelTable(
          ["task", "model", "started", "last seen"],
          panel.registry.value.map(
            (s) =>
              html`<tr>
                <td><a href="${buildHref(model, { task: s.workItemId })}">${s.workItemId}</a></td>
                <td>${modelLabel(s.model.model, s.model.providerId)}</td>
                <td>${panelTime(s.startedAt, model)}</td>
                <td>${panelTime(s.lastSeenAt, model)}</td>
              </tr>`,
          ),
        );
  const resultsBlock =
    panel.results.kind !== "ok"
      ? sectionText(panel.results)
      : panelTable(
          ["time", "task", "outcome"],
          panel.results.value.map(
            (r) =>
              html`<tr>
                <td>${panelTime(r.at, model)}</td>
                <td>
                  ${
                    r.known
                      ? html`<a href="${buildHref(model, { task: r.workItemId })}"
                          >${r.workItemId}</a
                        >`
                      : html`${r.workItemId}`
                  }
                </td>
                <td>${r.outcome}</td>
              </tr>`,
          ),
        );
  const meterBlock =
    panel.meterCalls.kind !== "ok"
      ? sectionText(panel.meterCalls)
      : panelTable(
          ["time", "model", "in", "out", "cost"],
          panel.meterCalls.value.map((c) => {
            const name =
              c.workItemId === null
                ? html`${modelLabel(c.model, c.providerId)}`
                : html`<a href="${buildHref(model, { call: `${c.at}|${c.workItemId}` })}"
                    >${modelLabel(c.model, c.providerId)}</a
                  >`;
            const tokens = (value: number | null): string =>
              value === null ? "no data" : groupDigits(value);
            return html`<tr>
              <td>${panelTime(c.at, model)}</td>
              <td>${name}</td>
              <td class="num">${tokens(c.inputTokens)}</td>
              <td class="num">${tokens(c.outputTokens)}</td>
              <td class="${cellClass(c.cost)}">${cellText(c.cost)}</td>
            </tr>`;
          }),
        );
  return html`<div class="panel" id="host-panel">
    <h3>${panel.alias} <span class="chip chip-real">REAL</span></h3>
    ${panelBlock("Probe", probeBlock)} ${panelBlock("Open sessions", sessionsBlock)}
    ${panelBlock("Recent results", resultsBlock)} ${panelBlock("Recent meter calls", meterBlock)}
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
    return html`<div class="panel" id="task-panel">
      <h3>${panel.workItemId} <span class="simtag">SIMULATED</span></h3>
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
            ${panel.rounds.value.map((r) => html`<li>${r.at} ${r.outcome} ${modelLabel(r.model, null)} on ${r.hostAlias ?? "no host"}</li>`)}
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
            ${panel.ledger.value.map((t) => html`<li>${modelLabel(t.model, t.provider)} in ${t.inputTokens === null ? "no data" : groupDigits(t.inputTokens)} out ${t.outputTokens === null ? "no data" : groupDigits(t.outputTokens)} req ${t.requests === null ? "no data" : groupDigits(t.requests)} source ${t.source}</li>`)}
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
          Model: ${modelLabel(panel.workItem.value.modelRouting.preferredModel, null)}
        </p>`
      : constantHtml("");
  const retryLine =
    panel.workItem.kind === "ok"
      ? html`<p class="row">Retries: ${String(panel.workItem.value.retryCount)}</p>`
      : constantHtml("");
  return html`<div class="panel" id="task-panel">
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
    return html`<div class="panel" id="call-panel">
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
  return html`<div class="panel" id="call-panel">
    <h3>Call ${panel.callId} <span class="chip chip-real">REAL</span></h3>
    <p class="row">Ended at: ${panel.endedAt}</p>
    <p class="row">Provider: ${detail.providerId}</p>
    <p class="row">Model: ${modelLabel(detail.model, detail.providerId)}</p>
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
            Auditor: ${modelLabel(verdict.auditorModel, null)}
          </p>`;
          const authorsLine = html`<p class="row">
            Authors: ${verdict.authorModels.map((m) => modelLabel(m, null)).join(", ") || "none"}
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
  return html`<div class="panel" id="audit-panel">
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

function selectionOf(model: LiveModel): Selection | null {
  if (model.hostPanel !== null) {
    return { key: "host", value: model.hostPanel.alias };
  }
  if (model.taskPanel !== null) {
    return { key: "task", value: model.taskPanel.workItemId };
  }
  if (model.callPanel !== null) {
    return { key: "call", value: `${model.callPanel.endedAt}|${model.callPanel.workItemId ?? ""}` };
  }
  if (model.auditPanel !== null) {
    return { key: "audit", value: `${model.auditPanel.workItemId}@${model.auditPanel.headSha}` };
  }
  return null;
}

// The shared page chrome at the live model's clocks. Only the Live tab carries
// the replay and keeps the open panel in its replay links.
export function chromeOf(model: LiveModel, view: TabId): PageChrome {
  return {
    view,
    liveAvailable: true,
    renderedAt: model.renderedAt,
    t: model.t,
    paused: model.paused,
    // Work, Models and Savings are real only: no simulated clock, no replay.
    replay:
      view === "live"
        ? {
            simAt: model.simAt,
            simMinute: model.simMinute,
            durationMinutes: model.durationMinutes,
            refreshSeconds: model.refreshSeconds,
            nextMinute: model.nextMinute,
          }
        : null,
    selection: view === "live" ? selectionOf(model) : null,
  };
}

function activityTable(model: LiveModel, limit: number): SafeHtml {
  if (model.activity.kind !== "ok") {
    return sectionText(model.activity);
  }
  const rows = model.activity.value.slice(0, limit);
  return html`<div class="tablewrap">
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
        ${rows.map((row) => renderActivityRow(row, model))}
      </tbody>
    </table>
  </div>`;
}

// Latest real meter calls, newest first, linked to the call panel; the
// Models tab shows them under its tables.
export function renderCallsSection(model: LiveModel, limit: number): SafeHtml {
  const total = model.activity.kind === "ok" ? model.activity.value.length : 0;
  const shown =
    model.activity.kind === "ok" && total > limit
      ? html`<p class="shown">showing ${String(limit)} of the newest ${String(total)} calls</p>`
      : constantHtml("");
  return html`<section id="latest-calls">
    <h2>Latest calls <span class="cnt">· real, newest first; click a call for its detail</span></h2>
    ${activityTable(model, limit)} ${shown}
    <p class="cite">source: real meter call-end records from the meter usage log</p>
  </section>`;
}

// One heading component for the real and the simulated fleet: the name, then
// its counts.
function fleetHeading(name: string, counts: string | null): SafeHtml {
  return counts === null
    ? html`<h2>${name}</h2>`
    : html`<h2>${name} <span class="cnt">· ${counts}</span></h2>`;
}

function realFleetHeading(model: LiveModel): SafeHtml {
  return fleetHeading(
    "Real fleet",
    model.realWork.kind === "ok"
      ? `${groupDigits(model.realWork.value.length)} machines, live`
      : null,
  );
}

function simFleetHeading(model: LiveModel): SafeHtml {
  const counters = model.simCounters;
  return fleetHeading(
    "Simulated fleet",
    counters === null
      ? null
      : `${groupDigits(counters.eligible)} of ${groupDigits(counters.hostCount)} eligible · ${groupDigits(counters.workRunning)} work running · ${groupDigits(counters.placements)} placements (simulated)`,
  );
}

export function renderLive(model: LiveModel): string {
  const realWorkBlock = (() => {
    if (model.realWork.kind !== "ok")
      return html`<div id="real-work">${sectionText(model.realWork)}</div>`;
    if (model.realWork.value.length === 0) return html`<p class="nodata">no real machines</p>`;
    return html`<div id="real-work" class="realwork">
      ${model.realWork.value.map((card) => renderRealWorkCard(card, model))}
    </div>`;
  })();
  const justFinishedBlock = (() => {
    if (model.justFinished.kind !== "ok") return sectionText(model.justFinished);
    if (model.justFinished.value.length === 0) return constantHtml("");
    return html`<div id="just-finished" class="fin">
      <div class="fi fin-label"><b>Just finished</b></div>
      ${model.justFinished.value.map((entry) => renderJustFinished(entry, model))}
    </div>`;
  })();
  const simFleet =
    model.simFleet.kind === "ok"
      ? html`<div class="groups">
          ${model.simFleet.value.map((group) => renderGroup(group, model))}
        </div>`
      : sectionText(model.simFleet);
  const tickerNote =
    model.tickerNote === null ? constantHtml("") : html`<p class="note">${model.tickerNote}</p>`;
  const detailPanel =
    model.hostPanel !== null
      ? renderHostPanel(model.hostPanel, model)
      : model.taskPanel !== null
        ? renderTaskPanel(model.taskPanel, model)
        : model.callPanel !== null
          ? renderCallPanel(model.callPanel, model)
          : model.auditPanel !== null
            ? renderAuditPanel(model.auditPanel, model)
            : null;
  const legend = html`<p class="legend">
    Tile colours: <span class="dot tile-running"></span>running
    <span class="dot tile-eligible"></span>eligible <span class="dot tile-blocked"></span>blocked
    <span class="dot tile-busy"></span>busy <span class="dot tile-offline"></span>offline
    <span class="dot tile-unavailable"></span>unavailable
    <span class="dot tile-flagged"></span>amber edge with <span class="flag">!</span>: running, now
    excluded for a reason other than its agent limit (reason in the title)
  </p>`;
  const rail =
    detailPanel === null
      ? html`<section id="live-activity">
            <h2>Model activity (real)</h2>
            ${activityTable(model, RAIL_ROWS.activity)}
            <p class="cite">source: real meter call-end records from the meter usage log</p>
          </section>
          <section id="live-ticker">
            <h2>Events</h2>
            ${renderTickerBlock(model, false)} ${renderTickerBlock(model, true)} ${tickerNote}
            <p class="cite">source: real loop results; simulated host and placement trace lines</p>
          </section>`
      : html`${renderDetailBreadcrumb(model)} ${detailPanel}`;
  const main = html`<div class="realnow">
      ${realFleetHeading(model)} ${realWorkBlock} ${justFinishedBlock}
    </div>
    <div class="live-layout">
      <section id="live-fleet">
        ${simFleetHeading(model)} ${simFleet} ${legend}
        <p class="cite">source: simulated fleet trace (sim-trace-v1)</p>
      </section>
      <div class="rail">${rail}</div>
    </div>`;
  return renderFramedPage(chromeOf(model, "live"), main);
}

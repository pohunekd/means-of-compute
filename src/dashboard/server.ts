// Dashboard HTTP server. One Bun.serve on the loopback listen address:
// GET / renders one of four tabs (Live, Work, Models, Cost; Live only when
// live sources are wired), the old view names and GET /live redirect, and
// everything else gets a plain error status. The first failing step answers
// (Host allowlist, method, path), and any throw while gathering, building or
// rendering becomes a 500 without details.
import { appendFile } from "node:fs/promises";
import type { DashboardConfig } from "./config.js";
import {
  gatherInputs,
  type DashboardSources,
  type FixedInputs,
  type InputErrorCode,
} from "./inputs.js";
import { buildDashboard, workRows } from "./model.js";
import { CSS_HASH, pageHref, renderTabPage, type PageChrome, type TabId } from "./render.js";
import { buildLive, gatherLiveInputs, type LiveInputCode, type LiveSources } from "./live.js";
import { chromeOf, renderCallsSection, renderLive } from "./live-render.js";

export type DashboardEventKind =
  "listening" | "request" | "input-error" | "render-error" | "stopped";

export interface DashboardLogEvent {
  readonly level: "info" | "warn" | "error";
  readonly event: DashboardEventKind;
  readonly alias?: string;
  readonly port?: number;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly ms?: number;
  readonly bytes?: number;
  readonly input?: string;
  readonly code?: InputErrorCode | LiveInputCode;
  readonly message?: string;
}

export interface DashboardDeps {
  readonly config: DashboardConfig;
  readonly listen: { readonly host: string; readonly port: number };
  readonly fixed: FixedInputs;
  readonly sources: DashboardSources;
  // Live view sources; without them /live is 404 like any other path.
  readonly live?: LiveSources | null;
  readonly now: () => Date;
  readonly log: (event: DashboardLogEvent) => void;
}

export interface DashboardServer {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src '${CSS_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
} as const;

const TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const TAB_IDS: ReadonlySet<string> = new Set<TabId>(["live", "work", "models", "cost"]);
// Old view names redirect to the tab that holds their content.
const LEGACY_VIEWS: ReadonlyMap<string, TabId> = new Map<string, TabId>([
  ["overview", "live"],
  ["fleet", "live"],
  ["autonomy", "work"],
  ["usage", "models"],
  ["savings", "cost"],
]);
const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TASK_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CALL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z\|[a-z0-9][a-z0-9-]{0,62}$/;
const AUDIT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}@[0-9a-f]{40}$/;
const GRAMMAR_KEYS = ["view", "t", "pause", "host", "task", "call", "audit"] as const;

function allowlist(host: string, port: number): Set<string> {
  if (host === "::1") {
    return new Set([`[::1]:${String(port)}`, `localhost:${String(port)}`]);
  }
  return new Set([`${host}:${String(port)}`, `localhost:${String(port)}`]);
}

function textResponse(status: number, body: string, allowGet = false): Response {
  const headers: Record<string, string> = { ...TEXT_HEADERS };
  if (allowGet) {
    headers["allow"] = "GET";
  }
  return new Response(body, { status, headers });
}

export function createLogAppender(logPath: string): (event: DashboardLogEvent) => void {
  let chain: Promise<void> = Promise.resolve();
  return (event: DashboardLogEvent): void => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    chain = chain
      .then(() => appendFile(logPath, line, "utf8"))
      .catch((error: unknown) => {
        const code =
          error instanceof Error && /^[A-Z0-9_]+$/.test((error as NodeJS.ErrnoException).code ?? "")
            ? ((error as NodeJS.ErrnoException).code as string)
            : "write failed";
        process.stderr.write(`factory: dashboard log write failed (${code})\n`);
      });
  };
}

export async function startDashboard(deps: DashboardDeps): Promise<DashboardServer> {
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: deps.listen.host,
      port: deps.listen.port,
      maxRequestBodySize: deps.config.maxRequestBytes,
      idleTimeout: deps.config.idleTimeoutSec,
      fetch: async (req: Request): Promise<Response> => {
        const started = Date.now();
        const rawHost = req.headers.get("host")?.toLowerCase() ?? "";
        const respond = async (response: Response, path: string): Promise<Response> => {
          const body = await response.text();
          deps.log({
            level: "info",
            event: "request",
            method: req.method,
            path: path.slice(0, 200),
            status: response.status,
            ms: Date.now() - started,
            bytes: Buffer.byteLength(body, "utf8"),
          });
          return new Response(body, { status: response.status, headers: response.headers });
        };
        // The Host check runs before any routing or URL parsing (1.4, 2.7):
        // a request without a Host header gets 421, never a 500.
        const boundPort = server.port ?? deps.listen.port;
        if (!allowlist(deps.listen.host, boundPort).has(rawHost)) {
          let pathname: string;
          try {
            pathname = new URL(req.url).pathname;
          } catch {
            // An unparseable URL must not log a real-looking path the
            // request never had (mutation: fixed / fallback path).
            pathname = "(unparsed)";
          }
          return await respond(textResponse(421, "misdirected request\n"), pathname);
        }
        const url = new URL(req.url);
        if (req.method !== "GET") {
          return await respond(textResponse(405, "method not allowed\n", true), url.pathname);
        }
        if (url.pathname !== "/" && url.pathname !== "/live") {
          return await respond(textResponse(404, "not found\n"), url.pathname);
        }
        // Repeated keys 404 for any grammar key.
        for (const k of GRAMMAR_KEYS) {
          if (url.searchParams.getAll(k).length > 1) {
            return await respond(textResponse(404, "not found\n"), url.pathname);
          }
        }
        const isLivePath = url.pathname === "/live";
        const isRootPath = url.pathname === "/";
        if (!isLivePath && !isRootPath) {
          return await respond(textResponse(404, "not found\n"), url.pathname);
        }
        const rawView = url.searchParams.get("view");
        const rawMinute = url.searchParams.get("t");
        const rawPause = url.searchParams.get("pause");
        const rawHostSel = url.searchParams.get("host");
        const rawTask = url.searchParams.get("task");
        const rawCall = url.searchParams.get("call");
        const rawAudit = url.searchParams.get("audit");

        // Validate view.
        if (rawView !== null && !TAB_IDS.has(rawView) && !LEGACY_VIEWS.has(rawView)) {
          return await respond(textResponse(404, "not found\n"), url.pathname);
        }
        // Validate t.
        let liveMinute = 0;
        if (rawMinute !== null) {
          if (!/^\d+$/.test(rawMinute)) {
            return await respond(textResponse(404, "not found\n"), url.pathname);
          }
          liveMinute = Number(rawMinute);
        }
        // Validate pause.
        if (rawPause !== null && rawPause !== "1") {
          return await respond(textResponse(404, "not found\n"), url.pathname);
        }
        const paused = rawPause === "1";
        // Validate selection patterns - every present selection validated, not just winner.
        if (rawHostSel !== null && !ALIAS_PATTERN.test(rawHostSel)) {
          return await respond(textResponse(404, "not found\n"), url.pathname);
        }
        if (rawTask !== null && !TASK_PATTERN.test(rawTask)) {
          return await respond(textResponse(404, "not found\n"), url.pathname);
        }
        if (rawCall !== null && !CALL_PATTERN.test(rawCall)) {
          return await respond(textResponse(404, "not found\n"), url.pathname);
        }
        if (rawAudit !== null && !AUDIT_PATTERN.test(rawAudit)) {
          return await respond(textResponse(404, "not found\n"), url.pathname);
        }
        // Selection precedence: host, task, call, audit - at most one honoured.
        let activeSelectionKey: "host" | "task" | "call" | "audit" | null = null;
        let activeSelectionValue: string | null = null;
        if (rawHostSel !== null) {
          activeSelectionKey = "host";
          activeSelectionValue = rawHostSel;
        } else if (rawTask !== null) {
          activeSelectionKey = "task";
          activeSelectionValue = rawTask;
        } else if (rawCall !== null) {
          activeSelectionKey = "call";
          activeSelectionValue = rawCall;
        } else if (rawAudit !== null) {
          activeSelectionKey = "audit";
          activeSelectionValue = rawAudit;
        }

        // Non-host selections are validated later against the built live model; malformed already 404ed above.

        const liveAvailable = deps.live != null && deps.live.simTracePath !== null;
        const legacyTarget = rawView === null ? undefined : LEGACY_VIEWS.get(rawView);
        if (isRootPath && legacyTarget !== undefined) {
          const target = legacyTarget === "live" && !liveAvailable ? "work" : legacyTarget;
          const headers: Record<string, string> = {
            ...TEXT_HEADERS,
            location: pageHref(target, liveMinute, paused, null),
          };
          return await respond(new Response("redirect\n", { status: 301, headers }), url.pathname);
        }
        const view: TabId = (rawView as TabId | null) ?? (liveAvailable ? "live" : "work");
        // Without live sources there is no Live tab.
        if (isRootPath && view === "live" && !liveAvailable) {
          return await respond(textResponse(404, "not found\n"), url.pathname);
        }

        try {
          const inputs = await gatherInputs(deps.sources, deps.fixed, deps.now(), (entry) => {
            deps.log({
              level: "error",
              event: "input-error",
              input: entry.input,
              code: entry.code,
              message: entry.message,
            });
          });
          const logInputError = (entry: {
            readonly input: string;
            readonly code: LiveInputCode;
            readonly message: string;
          }): void => {
            deps.log({
              level: "error",
              event: "input-error",
              input: entry.input,
              code: entry.code,
              message: entry.message,
            });
          };

          // Handle /live redirect with duration check.
          if (isLivePath) {
            if (liveAvailable) {
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
              const liveSources = deps.live as LiveSources;
              const liveInputs = await gatherLiveInputs(
                liveSources,
                inputs,
                liveMinute,
                logInputError,
              );
              if (liveInputs.sim.ok && liveMinute > liveInputs.sim.value.durationMinutes) {
                return await respond(textResponse(404, "not found\n"), url.pathname);
              }
            }
            const target = rawMinute === null ? "/" : `/?t=${rawMinute}`;
            const headers: Record<string, string> = { ...TEXT_HEADERS, location: target };
            return await respond(
              new Response("redirect\n", { status: 301, headers }),
              url.pathname,
            );
          }
          // Work, Models and Cost take no panel: a known host is accepted
          // and ignored, any other selection is 404.
          if (view !== "live" && activeSelectionValue !== null) {
            if (activeSelectionKey !== "host") {
              return await respond(textResponse(404, "not found\n"), url.pathname);
            }
            const known = new Set<string>();
            if (inputs.hosts.ok) {
              const hv = inputs.hosts.value;
              if (hv.kind === "recorded") {
                for (const p of hv.probes) known.add(p.hostAlias);
              } else {
                for (const o of hv.observations) known.add(o.hostAlias);
              }
            }
            if (!known.has(activeSelectionValue)) {
              return await respond(textResponse(404, "not found\n"), url.pathname);
            }
          }
          const knownWorkIds = inputs.workItems.ok
            ? new Set(inputs.workItems.value.map((w) => w.id))
            : new Set<string>();
          const workTotal = workRows(inputs).total;
          if (liveAvailable) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            const liveSources = deps.live as LiveSources;
            const liveInputs = await gatherLiveInputs(
              liveSources,
              inputs,
              liveMinute,
              logInputError,
            );
            if (liveInputs.sim.ok && liveMinute > liveInputs.sim.value.durationMinutes) {
              return await respond(textResponse(404, "not found\n"), url.pathname);
            }
            if (view !== "live") {
              const liveModel = buildLive(liveInputs, {
                view: "live",
                t: liveMinute,
                paused,
                host: null,
              });
              const page = renderTabPage(view, {
                model: buildDashboard(inputs),
                chrome: chromeOf(liveModel, view),
                knownWorkIds,
                workTotal,
                calls: view === "models" ? (limit) => renderCallsSection(liveModel, limit) : null,
              });
              return await respond(
                new Response(page, { status: 200, headers: { ...HTML_HEADERS } }),
                url.pathname,
              );
            }
            const liveModel = buildLive(liveInputs, {
              view: "live",
              t: liveMinute,
              paused,
              host: activeSelectionKey === "host" ? activeSelectionValue : null,
              task: activeSelectionKey === "task" ? activeSelectionValue : null,
              call: activeSelectionKey === "call" ? activeSelectionValue : null,
              audit: activeSelectionKey === "audit" ? activeSelectionValue : null,
            });
            if (activeSelectionKey !== null) {
              const found =
                (activeSelectionKey === "host" && liveModel.hostPanel !== null) ||
                (activeSelectionKey === "task" && liveModel.taskPanel !== null) ||
                (activeSelectionKey === "call" && liveModel.callPanel !== null) ||
                (activeSelectionKey === "audit" && liveModel.auditPanel !== null);
              if (!found) {
                return await respond(textResponse(404, "not found\n"), url.pathname);
              }
            }
            return await respond(
              new Response(renderLive(liveModel), { status: 200, headers: { ...HTML_HEADERS } }),
              url.pathname,
            );
          }
          if (view === "live") {
            return await respond(textResponse(404, "not found\n"), url.pathname);
          }
          const chrome: PageChrome = {
            view,
            liveAvailable: false,
            renderedAt: inputs.now.toISOString(),
            t: liveMinute,
            paused,
            replay: null,
            selection: null,
          };
          const page = renderTabPage(view, {
            model: buildDashboard(inputs),
            chrome,
            knownWorkIds,
            workTotal,
            calls: null,
          });
          return await respond(
            new Response(page, { status: 200, headers: { ...HTML_HEADERS } }),
            url.pathname,
          );
        } catch (error: unknown) {
          deps.log({
            level: "error",
            event: "render-error",
            message: error instanceof Error ? error.message : String(error),
          });
          return await respond(textResponse(500, "dashboard error\n"), url.pathname);
        }
      },
    });
  } catch (error: unknown) {
    const code =
      error instanceof Error && /^[A-Z0-9_]+$/.test((error as NodeJS.ErrnoException).code ?? "")
        ? ((error as NodeJS.ErrnoException).code as string)
        : "bind failed";
    const { DashboardConfigError } = await import("./config.js");
    throw new DashboardConfigError(`dashboard listener ${deps.config.listenAlias}: ${code}`);
  }
  const boundPort = server.port ?? deps.listen.port;
  deps.log({ level: "info", event: "listening", alias: deps.config.listenAlias, port: boundPort });
  return {
    port: boundPort,
    stop: async (): Promise<void> => {
      await server.stop(true);
      deps.log({ level: "info", event: "stopped" });
    },
  };
}

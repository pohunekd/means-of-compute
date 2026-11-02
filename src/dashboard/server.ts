// Dashboard HTTP server. One Bun.serve on the loopback listen address:
// GET / renders the dashboard and GET /live the live view when live sources
// are wired; everything else gets a plain error status. The first
// failing step answers (Host allowlist, method, path), and any throw while
// gathering, building or rendering becomes a 500 without details.
import { appendFile } from "node:fs/promises";
import type { DashboardConfig } from "./config.js";
import {
  gatherInputs,
  type DashboardSources,
  type FixedInputs,
  type InputErrorCode,
} from "./inputs.js";
import { buildDashboard } from "./model.js";
import { CSS_HASH, renderDashboard, renderDashboardWithView, TAB_CSS_HASH } from "./render.js";
import { buildLive, gatherLiveInputs, type LiveInputCode, type LiveSources } from "./live.js";
import { LIVE_CSS_HASH, renderLive } from "./live-render.js";

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

const TAB_HTML_HEADERS = {
  ...HTML_HEADERS,
  "content-security-policy": `default-src 'none'; style-src '${TAB_CSS_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
} as const;

const LIVE_HTML_HEADERS = {
  ...HTML_HEADERS,
  "content-security-policy": `default-src 'none'; style-src '${LIVE_CSS_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
} as const;

const TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const VIEW_IDS = new Set(["overview", "fleet", "work", "usage", "savings", "autonomy", "models"]);
const PANEL_VIEW_IDS = new Set(["work", "usage", "savings", "autonomy", "models"]);
const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TASK_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CALL_PATTERN = /^[^|]+\|[^|]+$/;
const AUDIT_PATTERN = /^[^@]+@[^@]+$/;
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
        if (rawView !== null && !VIEW_IDS.has(rawView)) {
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
        // Without live sources, overview is not available.
        if (!liveAvailable && rawView === "overview") {
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

          // Handle /live redirect with duration check.
          if (isLivePath) {
            if (liveAvailable) {
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
              const liveSources = deps.live as LiveSources;
              const liveInputs = await gatherLiveInputs(
                liveSources,
                inputs,
                liveMinute,
                (entry) => {
                  deps.log({
                    level: "error",
                    event: "input-error",
                    input: entry.input,
                    code: entry.code,
                    message: entry.message,
                  });
                },
              );
              if (liveInputs.sim.ok && liveMinute > liveInputs.sim.value.durationMinutes) {
                return await respond(textResponse(404, "not found\n"), url.pathname);
              }
            } else if (rawMinute !== null && !/^\d+$/.test(rawMinute)) {
              return await respond(textResponse(404, "not found\n"), url.pathname);
            }
            const target = rawMinute === null ? "/" : `/?t=${rawMinute}`;
            const headers: Record<string, string> = { ...TEXT_HEADERS, location: target };
            return await respond(
              new Response("redirect\n", { status: 301, headers }),
              url.pathname,
            );
          }
          if (liveAvailable) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            const liveSources = deps.live as LiveSources;
            const liveInputs = await gatherLiveInputs(liveSources, inputs, liveMinute, (entry) => {
              deps.log({
                level: "error",
                event: "input-error",
                input: entry.input,
                code: entry.code,
                message: entry.message,
              });
            });
            if (liveInputs.sim.ok && liveMinute > liveInputs.sim.value.durationMinutes) {
              return await respond(textResponse(404, "not found\n"), url.pathname);
            }

            const effectiveView = rawView ?? "overview";
            // Panel views render via dashboard model under same header/tab bar.
            if (PANEL_VIEW_IDS.has(effectiveView)) {
              if (activeSelectionValue !== null) {
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
              const dashboard = buildDashboard(inputs);
              const page = renderDashboardWithView(dashboard, {
                view: effectiveView,
                t: liveMinute,
                paused,
                host: activeSelectionValue,
                liveAvailable: true,
              });
              const response = new Response(page, {
                status: 200,
                headers: { ...TAB_HTML_HEADERS },
              });
              return await respond(response, url.pathname);
            }
            // Overview and fleet are live views.
            const liveModel = buildLive(liveInputs, {
              view: effectiveView as "overview" | "fleet",
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
            const livePage = renderLive(liveModel);
            const liveResponse = new Response(livePage, {
              status: 200,
              headers: { ...LIVE_HTML_HEADERS },
            });
            return await respond(liveResponse, url.pathname);
          }

          // No live sources.
          if (rawView !== null && VIEW_IDS.has(rawView)) {
            if (rawView === "fleet" || PANEL_VIEW_IDS.has(rawView)) {
              if (activeSelectionValue !== null) {
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
              const dashboard = buildDashboard(inputs);
              const page = renderDashboardWithView(dashboard, {
                view: rawView,
                t: liveMinute,
                paused,
                host: activeSelectionValue,
                liveAvailable: false,
              });
              const response = new Response(page, {
                status: 200,
                headers: { ...TAB_HTML_HEADERS },
              });
              return await respond(response, url.pathname);
            }
          }
          // Without view and without live, render as today (stacked, no tabs) to keep snapshot untouched.
          const page = renderDashboard(buildDashboard(inputs));
          const response = new Response(page, { status: 200, headers: { ...HTML_HEADERS } });
          return await respond(response, url.pathname);
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

// Dashboard HTTP server. One Bun.serve on the loopback listen address:
// only GET / renders; everything else gets a plain error status. The first
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
import { CSS_HASH, renderDashboard } from "./render.js";

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
  readonly code?: InputErrorCode;
  readonly message?: string;
}

export interface DashboardDeps {
  readonly config: DashboardConfig;
  readonly listen: { readonly host: string; readonly port: number };
  readonly fixed: FixedInputs;
  readonly sources: DashboardSources;
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
          return respond(textResponse(421, "misdirected request\n"), pathname);
        }
        const url = new URL(req.url);
        if (req.method !== "GET") {
          return respond(textResponse(405, "method not allowed\n", true), url.pathname);
        }
        if (url.pathname !== "/") {
          return respond(textResponse(404, "not found\n"), url.pathname);
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
          const page = renderDashboard(buildDashboard(inputs));
          const response = new Response(page, { status: 200, headers: { ...HTML_HEADERS } });
          return await respond(response, url.pathname);
        } catch (error: unknown) {
          deps.log({
            level: "error",
            event: "render-error",
            message: error instanceof Error ? error.message : String(error),
          });
          return respond(textResponse(500, "dashboard error\n"), url.pathname);
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

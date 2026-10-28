// Meter HTTP binding: one Bun listener with the configured body and idle
// limits. Logs name the listener only by alias, never by address.
import type { MeterConfig } from "./config.js";
import type { MeterLogEvent } from "./meter.js";
import { handleMeterRequest, type ProxyState } from "./proxy.js";

export interface MeterServer {
  readonly port: number;
  stop(closeActive: boolean): void;
}

export function serveMeter(
  config: MeterConfig,
  listen: { readonly host: string; readonly port: number },
  buildState: () => ProxyState,
  index: import("./usage-log.js").UsageIndex,
  log: (event: MeterLogEvent) => void,
): MeterServer {
  const server = Bun.serve({
    hostname: listen.host,
    port: listen.port,
    maxRequestBodySize: config.maxRequestBytes,
    idleTimeout: config.clientIdleTimeoutSec,
    fetch(req, srv) {
      const address = srv.requestIP(req)?.address ?? null;
      return handleMeterRequest(buildState(), req, srv, address, index);
    },
  });
  try {
    log({ level: "info", event: "listening", hostAlias: config.listenAlias });
  } catch (error: unknown) {
    server.stop(true);
    throw error;
  }
  return {
    port: server.port ?? 0,
    stop(closeActive: boolean): void {
      void server.stop(closeActive);
    },
  };
}

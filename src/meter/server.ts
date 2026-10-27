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
  buildState: (index: import("./usage-log.js").UsageIndex) => ProxyState,
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
      return handleMeterRequest(buildState(index), req, srv, address, index);
    },
  });
  log({ level: "info", event: "listening", hostAlias: config.listenAlias });
  return {
    port: server.port ?? 0,
    stop(closeActive: boolean) {
      server.stop(closeActive);
    },
  };
}

// Real production openers: the dependency set runProduction needs.
// Imported only in production mode, so the stub run never loads the SDK.
import { loadPohunekAdapterConfig } from "../dispatcher/adapter/config.js";
import { openPohunekPort } from "../dispatcher/adapter/pohunek-port.js";
import { openPohunekHostStatePort } from "../dispatcher/adapter/host-state-port.js";
import { resolveMeterEnv } from "../meter/config.js";
import { getProviders } from "../providers/config.js";
import { callProviderOnce } from "../providers/router.js";
import { createGhPort } from "./github.js";
import type { ProductionOpeners } from "./production.js";

export function productionOpeners(
  env: Readonly<Record<string, string | undefined>>,
): ProductionOpeners {
  return {
    env,
    loadAdapterConfig: (path) => loadPohunekAdapterConfig(path),
    openGitHub: createGhPort,
    resolveMeterEnv,
    loadProviders: getProviders,
    openPort: openPohunekPort,
    openHostState: openPohunekHostStatePort,
    auditCall: callProviderOnce,
  };
}

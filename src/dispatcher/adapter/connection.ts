// Per-alias client cache (design sections 2 and 7). The local daemon
// socket is resolved and verified once; every alias route resolves through
// it. Client instances are cached per alias and dropped on demand.
import {
  Client,
  ENV_XDG_RUNTIME_DIR,
  connectHost,
  currentRuntimePathContext,
  resolveDaemonSocket,
  resolveRuntimeDir,
  verifyDaemonRuntime,
} from "@pohunek/sdk";
import { PortRejectedError } from "../port.js";
import type { HostRoutes } from "./routes.js";

export interface HostConnector {
  aliases(): readonly string[];
  client(alias: string): Promise<Client>;
  drop(alias: string): Promise<void>;
  close(): Promise<void>;
}

export function createHostConnector(
  routes: HostRoutes,
  opts: { readonly connectTimeoutMs: number },
  env: Readonly<Record<string, string | undefined>>,
): HostConnector {
  const context = currentRuntimePathContext();
  const runtimeDir = resolveRuntimeDir(context, env);
  const socket = resolveDaemonSocket(context, env);
  verifyDaemonRuntime(runtimeDir, socket, context.effectiveUid, ENV_XDG_RUNTIME_DIR);
  const clients = new Map<string, Client>();
  const pending = new Map<string, Promise<Client>>();
  let closed = false;

  async function open(alias: string, route: string): Promise<Client> {
    const client = await connectHost(route, socket, {
      connectTimeoutMs: opts.connectTimeoutMs,
    });
    clients.set(alias, client);
    return client;
  }

  async function closeClient(client: Client): Promise<void> {
    try {
      await client.close();
    } catch {
      // Best effort: a broken connection must not block the drop.
    }
  }

  return {
    aliases(): readonly string[] {
      return [...routes.keys()];
    },

    async client(alias: string): Promise<Client> {
      if (closed) {
        throw new PortRejectedError("connector-closed");
      }
      const route = routes.get(alias);
      if (route === undefined) {
        throw new PortRejectedError("unknown-host-alias");
      }
      const cached = clients.get(alias);
      if (cached !== undefined) {
        return cached;
      }
      const inFlight = pending.get(alias);
      if (inFlight !== undefined) {
        return inFlight;
      }
      const opened = open(alias, route);
      pending.set(alias, opened);
      try {
        return await opened;
      } catch (error) {
        pending.delete(alias);
        throw error;
      }
    },

    async drop(alias: string): Promise<void> {
      pending.delete(alias);
      const cached = clients.get(alias);
      if (cached === undefined) {
        return;
      }
      clients.delete(alias);
      await closeClient(cached);
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      pending.clear();
      const cached = [...clients.values()];
      clients.clear();
      for (const client of cached) {
        await closeClient(client);
      }
    },
  };
}

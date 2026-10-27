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
import { PortRejectedError, PortUnreachableError } from "../port.js";
import type { HostRoutes } from "./routes.js";

export interface HostConnector {
  aliases(): readonly string[];
  client(alias: string): Promise<Client>;
  drop(alias: string): Promise<void>;
  close(): Promise<void>;
}

export type ConnectHostFn = typeof connectHost;

export interface HostConnectorOptions {
  readonly connectTimeoutMs: number;
  readonly connectHost?: ConnectHostFn;
}

export function createHostConnector(
  routes: HostRoutes,
  opts: HostConnectorOptions,
  env: Readonly<Record<string, string | undefined>>,
): HostConnector {
  const context = currentRuntimePathContext();
  const runtimeDir = resolveRuntimeDir(context, env);
  const socket = resolveDaemonSocket(context, env);
  verifyDaemonRuntime(runtimeDir, socket, context.effectiveUid, ENV_XDG_RUNTIME_DIR);
  const connect = opts.connectHost ?? connectHost;
  const clients = new Map<string, Client>();
  const pending = new Map<string, Promise<Client>>();
  const generations = new Map<string, number>();
  let closed = false;

  function generationOf(alias: string): number {
    return generations.get(alias) ?? 0;
  }

  function nextGeneration(alias: string): void {
    generations.set(alias, generationOf(alias) + 1);
  }

  async function open(alias: string, route: string, generation: number): Promise<Client> {
    const client = await connect(route, socket, {
      connectTimeoutMs: opts.connectTimeoutMs,
    });
    pending.delete(alias);
    if (closed) {
      await closeClient(client);
      throw new PortRejectedError("connector-closed");
    }
    if (generationOf(alias) !== generation) {
      await closeClient(client);
      throw unreachableFor(alias);
    }
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

  function unreachableFor(alias: string): PortUnreachableError {
    return new PortUnreachableError(`${alias}: host_unreachable`);
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
      const opened = open(alias, route, generationOf(alias));
      pending.set(alias, opened);
      return opened;
    },

    async drop(alias: string): Promise<void> {
      nextGeneration(alias);
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
      for (const alias of routes.keys()) {
        nextGeneration(alias);
      }
      pending.clear();
      const cached = [...clients.values()];
      clients.clear();
      for (const client of cached) {
        await closeClient(client);
      }
    },
  };
}

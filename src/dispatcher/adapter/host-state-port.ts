// Pohunek host-state port: reads plugin output through command.run and
// maps SDK errors through host-state-map. Mirrors createPohunekPort and
// openPohunekPort for construction and route loading.
import { MAX_COMMAND_OUTPUT_BYTES, MAX_COMMAND_TIMEOUT_MS, type Client } from "@pohunek/sdk";
import type { HostConnector } from "./connection.js";
import { createHostConnector } from "./connection.js";
import type { PohunekAdapterConfig } from "./config.js";
import { hostStateErrorOf, hostStateReplyOf } from "./host-state-map.js";
import { loadHostRoutes } from "./routes.js";
import type { HostStateLimits, HostStatePort, HostStateReply } from "../../hoststate/port.js";

export interface HostStatePortDeps {
  readonly connector: HostConnector;
  readonly command: string;
}

function isIntegerIn(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
}

async function dropBestEffort(connector: HostConnector, alias: string): Promise<void> {
  try {
    await connector.drop(alias);
  } catch {
    // Best effort: a broken connection must not hide the port error.
  }
}

interface HostStatePortInternals {
  readonly connector: HostConnector;
  readonly command: string;
  closed: boolean;
  closeDone: boolean;
}

async function readFrom(
  port: HostStatePortInternals,
  alias: string,
  packageId: string,
  limits: HostStateLimits,
): Promise<HostStateReply> {
  if (port.closed) {
    throw new Error("host state port is closed");
  }
  if (!port.connector.aliases().includes(alias)) {
    throw new Error(`unknown host alias ${alias}`);
  }
  if (
    !isIntegerIn(limits.pluginTimeoutMs, 1, MAX_COMMAND_TIMEOUT_MS) ||
    !isIntegerIn(limits.maxOutputBytes, 1, MAX_COMMAND_OUTPUT_BYTES)
  ) {
    throw new Error("host state limits outside the daemon ceilings");
  }
  let result;
  try {
    const client: Client = await port.connector.client(alias);
    result = await client.runCommand({
      package: packageId,
      command: port.command,
      timeout_ms: limits.pluginTimeoutMs,
      max_output_bytes: limits.maxOutputBytes,
    });
  } catch (error) {
    const mapped = hostStateErrorOf(error);
    if (mapped === null) {
      throw error;
    }
    if (mapped.failure === "host-unreachable" || mapped.failure === "request-timeout") {
      await dropBestEffort(port.connector, alias);
    }
    throw mapped;
  }
  return hostStateReplyOf(result);
}

async function closePort(port: HostStatePortInternals): Promise<void> {
  if (port.closeDone) {
    return;
  }
  port.closeDone = true;
  port.closed = true;
  await port.connector.close();
}

export function createPohunekHostStatePort(deps: HostStatePortDeps): HostStatePort {
  const port: HostStatePortInternals = {
    connector: deps.connector,
    command: deps.command,
    closed: false,
    closeDone: false,
  };
  return {
    hosts(): readonly string[] {
      return [...deps.connector.aliases()].sort();
    },
    read: (alias: string, packageId: string, limits: HostStateLimits) =>
      readFrom(port, alias, packageId, limits),
    close: () => closePort(port),
  };
}

export async function openPohunekHostStatePort(
  config: PohunekAdapterConfig,
  command: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<HostStatePort> {
  const routes = await loadHostRoutes(config.hostRoutesFileEnv, env);
  const connector = createHostConnector(routes, { connectTimeoutMs: config.connectTimeoutMs }, env);
  return createPohunekHostStatePort({ connector, command });
}

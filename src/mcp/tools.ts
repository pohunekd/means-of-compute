// PR 2 tool slice: P3 types, result helpers and the read-only
// fleet_status tool (R1 without the fleet field; PR 6 adds it).
import Ajv from "ajv/dist/2020";
import { loadDispatcherConfig } from "../dispatcher/config.js";
import { readRegistry } from "../dispatcher/registry.js";
import { loadWorkConfig } from "../work/config.js";
import { readWorkStore } from "../work/store.js";
import { createAuditResultsTool, createListWorkTool } from "./read-tools.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolError,
  ToolOutcome,
  ToolPayload,
} from "./protocol.js";

export type { ToolContext, ToolDefinition, ToolError, ToolOutcome, ToolPayload };

export interface ToolPaths {
  readonly workConfigPath: string;
  readonly dispatcherConfigPath: string;
  readonly auditorConfigPath?: string;
}

export function okPayload(fields: Record<string, unknown>): ToolPayload {
  return { ok: true, ...fields };
}

function errorPayloadWith(
  code: string,
  message: string,
  retryable: boolean,
  detail: Record<string, unknown>,
): ToolPayload {
  const error: ToolError = { code, message, retryable, ...detail };
  return { ok: false, error };
}

const ajv = new Ajv({ strict: true });

const FLEET_STATUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const fleetStatusValidate = ajv.compile(FLEET_STATUS_SCHEMA);

function validateFleetStatus(
  args: unknown,
): { readonly path: string; readonly keyword: string } | null {
  if (fleetStatusValidate(args)) {
    return null;
  }
  const first = fleetStatusValidate.errors?.[0];
  const path =
    first?.instancePath === "" || first?.instancePath === undefined ? "/" : first.instancePath;
  return { path, keyword: String(first?.keyword) };
}

export function unavailablePayload(source: string): ToolPayload {
  return errorPayloadWith("source-unreadable", `${source} unreadable`, false, {
    source,
  });
}

async function runFleetStatus(
  _args: unknown,
  _ctx: ToolContext,
  paths: ToolPaths,
): Promise<ToolOutcome> {
  let store;
  try {
    const workConfig = await loadWorkConfig(paths.workConfigPath);
    store = await readWorkStore(workConfig.storePath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      payload: unavailablePayload("work-store"),
      summary: null,
      detail,
    };
  }
  let registry;
  try {
    const dispatcherConfig = await loadDispatcherConfig(paths.dispatcherConfigPath);
    registry = await readRegistry(dispatcherConfig.registryPath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      payload: unavailablePayload("registry"),
      summary: null,
      detail,
    };
  }
  const counts: Record<string, number | undefined> = {
    queued: 0,
    running: 0,
    review: 0,
    parked: 0,
    blocked: 0,
    done: 0,
  };
  const runningByHost = new Map<string, number>();
  const openByHost = new Map<string, number>();
  for (const item of store.items) {
    const current: number | undefined = counts[item.status];
    if (current !== undefined) {
      counts[item.status] = current + 1;
    }
    const host = item.assignedHostAlias;
    if (item.status === "running" && host !== null) {
      runningByHost.set(host, (runningByHost.get(host) ?? 0) + 1);
    }
  }
  for (const entry of registry) {
    if (entry.terminal === null) {
      openByHost.set(entry.hostAlias, (openByHost.get(entry.hostAlias) ?? 0) + 1);
    }
  }
  const aliases = new Set<string>([...runningByHost.keys(), ...openByHost.keys()]);
  const hosts = [...aliases]
    .sort()
    .map((hostAlias) => ({
      hostAlias,
      runningItems: runningByHost.get(hostAlias) ?? 0,
      openSessions: openByHost.get(hostAlias) ?? 0,
    }))
    .filter((row) => row.runningItems > 0 || row.openSessions > 0);
  const items = store.items.length;
  return {
    payload: okPayload({
      work: { revision: store.revision, counts },
      hosts,
      hostState: {
        available: false,
        reason: "no host-state source in the MCP server (#42 PR 3)",
      },
    }),
    summary: { items, hosts: hosts.length },
    detail: null,
  };
}

export function createFleetStatusTool(paths: ToolPaths): ToolDefinition {
  return {
    name: "fleet_status",
    title: "Fleet status",
    toolClass: "read",
    description: "[read] Reports work store counts and open dispatcher sessions.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    validate: validateFleetStatus,
    run: (args, ctx) => runFleetStatus(args, ctx, paths),
  };
}

export function createTools(paths: ToolPaths): readonly ToolDefinition[] {
  return [createFleetStatusTool(paths), createListWorkTool(paths), createAuditResultsTool(paths)];
}

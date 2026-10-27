import { readInputText, statInputPath } from "../fs/input.js";
import { providerDescriptorErrors } from "./schema.js";
import type { ProviderDescriptor } from "./types.js";

type RawProvider = ProviderDescriptor & { baseUrlEnv?: string };

const ROUTE_PATH = "config/providers/route.json";
const DESCRIPTOR_DIR = "config/providers";
const MAX_TIMEOUT_MS = 600000;
const TIMEOUT_PATTERN = /^[1-9][0-9]*$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;

// Route ids come from the route file: descriptors are loaded by id, so any
// other file in the descriptor directory is ignored and a stale copy of a
// descriptor has no effect.
async function readRouteIds(routePath: string): Promise<string[]> {
  const label = "Provider route";
  if ((await statInputPath(label, routePath)) === "absent") {
    throw new Error(`${label} ${routePath}: file is missing`);
  }
  const text = await readInputText(label, routePath);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} ${routePath}: not valid JSON`, { cause: error });
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as { providers?: unknown }).providers)
  ) {
    throw new Error(`${label} ${routePath}: needs a string array "providers"`);
  }
  const ids: string[] = [];
  for (const entry of (raw as { providers: unknown[] }).providers) {
    if (typeof entry !== "string") {
      throw new Error(`${label} ${routePath}: needs a string array "providers"`);
    }
    if (!ids.includes(entry)) {
      ids.push(entry);
    }
  }
  return ids;
}

function baseUrlOverrideEnv(id: string): string {
  return `PROVIDER_${id.toUpperCase().replace(/-/g, "_")}_BASE_URL`;
}

function timeoutOverrideEnv(id: string): string {
  return `PROVIDER_${id.toUpperCase().replace(/-/g, "_")}_TIMEOUT_MS`;
}

async function loadDescriptor(id: string): Promise<ProviderDescriptor> {
  const label = "Provider descriptor";
  const file = `${DESCRIPTOR_DIR}/${id}.json`;
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(`${label} ${file}: invalid provider id "${id}"`);
  }
  if ((await statInputPath(label, file)) === "absent") {
    throw new Error(`${label} ${file}: file is missing`);
  }
  const text = await readInputText(label, file);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} ${file}: not valid JSON`, { cause: error });
  }
  const errors = providerDescriptorErrors(raw);
  if (errors !== null) {
    throw new Error(`${label} ${file}: ${errors}`);
  }
  const descriptor = raw as RawProvider;
  if (descriptor.id !== id) {
    throw new Error(`${label} ${file}: id "${descriptor.id}" does not match file name`);
  }

  let baseUrl = descriptor.baseUrl;
  if (descriptor.baseUrlEnv) {
    const envVal = process.env[descriptor.baseUrlEnv];
    if (!envVal) {
      throw new Error(
        `Missing required environment variable ${descriptor.baseUrlEnv} for provider ${id}`,
      );
    }
    baseUrl = envVal;
  }
  const baseUrlOverride = process.env[baseUrlOverrideEnv(id)];
  if (baseUrlOverride) {
    baseUrl = baseUrlOverride;
  }

  let timeoutMs = descriptor.timeoutMs;
  const timeoutEnv = timeoutOverrideEnv(id);
  const timeoutRaw = process.env[timeoutEnv];
  if (timeoutRaw !== undefined && timeoutRaw !== "") {
    if (!TIMEOUT_PATTERN.test(timeoutRaw) || Number(timeoutRaw) > MAX_TIMEOUT_MS) {
      throw new Error(`Provider ${id}: ${timeoutEnv} must be an integer in 1..600000`);
    }
    timeoutMs = Number(timeoutRaw);
  }

  if (descriptor.apiKeyEnv) {
    const key = process.env[descriptor.apiKeyEnv];
    if (!key) {
      throw new Error(
        `Missing required environment variable ${descriptor.apiKeyEnv} for provider ${id}`,
      );
    }
  }

  const resolved: ProviderDescriptor = {
    id: descriptor.id,
    name: descriptor.name,
    baseUrl,
    model: descriptor.model,
    timeoutMs,
    ...(descriptor.apiKeyEnv === undefined ? {} : { apiKeyEnv: descriptor.apiKeyEnv }),
    ...(descriptor.pricing === undefined ? {} : { pricing: descriptor.pricing }),
    ...(descriptor.rateLimit === undefined ? {} : { rateLimit: descriptor.rateLimit }),
  };
  return resolved;
}

async function loadProviders(): Promise<Record<string, ProviderDescriptor>> {
  const ids = await readRouteIds(ROUTE_PATH);
  const providers: Record<string, ProviderDescriptor> = {};
  for (const id of ids) {
    providers[id] = await loadDescriptor(id);
  }
  return providers;
}

let cached: Record<string, ProviderDescriptor> | null = null;

export async function getProviders(): Promise<Record<string, ProviderDescriptor>> {
  if (!cached) {
    cached = await loadProviders();
  }
  return cached;
}

export function resetProvidersCache(): void {
  cached = null;
}

export type { ProviderDescriptor } from "./types.js";

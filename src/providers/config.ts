import type { ProviderDescriptor } from "./types.js";

type RawProvider = ProviderDescriptor & { baseUrlEnv?: string };

async function loadProviders(): Promise<Record<string, ProviderDescriptor>> {
  const dir = "config/providers";
  const glob = new Bun.Glob(`${dir}/*.json`);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: "." })) {
    files.push(file);
  }
  const providers: Record<string, ProviderDescriptor> = {};

  for (const file of files) {
    if (file.endsWith("schema.json") || file.endsWith("route.json")) continue;
    const raw = (await Bun.file(file).json()) as RawProvider;
    const { baseUrlEnv, ...rest } = raw;

    let baseUrl = rest.baseUrl;
    if (baseUrlEnv) {
      const envVal = process.env[baseUrlEnv];
      if (!envVal) {
        throw new Error(
          `Missing required environment variable ${baseUrlEnv} for provider ${raw.id}`,
        );
      }
      baseUrl = envVal;
    }

    const overrideEnv = `PROVIDER_${raw.id.toUpperCase().replace(/-/g, "_")}_BASE_URL`;
    const overrideVal = process.env[overrideEnv];
    if (overrideVal) {
      baseUrl = overrideVal;
    }
    let timeoutMs = rest.timeoutMs;
    const timeoutOverrideEnv = `PROVIDER_${raw.id.toUpperCase().replace(/-/g, "_")}_TIMEOUT_MS`;
    const timeoutOverrideVal = process.env[timeoutOverrideEnv];
    if (timeoutOverrideVal) {
      const parsed = Number(timeoutOverrideVal);
      if (!Number.isNaN(parsed)) {
        timeoutMs = parsed;
      }
    }

    if (raw.apiKeyEnv) {
      const key = process.env[raw.apiKeyEnv];
      if (!key) {
        throw new Error(
          `Missing required environment variable ${raw.apiKeyEnv} for provider ${raw.id}`,
        );
      }
    }

    providers[raw.id] = { ...rest, baseUrl, timeoutMs };
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

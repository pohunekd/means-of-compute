import type { ProviderDescriptor } from "./types.js";

type RawProvider = ProviderDescriptor & { baseUrlEnv?: string };

let cached: Record<string, ProviderDescriptor> | null = null;

async function loadProviders(): Promise<Record<string, ProviderDescriptor>> {
  const dir = "config/providers";
  const glob = new Bun.Glob(`${dir}/*.json`);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: "." })) {
    files.push(file);
  }
  const providers: Record<string, ProviderDescriptor> = {};

  for (const file of files) {
    if (file.endsWith("schema.json")) continue;
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

    if (raw.apiKeyEnv) {
      const key = process.env[raw.apiKeyEnv];
      if (!key) {
        throw new Error(
          `Missing required environment variable ${raw.apiKeyEnv} for provider ${raw.id}`,
        );
      }
    }

    providers[raw.id] = { ...rest, baseUrl };
  }

  return providers;
}

export async function getProviders(): Promise<Record<string, ProviderDescriptor>> {
  if (!cached) {
    cached = await loadProviders();
  }
  return cached;
}

export type { ProviderDescriptor } from "./types.js";

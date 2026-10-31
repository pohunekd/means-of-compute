import { readInputText, statInputPath } from "../fs/input.js";
import { providerDescriptorExists } from "../providers/config.js";

export const DEMO_NUMBERS_CONFIG_PATH = "config/demo-numbers.json";

export interface DemoNumbersConfig {
  readonly localProviderIds: readonly string[];
  readonly cloudProviderIds: readonly string[];
}

export class DemoNumbersConfigError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DemoNumbersConfigError";
  }
}

function asRecord(value: unknown, keyPath: string, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DemoNumbersConfigError(
      `Demo numbers config ${path}: invalid "${keyPath}": must be a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

function parseStringArray(value: unknown, keyPath: string, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new DemoNumbersConfigError(
      `Demo numbers config ${path}: invalid "${keyPath}": must be an array`,
    );
  }
  const arr = value as unknown[];
  const strings: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") {
      throw new DemoNumbersConfigError(
        `Demo numbers config ${path}: invalid "${keyPath}": array must contain strings`,
      );
    }
    strings.push(item);
  }
  if (new Set(strings).size !== strings.length) {
    throw new DemoNumbersConfigError(
      `Demo numbers config ${path}: invalid "${keyPath}": duplicates are not allowed`,
    );
  }
  return strings;
}

async function validateDescriptors(ids: readonly string[], path: string): Promise<void> {
  for (const id of ids) {
    const exists = await providerDescriptorExists(id);
    if (!exists) {
      throw new DemoNumbersConfigError(
        `Demo numbers config ${path}: provider id "${id}" has no descriptor`,
      );
    }
  }
}

export async function loadDemoNumbersConfig(
  path = DEMO_NUMBERS_CONFIG_PATH,
): Promise<DemoNumbersConfig> {
  const label = "Demo numbers config";
  if ((await statInputPath(label, path)) === "absent") {
    throw new DemoNumbersConfigError(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new DemoNumbersConfigError(`Demo numbers config ${path}: not valid JSON`, {
      cause: error,
    });
  }
  const record = asRecord(raw, "config", path);
  const keys = Object.keys(record);
  if (keys.length !== 2 || !("localProviderIds" in record) || !("cloudProviderIds" in record)) {
    throw new DemoNumbersConfigError(
      `Demo numbers config ${path}: must have exactly two keys "localProviderIds" and "cloudProviderIds"`,
    );
  }
  const localIds = parseStringArray(record.localProviderIds, "localProviderIds", path);
  const cloudIds = parseStringArray(record.cloudProviderIds, "cloudProviderIds", path);
  const all = new Set([...localIds, ...cloudIds]);
  if (all.size !== localIds.length + cloudIds.length) {
    throw new DemoNumbersConfigError(
      `Demo numbers config ${path}: provider ids must be disjoint between local and cloud`,
    );
  }
  await validateDescriptors(localIds, path);
  await validateDescriptors(cloudIds, path);
  return { localProviderIds: localIds, cloudProviderIds: cloudIds };
}

// Pricing reader for the budget guard. It loads exactly one descriptor per
// provider id the guard needs, from config/providers/<id>.json, so it never
// scans the directory: other files in the directory are ignored and a stale
// copy has no effect. Each file is read under the lstat/stat rules; a
// symlink to a regular file is allowed and a missing, dangling or
// non-regular path exits 2. The descriptor id must equal the file name
// stem. Free providers must state explicit zero prices.
import type { ProviderPricing } from "../providers/types.js";
import { readInputText, statInputPath } from "./fs.js";

interface RawPricing {
  readonly inputPer1M?: unknown;
  readonly cachedInputPer1M?: unknown;
  readonly outputPer1M?: unknown;
}

interface RawDescriptor {
  readonly id?: unknown;
  readonly pricing?: RawPricing | undefined;
}

function asNonNegativeNumber(value: unknown, what: string, file: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Budget pricing ${file}: invalid ${what}`);
  }
  return value;
}

function readPricing(raw: unknown, file: string): ProviderPricing {
  if (raw === undefined) {
    throw new Error(`Budget pricing ${file}: missing pricing block`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Budget pricing ${file}: invalid pricing block`);
  }
  const block = raw as RawPricing;
  const pricing: ProviderPricing = {
    inputPer1M: asNonNegativeNumber(block.inputPer1M, "inputPer1M", file),
    outputPer1M: asNonNegativeNumber(block.outputPer1M, "outputPer1M", file),
  };
  if (block.cachedInputPer1M !== undefined) {
    pricing.cachedInputPer1M = asNonNegativeNumber(
      block.cachedInputPer1M,
      "cachedInputPer1M",
      file,
    );
  }
  return pricing;
}

export async function loadDescriptor(dir: string, id: string): Promise<ProviderPricing> {
  const label = "Budget pricing";
  const file = `${dir}/${id}.json`;
  if (id === "" || id.includes("/") || id === "." || id === "..") {
    throw new Error(`${label} ${file}: invalid provider id "${id}"`);
  }
  if ((await statInputPath(label, file)) === "absent") {
    throw new Error(`${label} ${file}: file is missing`);
  }
  const text = await readInputText(label, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} ${file}: not valid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${label} ${file}: missing provider id`);
  }
  const raw = parsed as RawDescriptor;
  if (raw.id !== id) {
    throw new Error(`${label} ${file}: id "${String(raw.id)}" does not match file name`);
  }
  return readPricing(raw.pricing, file);
}

export async function loadPricingForIds(
  dir: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ProviderPricing>> {
  const pricing = new Map<string, ProviderPricing>();
  for (const id of [...ids].sort()) {
    if (!pricing.has(id)) {
      pricing.set(id, await loadDescriptor(dir, id));
    }
  }
  return pricing;
}

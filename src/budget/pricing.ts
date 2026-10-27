// Pricing reader for the budget guard. It parses provider descriptors directly
// from config so cost math never needs API keys and never hard-codes prices.
// A descriptor without a pricing block (self-hosted, unmetered) costs zero.
import type { ProviderPricing } from "../providers/types.js";

const DEFAULT_PRICING_DIR = "config/providers";

interface RawPricing {
  readonly inputPer1M?: unknown;
  readonly cachedInputPer1M?: unknown;
  readonly outputPer1M?: unknown;
}

interface RawDescriptor {
  readonly id?: unknown;
  readonly pricing?: unknown;
}

function asNonNegativeNumber(value: unknown, what: string, file: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Budget pricing ${file}: invalid ${what}`);
  }
  return value;
}

function readPricing(raw: RawPricing | undefined, file: string): ProviderPricing {
  if (raw === undefined) {
    return { inputPer1M: 0, outputPer1M: 0 };
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Budget pricing ${file}: invalid pricing block`);
  }
  const pricing: ProviderPricing = {
    inputPer1M: asNonNegativeNumber(raw.inputPer1M, "inputPer1M", file),
    outputPer1M: asNonNegativeNumber(raw.outputPer1M, "outputPer1M", file),
  };
  if (raw.cachedInputPer1M !== undefined) {
    pricing.cachedInputPer1M = asNonNegativeNumber(
      raw.cachedInputPer1M,
      "cachedInputPer1M",
      file,
    );
  }
  return pricing;
}

export async function loadPricing(
  dir: string = DEFAULT_PRICING_DIR,
): Promise<ReadonlyMap<string, ProviderPricing>> {
  const pricing = new Map<string, ProviderPricing>();
  const glob = new Bun.Glob(`${dir}/*.json`);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: "." })) {
    files.push(file);
  }
  if (files.length === 0) {
    throw new Error(`Budget pricing ${dir}: no provider descriptors found`);
  }
  for (const file of files) {
    if (file.endsWith("schema.json") || file.endsWith("route.json")) {
      continue;
    }
    let raw: RawDescriptor;
    try {
      raw = (await Bun.file(file).json()) as RawDescriptor;
    } catch {
      throw new Error(`Budget pricing ${file}: not valid JSON`);
    }
    if (typeof raw !== "object" || raw === null || typeof raw.id !== "string") {
      throw new Error(`Budget pricing ${file}: missing provider id`);
    }
    pricing.set(raw.id, readPricing(raw.pricing as RawPricing | undefined, file));
  }
  return pricing;
}

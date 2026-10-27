// Pricing reader for the budget guard. It parses provider descriptors directly
// from config so cost math never needs API keys and never hard-codes prices.
// A descriptor without a pricing block is an error: "free" must be stated
// with explicit zero prices.
import type { ProviderPricing } from "../providers/types.js";
import { readInputText, requireInputDir, statInputPath } from "./fs.js";

const DEFAULT_PRICING_DIR = "config/providers";

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

export async function loadPricing(
  dir: string = DEFAULT_PRICING_DIR,
): Promise<ReadonlyMap<string, ProviderPricing>> {
  const pricing = new Map<string, ProviderPricing>();
  const owners = new Map<string, string>();
  await requireInputDir("Budget pricing", dir);
  const glob = new Bun.Glob(`${dir}/*.json`);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: "." })) {
    files.push(file);
  }
  files.sort();
  if (files.length === 0) {
    throw new Error(`Budget pricing ${dir}: no provider descriptors found`);
  }
  for (const file of files) {
    if (file.endsWith("schema.json") || file.endsWith("route.json")) {
      continue;
    }
    if ((await statInputPath("Budget pricing", file)) === "absent") {
      throw new Error(`Budget pricing ${file}: file is missing`);
    }
    const text = await readInputText("Budget pricing", file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw new Error(`Budget pricing ${file}: not valid JSON`, { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`Budget pricing ${file}: missing provider id`);
    }
    const raw = parsed as RawDescriptor;
    if (typeof raw.id !== "string") {
      throw new Error(`Budget pricing ${file}: missing provider id`);
    }
    const owner = owners.get(raw.id);
    if (owner !== undefined) {
      throw new Error(
        `Budget pricing ${file}: duplicate provider id "${raw.id}" (also in ${owner})`,
      );
    }
    owners.set(raw.id, file);
    pricing.set(raw.id, readPricing(raw.pricing, file));
  }
  return pricing;
}

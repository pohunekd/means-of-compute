// Pricing reader for the budget guard. It loads exactly one descriptor per
// provider id the guard needs, from config/providers/<id>.json, so it never
// scans the directory: other files in the directory are ignored and a stale
// copy has no effect. Each file is read under the lstat/stat rules; a
// symlink to a regular file is allowed and a missing, dangling or
// non-regular path exits 2. The descriptor id must equal the file name
// stem. Free providers must state explicit zero prices.
//
// Prices are parsed as decimal strings from the JSON source text into
// integer nano-USD per 1M tokens (at most 9 decimals). The JSON parser
// would lose the decimal text (0.10 becomes the binary float 0.1), so a
// small tokenizer reads the raw value instead; the descriptors stay plain
// JSON numbers and the schema is unchanged.
import { readInputText, statInputPath } from "./fs.js";

export interface NanoPricing {
  readonly inputNanoPer1M: bigint;
  readonly outputNanoPer1M: bigint;
  readonly cachedInputNanoPer1M?: bigint;
}

interface RawDescriptor {
  readonly id?: unknown;
  readonly pricing?: unknown;
}

export const NANO_PER_USD = 1_000_000_000n;
const MAX_DECIMALS = 9;

export function parseDecimalToNanoUsd(raw: string, what: string, file: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(raw);
  if (match === null) {
    throw new Error(`Budget pricing ${file}: invalid ${what} "${raw}"`);
  }
  const whole = BigInt(match[1] as string);
  const frac = (match[2] ?? "").padEnd(MAX_DECIMALS, "0");
  return whole * NANO_PER_USD + BigInt(frac);
}

export function rawDecimalForKey(text: string, key: string, file: string): string | null {
  const matches: string[] = [];
  const pattern = new RegExp(`"${key}"\\s*:\\s*(-?[^,\\s}\\]]+)`);
  let rest = text;
  for (;;) {
    const match = pattern.exec(rest);
    if (match === null || match[1] === undefined || typeof match.index !== "number") {
      break;
    }
    matches.push(match[1]);
    rest = rest.slice(match.index + match[0].length);
  }
  if (matches.length === 0) {
    return null;
  }
  const first = matches[0] as string;
  if (matches.some((candidate) => candidate !== first)) {
    throw new Error(`Budget pricing ${file}: conflicting values for "${key}"`);
  }
  return first;
}

function requiredPrice(text: string, key: string, file: string): bigint {
  const raw = rawDecimalForKey(text, key, file);
  if (raw === null) {
    throw new Error(`Budget pricing ${file}: invalid ${key} "missing"`);
  }
  return parseDecimalToNanoUsd(raw, key, file);
}

function optionalPrice(text: string, key: string, file: string): bigint | undefined {
  const raw = rawDecimalForKey(text, key, file);
  if (raw === null) {
    return undefined;
  }
  return parseDecimalToNanoUsd(raw, key, file);
}

function readPricing(text: string, file: string): NanoPricing {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`Budget pricing ${file}: not valid JSON`, { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pricing" in parsed) ||
    typeof parsed.pricing !== "object"
  ) {
    throw new Error(`Budget pricing ${file}: missing pricing block`);
  }
  return {
    inputNanoPer1M: requiredPrice(text, "inputPer1M", file),
    outputNanoPer1M: requiredPrice(text, "outputPer1M", file),
    cachedInputNanoPer1M: optionalPrice(text, "cachedInputPer1M", file),
  };
}

export async function loadDescriptor(dir: string, id: string): Promise<NanoPricing> {
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
  return readPricing(text, file);
}

export async function loadPricingForIds(
  dir: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, NanoPricing>> {
  const pricing = new Map<string, NanoPricing>();
  for (const id of [...ids].sort()) {
    if (!pricing.has(id)) {
      pricing.set(id, await loadDescriptor(dir, id));
    }
  }
  return pricing;
}

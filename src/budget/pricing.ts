// Pricing reader for the budget guard. It loads exactly one descriptor per
// provider id the guard needs, from config/providers/<id>.json, so it never
// scans the directory: other files in the directory are ignored and a stale
// copy has no effect. Each file is read under the lstat/stat rules; a
// symlink to a regular file is allowed and a missing, dangling or
// non-regular path exits 2. The descriptor id must equal the file name
// stem. Free providers must state explicit zero prices.
//
// The value used is the JSON number as parsed: each descriptor is validated
// against config/providers/schema.json (pricing required, non-array object)
// and each validated price number goes through Number.prototype.toString().
// A result with e/E or more than 9 decimals is rejected, so a source text
// with more digits than a double holds is outside the rule and not detected.
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv/dist/2020";
import { readInputText, statInputPath } from "../fs/input.js";
import { NANO_PER_USD, priceToNanoUsd } from "./money.js";

export interface NanoPricing {
  readonly inputNanoPer1M: bigint;
  readonly outputNanoPer1M: bigint;
  readonly cachedInputNanoPer1M?: bigint;
}

const SCHEMA_PATH = "config/providers/schema.json";

let cachedValidator: ValidateFunction | null = null;

async function loadValidator(): Promise<ValidateFunction> {
  if (cachedValidator !== null) {
    return cachedValidator;
  }
  const label = "Budget pricing";
  if ((await statInputPath(label, SCHEMA_PATH)) === "absent") {
    throw new Error(`${label} ${SCHEMA_PATH}: file is missing`);
  }
  const text = await readInputText(label, SCHEMA_PATH);
  let schema: unknown;
  try {
    schema = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} ${SCHEMA_PATH}: not valid JSON`, { cause: error });
  }
  const ajv = new Ajv({ strict: true });
  addFormats(ajv);
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema as Parameters<Ajv["compile"]>[0]);
  } catch (error: unknown) {
    throw new Error(`${label} ${SCHEMA_PATH}: invalid schema`, { cause: error });
  }
  cachedValidator = validate;
  return validate;
}

interface ValidatedPricing {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  readonly cachedInputPer1M?: number;
}

interface ValidatedDescriptor {
  readonly id: string;
  readonly pricing: ValidatedPricing;
}

export { NANO_PER_USD };

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
  const raw = parsed as { id?: unknown };
  if (raw.id !== id) {
    throw new Error(`${label} ${file}: id "${String(raw.id)}" does not match file name`);
  }
  const validateDescriptor = await loadValidator();
  if (!validateDescriptor(parsed)) {
    throw new Error(
      `${label} ${file}: invalid descriptor ${JSON.stringify(validateDescriptor.errors)}`,
    );
  }
  const descriptor = parsed as unknown as ValidatedDescriptor;
  const pricing: NanoPricing = {
    inputNanoPer1M: priceToNanoUsd(descriptor.pricing.inputPer1M, "inputPer1M", file),
    outputNanoPer1M: priceToNanoUsd(descriptor.pricing.outputPer1M, "outputPer1M", file),
  };
  if (descriptor.pricing.cachedInputPer1M !== undefined) {
    return {
      ...pricing,
      cachedInputNanoPer1M: priceToNanoUsd(
        descriptor.pricing.cachedInputPer1M,
        "cachedInputPer1M",
        file,
      ),
    };
  }
  return pricing;
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

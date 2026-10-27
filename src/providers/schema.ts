// Shared validator for provider descriptors. The schema is read on first use and cached, so importing this module reads no file. The schema is the only place the timeout cap is written.
import { readInputText, statInputPath } from "../fs/input.js";
import { PROVIDER_SCHEMA_PATH } from "./paths.js";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";

const SET_TIMEOUT_MAX_MS = 2_147_483_647;
// setTimeout's delay is a signed 32-bit integer; Bun and Node run a larger delay after 1 ms.

export interface ProviderSchema {
  readonly maxTimeoutMs: number;
  // Null when the data is a valid descriptor, otherwise Ajv's error text.
  descriptorErrors(data: unknown): string | null;
}

let cached: ProviderSchema | null = null;

export async function loadProviderSchema(): Promise<ProviderSchema> {
  if (cached !== null) {
    return cached;
  }
  const label = "Provider schema";
  const path = PROVIDER_SCHEMA_PATH;

  const stat = await statInputPath(label, path);
  if (stat === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }

  const text = await readInputText(label, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${label} ${path}: not valid JSON`, { cause });
  }

  const maximum = (parsed as { properties?: { timeoutMs?: { maximum?: unknown } } }).properties?.timeoutMs?.maximum;
  if (
    typeof maximum !== "number" ||
    !Number.isInteger(maximum) ||
    maximum <= 0 ||
    maximum > SET_TIMEOUT_MAX_MS
  ) {
    throw new Error(`${label} ${path}: timeoutMs.maximum must be an integer in 1..${String(SET_TIMEOUT_MAX_MS)}`);
  }

  let ajvInstance: Ajv;
  let validate: ReturnType<Ajv["compile"]>;
  try {
    ajvInstance = new Ajv({ allErrors: true, strict: true });
    addFormats(ajvInstance);
    validate = ajvInstance.compile(parsed as object);
  } catch (cause) {
    throw new Error(`${label} ${path}: invalid schema`, { cause });
  }

  const schema: ProviderSchema = {
    maxTimeoutMs: maximum,
    descriptorErrors(data: unknown) {
      if (validate(data)) {
        return null;
      }
      return ajvInstance.errorsText(validate.errors);
    },
  };

  cached = schema;
  return schema;
}

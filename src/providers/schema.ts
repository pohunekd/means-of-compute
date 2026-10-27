// Shared validator for provider descriptors. The schema is compiled once at
// module load, with the same Ajv options the providers check uses. The
// schema is also the only place the timeout cap is written.
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";

const SCHEMA_PATH = "config/providers/schema.json";
const schema = (await Bun.file(SCHEMA_PATH).json()) as {
  properties?: { timeoutMs?: { maximum?: unknown } };
};

const maximum = schema.properties?.timeoutMs?.maximum;
if (typeof maximum !== "number" || !Number.isInteger(maximum) || maximum <= 0) {
  throw new Error(`Provider schema ${SCHEMA_PATH}: timeoutMs.maximum must be a positive integer`);
}

export const MAX_TIMEOUT_MS: number = maximum;

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema as object);

// Null when the data is a valid descriptor, otherwise Ajv's error text.
export function providerDescriptorErrors(data: unknown): string | null {
  if (validate(data)) {
    return null;
  }
  return ajv.errorsText(validate.errors);
}

// Shared validator for provider descriptors. The schema is compiled once at
// module load, with the same Ajv options the providers check uses.
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";

const SCHEMA_PATH = "config/providers/schema.json";

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile((await Bun.file(SCHEMA_PATH).json()) as object);

// Null when the data is a valid descriptor, otherwise Ajv's error text.
export function providerDescriptorErrors(data: unknown): string | null {
  if (validate(data)) {
    return null;
  }
  return ajv.errorsText(validate.errors);
}

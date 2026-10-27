import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import { InputPathError, readInputText, statInputPath } from "../src/fs/input.js";
import { loadProviderSchema } from "../src/providers/schema.js";
import { PROVIDERS_DIR, PROVIDER_SCHEMA_PATH, PROVIDER_ROUTE_PATH } from "../src/providers/paths.js";

const dir = PROVIDERS_DIR;
const entries = await readdir(dir);
let failed = 0;

const schema = await loadProviderSchema();

for (const name of entries.sort()) {
  if (!name.endsWith(".json") || name === basename(PROVIDER_SCHEMA_PATH) || name === basename(PROVIDER_ROUTE_PATH)) continue;
  const file = `${dir}/${name}`;
  let text: string;
  try {
    await statInputPath("Providers check", file);
    text = await readInputText("Providers check", file);
  } catch (error: unknown) {
    if (error instanceof InputPathError) {
      console.error(`FAIL ${file}: ${error.message}`);
      failed += 1;
      continue;
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      console.error(`FAIL ${file}: not valid JSON (${error.message})`);
      failed += 1;
      continue;
    }
    throw error;
  }
  const errors = schema.descriptorErrors(data);
  if (errors !== null) {
    console.error(`FAIL ${file}`);
    console.error(errors);
    failed += 1;
  } else {
    console.log(`ok ${file}`);
  }
}

if (failed > 0) {
  process.exit(1);
}

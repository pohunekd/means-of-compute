import { readdir } from "node:fs/promises";
import { InputPathError } from "../src/fs/input.js";
import { readInputText, statInputPath } from "../src/fs/input.js";
import { providerDescriptorErrors } from "../src/providers/schema.js";

const dir = "config/providers";
const entries = await readdir(dir);
let failed = 0;

for (const name of entries.sort()) {
  if (!name.endsWith(".json") || name === "schema.json" || name === "route.json") continue;
  const file = `${dir}/${name}`;
  let text: string;
  try {
    if ((await statInputPath("Providers check", file)) !== "file") {
      throw new InputPathError(`Providers check ${file}: not a regular file`);
    }
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
  const errors = providerDescriptorErrors(data);
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

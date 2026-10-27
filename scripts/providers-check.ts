import { readdir } from "node:fs/promises";
import { readInputText, statInputPath } from "../src/fs/input.js";
import { providerDescriptorErrors } from "../src/providers/schema.js";

const dir = "config/providers";
const entries = await readdir(dir);
let failed = 0;

for (const name of entries.sort()) {
  if (!name.endsWith(".json") || name === "schema.json" || name === "route.json") continue;
  const file = `${dir}/${name}`;
  if ((await statInputPath("Providers check", file)) !== "file") {
    console.error(`FAIL ${file}: not a regular file`);
    failed += 1;
    continue;
  }
  let data: unknown;
  try {
    data = JSON.parse(await readInputText("Providers check", file)) as unknown;
  } catch {
    console.error(`FAIL ${file}: not valid JSON`);
    failed += 1;
    continue;
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

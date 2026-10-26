import Ajv from "ajv";
import addFormats from "ajv-formats";

const schemaPath = "config/providers/schema.json";
const schema = (await Bun.file(schemaPath).json()) as object;

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const dir = "config/providers";
const glob = new Bun.Glob(`${dir}/*.json`);
const files: string[] = [];
for await (const file of glob.scan({ cwd: "." })) {
  files.push(file);
}
let failed = 0;

for (const file of files) {
  if (file.endsWith("schema.json")) continue;
  const data = (await Bun.file(file).json()) as unknown;
  const ok = validate(data);
  if (!ok) {
    console.error(`FAIL ${file}`);
    console.error(validate.errors);
    failed += 1;
  } else {
    console.log(`ok ${file}`);
  }
}

if (failed > 0) {
  process.exit(1);
}

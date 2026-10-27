// Computes the host-state plugin source digest and compares it with the
// committed config. Usage: bun run plugin:digest [--config <path>]
// (from the repo root; the default is config/host-state.json).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadHostStateConfig } from "../src/hoststate/config.js";

const root = process.cwd();

let configPath = join(root, "config", "host-state.json");
const configFlag = Bun.argv.indexOf("--config");
if (configFlag !== -1) {
  const value = Bun.argv[configFlag + 1];
  if (value === undefined) {
    console.error("plugin:digest: missing value for --config");
    process.exit(2);
  }
  configPath = isAbsolute(value) ? value : join(root, value);
}

async function digestInputs(): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [join(root, "src/probe/plugin-entry.ts")],
    target: "bun",
    metafile: true,
  });
  const inputs = Object.keys(result.metafile?.inputs ?? {}).filter(
    (p) => !p.includes("node_modules/"),
  );
  const scenarioDir = join(root, "config", "scenarios");
  const scenarios = readdirSync(scenarioDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join("config", "scenarios", f));
  const extra = ["bun.lock", "config/probe.json", ...scenarios];
  return [...new Set([...inputs, ...extra])].sort();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const inputs = await digestInputs();
let text = "";
for (const rel of inputs) {
  const bytes = readFileSync(join(root, rel));
  text += `${rel}\t${sha256Hex(bytes)}\n`;
}
const computed = `sha256:${sha256Hex(Buffer.from(text, "utf-8"))}`;
console.log(computed);

let expected: string;
try {
  expected = loadHostStateConfig(configPath).package.sourceDigest;
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
if (computed !== expected) {
  console.error(`plugin:digest: expected ${expected}, computed ${computed}`);
  process.exit(2);
}

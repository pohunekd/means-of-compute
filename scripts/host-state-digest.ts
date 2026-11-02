// Computes the host-state plugin source digest and compares it with the
// committed config. Inputs: Cargo.toml, Cargo.lock, crates/moc-host-state/Cargo.toml,
// every file under crates/moc-host-state/src/ (recursive), config/plugin.json,
// config/probe.json, config/scenarios/*.json. Usage: bun run plugin:digest [--config <path>]
// (from the repo root; the default is config/host-state.json).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

function collectRustSrcFiles(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = join(base, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectRustSrcFiles(full, rel, out);
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const inputs: string[] = [];
inputs.push("Cargo.toml");
inputs.push("Cargo.lock");
inputs.push(join("crates", "moc-host-state", "Cargo.toml"));
const srcDir = join(root, "crates", "moc-host-state", "src");
const srcBase = join("crates", "moc-host-state", "src");
const srcFiles: string[] = [];
collectRustSrcFiles(srcDir, srcBase, srcFiles);
inputs.push(...srcFiles);
inputs.push(join("config", "plugin.json"));
inputs.push(join("config", "probe.json"));
const scenarioDir = join(root, "config", "scenarios");
for (const f of readdirSync(scenarioDir)) {
  if (f.endsWith(".json")) {
    inputs.push(join("config", "scenarios", f));
  }
}
const sorted = [...new Set(inputs)].sort();

for (const rel of sorted) {
  const bytes = readFileSync(join(root, rel));
  const text = bytes.toString("utf-8");
  if (text.includes("include_str!") || text.includes("include_bytes!")) {
    console.error(`plugin:digest: ${rel}: include_str!/include_bytes! is not allowed`);
    process.exit(2);
  }
}

let text = "";
for (const rel of sorted) {
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

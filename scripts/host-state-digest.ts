// Computes the host-state plugin source digest and compares it with the
// committed config. Inputs: Cargo.toml, Cargo.lock, crates/moc-host-state/Cargo.toml,
// every file under crates/moc-host-state/src/ (recursive), config/plugin.json,
// config/probe.json, config/scenarios/*.json. Rejects crate source files that
// contain include_str!/include_bytes! (matched as /\binclude_(str|bytes)\b/)
// with "include_str!/include_bytes! is not allowed", and as a fast early check
// rejects crate source files that match /\binclude\b/ or /\bcfg_attr\b/ with
// "include!/#[path] is not allowed" (the authoritative guard is the compiler's
// dep-info check in plugin:build). Parses crates/moc-host-state/Cargo.toml and
// Cargo.toml with Bun.TOML.parse and rejects package.build not false, lib.path
// or bin[].path not under src/, any dependencies/dev-dependencies/build-dependencies
// (including target.* and workspace.dependencies in the root) with a path key,
// and patch/replace in the root manifest with "<file>: <key> is not allowed".
// Also rejects existence of crates/moc-host-state/build.rs, .cargo/config.toml,
// .cargo/config, rust-toolchain and rust-toolchain.toml with
// "<path> is not allowed (it changes the build outside the digest inputs)".
// Usage: bun run plugin:digest [--config <path>] (from the repo root; the
// default is config/host-state.json).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadHostStateConfig } from "../src/hoststate/config.js";

export function listHostStateDigestInputs(rootDir: string): string[] {
  const inputs: string[] = [];
  inputs.push("Cargo.toml");
  inputs.push("Cargo.lock");
  inputs.push(join("crates", "moc-host-state", "Cargo.toml"));
  const srcDir = join(rootDir, "crates", "moc-host-state", "src");
  const srcBase = join("crates", "moc-host-state", "src");
  const srcFiles: string[] = [];
  collectRustSrcFiles(srcDir, srcBase, srcFiles);
  inputs.push(...srcFiles);
  inputs.push(join("config", "plugin.json"));
  inputs.push(join("config", "probe.json"));
  const scenarioDir = join(rootDir, "config", "scenarios");
  for (const f of readdirSync(scenarioDir)) {
    if (f.endsWith(".json")) {
      inputs.push(join("config", "scenarios", f));
    }
  }
  return [...new Set(inputs)].sort();
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

function checkManifest(rootDir: string, rel: string, isRoot: boolean): void {
  const fullPath = join(rootDir, rel);
  const text = readFileSync(fullPath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }

  const pkg = parsed.package as Record<string, unknown> | undefined;
  if (pkg !== undefined && pkg.build !== undefined && pkg.build !== false) {
    console.error(`plugin:digest: ${rel}: package.build is not allowed`);
    process.exit(2);
  }

  const lib = parsed.lib as Record<string, unknown> | undefined;
  if (lib !== undefined && typeof lib.path === "string" && !lib.path.startsWith("src/")) {
    console.error(`plugin:digest: ${rel}: lib.path is not allowed`);
    process.exit(2);
  }

  const bin = parsed["bin"];
  if (Array.isArray(bin)) {
    for (const entry of bin) {
      if (entry !== null && typeof entry === "object" && "path" in entry) {
        const p = (entry as Record<string, unknown>).path;
        if (typeof p === "string" && !p.startsWith("src/")) {
          console.error(`plugin:digest: ${rel}: bin.path is not allowed`);
          process.exit(2);
        }
      }
    }
  }

  const depTables = ["dependencies", "dev-dependencies", "build-dependencies"];
  for (const tableName of depTables) {
    const tableVal = parsed[tableName];
    if (typeof tableVal === "object" && tableVal !== null) {
      const table = tableVal as Record<string, unknown>;
      for (const [depName, depVal] of Object.entries(table)) {
        if (
          depVal !== null &&
          typeof depVal === "object" &&
          "path" in (depVal as Record<string, unknown>)
        ) {
          console.error(`plugin:digest: ${rel}: ${tableName}.${depName}.path is not allowed`);
          process.exit(2);
        }
      }
    }
  }

  const targetValRaw = parsed["target"];
  if (typeof targetValRaw === "object" && targetValRaw !== null) {
    const target = targetValRaw as Record<string, Record<string, unknown>>;
    for (const [targetName, targetVal] of Object.entries(target)) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (targetVal === null || typeof targetVal !== "object") continue;
      for (const tableName of depTables) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const tableRaw = (targetVal as Record<string, unknown>)[tableName];
        if (typeof tableRaw === "object" && tableRaw !== null) {
          const table = tableRaw as Record<string, unknown>;
          for (const [depName, depVal] of Object.entries(table)) {
            if (
              depVal !== null &&
              typeof depVal === "object" &&
              "path" in (depVal as Record<string, unknown>)
            ) {
              console.error(
                `plugin:digest: ${rel}: target.${targetName}.${tableName}.${depName}.path is not allowed`,
              );
              process.exit(2);
            }
          }
        }
      }
    }
  }

  if (isRoot) {
    const workspaceRaw = parsed["workspace"];
    if (typeof workspaceRaw === "object" && workspaceRaw !== null) {
      const workspace = workspaceRaw as Record<string, unknown>;
      const wsDepsRaw = workspace["dependencies"];
      if (typeof wsDepsRaw === "object" && wsDepsRaw !== null) {
        const wsDeps = wsDepsRaw as Record<string, unknown>;
        for (const [depName, depVal] of Object.entries(wsDeps)) {
          if (
            depVal !== null &&
            typeof depVal === "object" &&
            "path" in (depVal as Record<string, unknown>)
          ) {
            console.error(
              `plugin:digest: ${rel}: workspace.dependencies.${depName}.path is not allowed`,
            );
            process.exit(2);
          }
        }
      }
    }
    if (parsed.patch !== undefined) {
      console.error(`plugin:digest: ${rel}: patch is not allowed`);
      process.exit(2);
    }
    if (parsed.replace !== undefined) {
      console.error(`plugin:digest: ${rel}: replace is not allowed`);
      process.exit(2);
    }
  }
}

function run(): void {
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

  const forbiddenPaths = [
    join("crates", "moc-host-state", "build.rs"),
    join(".cargo", "config.toml"),
    join(".cargo", "config"),
    "rust-toolchain",
    "rust-toolchain.toml",
  ];
  for (const rel of forbiddenPaths) {
    if (existsSync(join(root, rel))) {
      console.error(
        `plugin:digest: ${rel} is not allowed (it changes the build outside the digest inputs)`,
      );
      process.exit(2);
    }
  }

  // Manifest checks before hashing inputs
  checkManifest(root, join("crates", "moc-host-state", "Cargo.toml"), false);
  checkManifest(root, "Cargo.toml", true);

  const sorted = listHostStateDigestInputs(root);
  const srcBase = join("crates", "moc-host-state", "src");

  for (const rel of sorted) {
    if (!rel.startsWith(srcBase)) continue;
    const bytes = readFileSync(join(root, rel));
    const text = bytes.toString("utf-8");
    if (/\binclude_(str|bytes)\b/.test(text)) {
      console.error(`plugin:digest: ${rel}: include_str!/include_bytes! is not allowed`);
      process.exit(2);
    }
    if (/\binclude\b/.test(text) || /\bcfg_attr\b/.test(text)) {
      console.error(`plugin:digest: ${rel}: include!/#[path] is not allowed`);
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
}

if (import.meta.main) {
  run();
}

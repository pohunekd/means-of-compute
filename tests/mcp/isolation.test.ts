// MCP boundary test (matrix X4): the import closure of every file under src/mcp/ never reaches the approvals decide module or the CLI, and no file under src/mcp/ names the atomic writer. Specs come from Bun's import scanner, every closure file is TypeScript or JSON, specs resolve through Bun's resolver on real paths, only node: and bun: modules and bun itself are builtins, root dependency specs that start with file:, link:, workspace:, . or / fail as an early warning, dependency and install inputs stay outside this test, and the loader checks run on the comment-free code of every TypeScript file in the closure. The checks match loader names spelled in source; a name or code built at runtime is outside this test (docs/mcp.md, A9).
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const transpiler = new Bun.Transpiler({ loader: "ts" });

const REQUIRE_TOKEN = /\brequire\b/;
const CREATE_REQUIRE = /\bcreateRequire\b/;
const GET_BUILTIN_MODULE = /\bgetBuiltinModule\b/;
const DIRECT_EVAL = /\beval\b/;
const WORKER_TOKEN = /\bWorker\b/;
const IMPORT_META = /\bimport\.meta(?!\.(?:url|dir|dirname|path|filename|main)\b)/;

export function specsOf(text: string): string[] {
  return transpiler.scanImports(text).map((entry) => entry.path);
}

export function loaderUse(text: string): string | null {
  const code = transpiler.transformSync(text);
  if (REQUIRE_TOKEN.test(code)) {
    return "require";
  }
  if (CREATE_REQUIRE.test(code)) {
    return "createRequire";
  }
  if (GET_BUILTIN_MODULE.test(code)) {
    return "getBuiltinModule";
  }
  if (DIRECT_EVAL.test(code)) {
    return "eval";
  }
  if (WORKER_TOKEN.test(code)) {
    return "Worker";
  }
  for (const spec of specsOf(text)) {
    if (spec === "module" || spec === "node:module") {
      return `import of "${spec}"`;
    }
    if (spec === "worker_threads" || spec === "node:worker_threads") {
      return `import of "${spec}"`;
    }
  }
  if (IMPORT_META.test(code)) {
    return "import.meta";
  }
  return null;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function realRoot(): string {
  return `${realpathSync(process.cwd())}/`;
}

export function isBuiltin(resolved: string): boolean {
  return resolved.startsWith("node:") || resolved.startsWith("bun:") || resolved === "bun";
}

export function localDependencies(pkg: unknown): string[] {
  if (typeof pkg !== "object" || pkg === null) {
    return [];
  }
  const record = pkg as Record<string, unknown>;
  const messages: string[] = [];
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const deps = record[section];
    if (typeof deps !== "object" || deps === null) {
      continue;
    }
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== "string") {
        continue;
      }
      if (
        spec.startsWith("file:") ||
        spec.startsWith("link:") ||
        spec.startsWith("workspace:") ||
        spec.startsWith(".") ||
        spec.startsWith("/")
      ) {
        messages.push(`dependency "${name}" points into the file system: ${spec}`);
      }
    }
  }
  return messages;
}

export function checkTarget(
  spec: string,
  file: string,
  target: string,
  root: string,
): "follow" | "skip" {
  if (target === `${root}node_modules/` || target.startsWith(`${root}node_modules/`)) {
    return "skip";
  }
  if (!target.startsWith(root)) {
    throw new Error(`import "${spec}" in ${file} leaves the repository`);
  }
  if (!target.endsWith(".ts") && !target.endsWith(".json")) {
    throw new Error(`import "${spec}" in ${file} resolves to an unsupported file type`);
  }
  return "follow";
}

function importClosure(entries: string[], root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    if (!file.endsWith(".ts")) {
      continue;
    }
    for (const spec of specsOf(readFileSync(file, "utf8"))) {
      let resolved: string;
      let target: string;
      try {
        resolved = Bun.resolveSync(spec, dirname(file));
        if (!isBuiltin(resolved) && !resolved.startsWith("/")) {
          throw new Error(`import "${spec}" in ${file} resolves to a non-file module`);
        }
        if (isBuiltin(resolved)) {
          continue;
        }
        target = realpathSync(resolved);
      } catch (error) {
        if (error instanceof Error && error.message.includes("resolves to a non-file module")) {
          throw error;
        }
        throw new Error(`unresolved import "${spec}" in ${file}`, { cause: error });
      }
      if (checkTarget(spec, file, target, root) === "skip") {
        continue;
      }
      queue.push(target);
    }
  }
  return seen;
}

function mcpFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((name) => join(dir, name))
    .filter((file) => isFile(file));
}

test("loaderUse flags every loader spelling (X4 Y1)", () => {
  const flagged = [
    'require("x")',
    'require ("x")',
    "createRequire(import.meta.url)",
    'import { createRequire } from "node:module"',
    'import m from "module"',
    'await import("node:module")',
    'import.meta.require("x")',
    'import.meta["require"]("x")',
    "const { require: r } = import.meta",
    "const meta = import.meta",
    'const load = require; load("x")',
    'require.call(undefined, "x")',
    "const { require: r } = import /* x */.meta",
    "const m = import /* x */.meta",
    'process.getBuiltinModule("node:module")',
    'eval("x")',
    'import * as m from /* x */ "node:module"',
    'new Worker(new URL("./w.ts", import.meta.url).href)',
    'import { Worker } from "node:worker_threads"',
    'await import("worker_threads")',
  ];
  for (const sample of flagged) {
    expect(`${sample}: ${loaderUse(sample) ?? "clean"}`).not.toBe(`${sample}: clean`);
  }
});

test("the src/mcp/ import closure never reaches decide or the CLI (X4 Y4, A9)", () => {
  const dir = realpathSync(join(process.cwd(), "src", "mcp"));
  const root = realRoot();
  const entries = mcpFiles(dir);
  const closure = importClosure(entries, root);
  const decide = realpathSync(join(process.cwd(), "src", "approvals", "decide.ts"));
  const cli = realpathSync(join(process.cwd(), "src", "approvals", "cli.ts"));
  expect(closure.has(decide)).toBe(false);
  expect(closure.has(cli)).toBe(false);
  expect(entries.filter((file) => !file.endsWith(".ts"))).toEqual([]);
  for (const file of entries) {
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("writeFileAtomic");
  }
});

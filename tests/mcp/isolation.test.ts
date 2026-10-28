// MCP boundary test (matrix X4): the import closure of every file under
// src/mcp/ never reaches the approvals decide module or the CLI, so no
// MCP call can decide a request; no file under src/mcp/ names the atomic
// writer. Specs come from Bun's import scanner, and the loader checks
// (require in any form, createRequire, getBuiltinModule, direct eval,
// imports of module/node:module, other import.meta reads) run on
// comment-free code, so no file in the closure loads decide outside the
// closure (A9).
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const transpiler = new Bun.Transpiler({ loader: "ts" });

const REQUIRE_TOKEN = /\brequire\b/;
const CREATE_REQUIRE = /\bcreateRequire\b/;
const GET_BUILTIN_MODULE = /\bgetBuiltinModule\b/;
const DIRECT_EVAL = /\beval\b/;
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
  for (const spec of specsOf(text)) {
    if (spec === "module" || spec === "node:module") {
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

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) {
    return null;
  }
  const base = dirname(fromFile);
  const candidates: string[] = [];
  if (spec.endsWith(".ts")) {
    candidates.push(resolve(base, spec));
  } else if (spec.endsWith(".js")) {
    candidates.push(resolve(base, `${spec.slice(0, -3)}.ts`));
  } else {
    candidates.push(resolve(base, spec));
  }
  candidates.push(resolve(base, `${spec}.ts`));
  candidates.push(resolve(base, `${spec}/index.ts`));
  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  throw new Error(`unresolved import "${spec}" in ${fromFile}`);
}

function importClosure(entries: string[]): Set<string> {
  const root = join(process.cwd(), "/");
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
      const target = resolveSpec(file, spec);
      if (target === null) {
        continue;
      }
      if (target.includes("/node_modules/")) {
        continue;
      }
      if (!target.startsWith(root)) {
        throw new Error(`import "${spec}" in ${file} leaves the repository`);
      }
      queue.push(target);
    }
  }
  return seen;
}

function mcpFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
}

test("specsOf reads commented and namespace import specs (X4 Y5)", () => {
  expect(specsOf('import(/* x */ "../approvals/decide.ts")')).toContain(
    "../approvals/decide.ts",
  );
  expect(specsOf('import * as d from /* x */ "../approvals/decide.ts"')).toContain(
    "../approvals/decide.ts",
  );
  expect(specsOf('import * as m from /* x */ "node:module"')).toContain("node:module");
});

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
    "const load = require; load(\"x\")",
    'require.call(undefined, "x")',
    "const { require: r } = import /* x */.meta",
    'process.getBuiltinModule("node:module")',
    'eval("x")',
    'import * as m from /* x */ "node:module"',
  ];
  for (const sample of flagged) {
    expect(`${sample}: ${loaderUse(sample) ?? "clean"}`).not.toBe(`${sample}: clean`);
  }
});

test("loaderUse allows plain property reads and identifiers (X4 Y2)", () => {
  const clean = [
    "import.meta.url",
    "import.meta.dir",
    "import.meta.main",
    'new URL("./a.ts", import.meta.url)',
    "requireAbsoluteDir(x)",
    "arequire(x)",
    "const required = 1",
  ];
  for (const sample of clean) {
    expect(`${sample}: ${loaderUse(sample) ?? "clean"}`).toBe(`${sample}: clean`);
  }
});

test("every closure file is checked for loader use (X4 Y3)", () => {
  const dir = join(process.cwd(), "src", "mcp");
  const entries = mcpFiles(dir);
  const closure = importClosure(entries);
  const checked: string[] = [];
  for (const file of closure) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    const hit = loaderUse(text);
    expect(`${file}: ${hit ?? "clean"}`).toBe(`${file}: clean`);
    checked.push(file);
  }
  expect(checked.sort()).toEqual([...closure].filter((file) => file.endsWith(".ts")).sort());
  // Size reads the checked set: checking only src/mcp/ files fails here.
  expect(checked.length).toBeGreaterThan(entries.length);
  expect(checked.some((file) => !file.startsWith(`${dir}/`))).toBe(true);
  expect(closure.has(join(process.cwd(), "contracts", "v1", "validate.ts"))).toBe(true);
});

test("the src/mcp/ import closure never reaches decide or the CLI (X4 Y4, A9)", () => {
  const dir = join(process.cwd(), "src", "mcp");
  const entries = mcpFiles(dir);
  const closure = importClosure(entries);
  const decide = join(process.cwd(), "src", "approvals", "decide.ts");
  const cli = join(process.cwd(), "src", "approvals", "cli.ts");
  expect(closure.has(decide)).toBe(false);
  expect(closure.has(cli)).toBe(false);
  for (const file of entries) {
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("writeFileAtomic");
  }
});

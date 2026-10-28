// MCP boundary test (matrix X4): the import closure of every file under src/mcp/ never reaches the approvals decide module or the CLI, and no file under src/mcp/ names the atomic writer. Specs come from Bun's import scanner, every closure file is TypeScript or JSON, and the loader checks run on the comment-free code of every TypeScript file in the closure. The checks match loader names spelled in source; a name or code built at runtime is outside this test (docs/mcp.md, A9).
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

export function checkTarget(spec: string, file: string, target: string, root: string): "follow" | "skip" {
  if (target.includes("/node_modules/")) {
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

test("specsOf reads commented and namespace import specs (X4 Y5)", () => {
  expect(specsOf('import(/* x */ "../approvals/decide.ts")')).toContain("../approvals/decide.ts");
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

test("loaderUse allows plain property reads and identifiers (X4 Y2)", () => {
  const clean = [
    "import.meta.url",
    "import.meta.dir",
    "import.meta.main",
    'new URL("./a.ts", import.meta.url)',
    "requireAbsoluteDir(x)",
    "arequire(x)",
    "const required = 1",
    "const workers = 1",
    "// require(\"x\")\nimport.meta.url",
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
  expect(
    [...closure].filter((file) => !file.endsWith(".ts") && !file.endsWith(".json")),
  ).toEqual([]);
  // Size reads the checked set: checking only src/mcp/ files fails here.
  expect(checked.length).toBeGreaterThan(entries.length);
  expect(checked.some((file) => !file.startsWith(`${dir}/`))).toBe(true);
  expect(closure.has(join(process.cwd(), "contracts", "v1", "validate.ts"))).toBe(true);
});

test("checkTarget gates closure edges by location and file type (X4 Y6)", () => {
  const root = "/repo/";
  const file = "/repo/src/mcp/a.ts";
  expect(checkTarget("./a", file, "/repo/src/util/a.ts", root)).toBe("follow");
  expect(checkTarget("./a", file, "/repo/src/util/a.json", root)).toBe("follow");
  expect(checkTarget("x", file, "/repo/node_modules/x/a.mjs", root)).toBe("skip");
  expect(() => checkTarget("../a", file, "/other/a.ts", root)).toThrow(
    `import "../a" in ${file} leaves the repository`,
  );
  for (const ext of [".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".tsx"]) {
    expect(() => checkTarget(`../a${ext}`, file, `/repo/src/util/a${ext}`, root)).toThrow(
      `import "../a${ext}" in ${file} resolves to an unsupported file type`,
    );
  }
});

test("the src/mcp/ import closure never reaches decide or the CLI (X4 Y4, A9)", () => {
  const dir = join(process.cwd(), "src", "mcp");
  const entries = mcpFiles(dir);
  const closure = importClosure(entries);
  const decide = join(process.cwd(), "src", "approvals", "decide.ts");
  const cli = join(process.cwd(), "src", "approvals", "cli.ts");
  expect(closure.has(decide)).toBe(false);
  expect(closure.has(cli)).toBe(false);
  expect(entries.filter((file) => !file.endsWith(".ts"))).toEqual([]);
  for (const file of entries) {
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("writeFileAtomic");
  }
});

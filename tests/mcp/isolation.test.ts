// MCP boundary test (matrix X4): the import closure of every file under
// src/mcp/ never reaches the approvals decide module or the CLI, so no
// MCP call can decide a request; no file under src/mcp/ names the atomic
// writer, and no file in the closure uses a CommonJS-style loader, so no
// MCP call writes a file directly or loads decide outside the closure (A9).
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const IMPORT_SPEC =
  /(?:from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["'])/g;

const MODULE_SPECS = new RegExp(IMPORT_SPEC.source, "g");

const REQUIRE_CALL = /\brequire\s*\(/;
const CREATE_REQUIRE = /\bcreateRequire\b/;
const IMPORT_META = /\bimport\.meta(?!\.(?:url|dir|dirname|path|filename|main)\b)/;

export function loaderUse(text: string): string | null {
  if (REQUIRE_CALL.test(text)) {
    return "require call";
  }
  if (CREATE_REQUIRE.test(text)) {
    return "createRequire";
  }
  MODULE_SPECS.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = MODULE_SPECS.exec(text)) !== null) {
    const spec = found[1] ?? found[2] ?? found[3];
    if (spec === "module" || spec === "node:module") {
      return `import of "${spec}"`;
    }
  }
  if (IMPORT_META.test(text)) {
    return "import.meta";
  }
  return null;
}

function specOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs: string[] = [];
  let found: RegExpExecArray | null;
  IMPORT_SPEC.lastIndex = 0;
  while ((found = IMPORT_SPEC.exec(text)) !== null) {
    const spec = found[1] ?? found[2] ?? found[3];
    if (spec !== undefined) {
      specs.push(spec);
    }
  }
  return specs;
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
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const spec of specOf(file)) {
      const target = resolveSpec(file, spec);
      if (target !== null && target.startsWith(join(process.cwd(), "src") + "/")) {
        queue.push(target);
      }
    }
  }
  return seen;
}

function mcpFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
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
  ];
  for (const sample of flagged) {
    expect(loaderUse(sample)).not.toBeNull();
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
    const text = readFileSync(file, "utf8");
    const hit = loaderUse(text);
    expect(`${file}: ${hit ?? "clean"}`).toBe(`${file}: clean`);
    checked.push(file);
  }
  expect(checked.sort()).toEqual([...closure].sort());
  // Size reads the checked set: checking only src/mcp/ files fails here.
  expect(checked.length).toBeGreaterThan(entries.length);
  expect(checked.some((file) => !file.startsWith(`${dir}/`))).toBe(true);
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

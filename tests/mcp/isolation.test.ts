// MCP boundary test (matrix X4): the import closure of every file under
// src/mcp/ never reaches the approvals decide module or the CLI, so no
// MCP call can decide a request; no file under src/mcp/ names the atomic
// writer or a CommonJS-style loader, so no MCP call writes a file
// directly or loads decide outside the import closure (A9).
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const IMPORT_SPEC =
  /(?:from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["'])/g;

const FORBIDDEN_TEXTS = ["writeFileAtomic", "require(", "import.meta.require", "createRequire"];

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

test("the src/mcp/ import closure never reaches decide or the CLI (X4, A9)", () => {
  const dir = join(process.cwd(), "src", "mcp");
  const entries = mcpFiles(dir);
  const closure = importClosure(entries);
  const decide = join(process.cwd(), "src", "approvals", "decide.ts");
  const cli = join(process.cwd(), "src", "approvals", "cli.ts");
  expect(closure.has(decide)).toBe(false);
  expect(closure.has(cli)).toBe(false);
  for (const file of entries) {
    const text = readFileSync(file, "utf8");
    for (const forbidden of FORBIDDEN_TEXTS) {
      expect(text).not.toContain(forbidden);
    }
  }
});

// MCP boundary test (matrix X4): the import closure of src/mcp/
// never reaches the approvals decide module or the CLI, so no MCP
// call can decide a request; no file under src/mcp/ names the atomic
// writer, so no MCP call writes a file directly (A9).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const IMPORT_SPEC =
  /(?:from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["'])/g;

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

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) {
    return null;
  }
  const mapped = spec.endsWith(".js") ? `${spec.slice(0, -3)}.ts` : spec;
  return resolve(dirname(fromFile), mapped);
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

test("the src/mcp/ import closure never reaches decide or the CLI (X4, A9)", () => {
  const dir = join(process.cwd(), "src", "mcp");
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
  const closure = importClosure(entries);
  const decide = join(process.cwd(), "src", "approvals", "decide.ts");
  const cli = join(process.cwd(), "src", "approvals", "cli.ts");
  expect(closure.has(decide)).toBe(false);
  expect(closure.has(cli)).toBe(false);
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    expect(text).not.toContain("writeFileAtomic");
  }
});

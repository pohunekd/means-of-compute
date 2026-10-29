// MCP boundary test (matrix X4): the import closure of every file under src/mcp/ never reaches the approvals decide module or the CLI, and no file under src/mcp/ names the atomic writer. Specs come from Bun's import scanner, every closure file is TypeScript or JSON, specs resolve through Bun's resolver on real paths, only node: and bun: modules and bun itself are builtins, root dependency specs that start with file:, link:, workspace:, . or / fail as an early warning, dependency and install inputs stay outside this test, and the loader checks run on the comment-free code of every TypeScript file in the closure. The checks match loader names spelled in source; a name or code built at runtime is outside this test (docs/mcp.md, A9).
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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
    '// require("x")\nimport.meta.url',
  ];
  for (const sample of clean) {
    expect(`${sample}: ${loaderUse(sample) ?? "clean"}`).toBe(`${sample}: clean`);
  }
});

test("every closure file is checked for loader use (X4 Y3)", () => {
  const dir = realpathSync(join(process.cwd(), "src", "mcp"));
  const root = realRoot();
  const entries = mcpFiles(dir);
  const closure = importClosure(entries, root);
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
  expect([...closure].filter((file) => !file.endsWith(".ts") && !file.endsWith(".json"))).toEqual(
    [],
  );
  // Size reads the checked set: checking only src/mcp/ files fails here.
  expect(checked.length).toBeGreaterThan(entries.length);
  expect(checked.some((file) => !file.startsWith(`${dir}/`))).toBe(true);
  expect(closure.has(realpathSync(join(process.cwd(), "contracts", "v1", "validate.ts")))).toBe(
    true,
  );
});

test("checkTarget gates closure edges by location and file type (X4 Y6)", () => {
  const root = "/repo/";
  const file = "/repo/src/mcp/a.ts";
  expect(checkTarget("./a", file, "/repo/src/util/a.ts", root)).toBe("follow");
  expect(checkTarget("./a", file, "/repo/src/util/a.json", root)).toBe("follow");
  expect(checkTarget("x", file, "/repo/node_modules/x/a.ts", root)).toBe("skip");
  expect(checkTarget("x", file, "/repo/node_modules/x/a.mjs", root)).toBe("skip");
  expect(checkTarget("./a", file, "/repo/src/util/node_modules/a.ts", root)).toBe("follow");
  expect(isBuiltin("node:fs")).toBe(true);
  expect(isBuiltin("bun:test")).toBe(true);
  expect(isBuiltin("bun")).toBe(true);
  expect(isBuiltin("data:text/javascript,export {}")).toBe(false);
  expect(isBuiltin("https://example.invalid/a.js")).toBe(false);
  expect(() => checkTarget("../a", file, "/other/a.ts", root)).toThrow(
    `import "../a" in ${file} leaves the repository`,
  );
  for (const ext of [".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".tsx"]) {
    expect(() => checkTarget(`../a${ext}`, file, `/repo/src/util/a${ext}`, root)).toThrow(
      `import "../a${ext}" in ${file} resolves to an unsupported file type`,
    );
  }
});

test("a root dependency spec with a file-system prefix fails (X4 Y8)", () => {
  const pkg: unknown = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  expect(localDependencies(pkg)).toEqual([]);
  expect(localDependencies({ dependencies: { zzpkg: "file:./src/zzpkg" } })).toEqual([
    'dependency "zzpkg" points into the file system: file:./src/zzpkg',
  ]);
  expect(localDependencies({ devDependencies: { a: "link:../a", b: "workspace:*" } })).toEqual([
    'dependency "a" points into the file system: link:../a',
    'dependency "b" points into the file system: workspace:*',
  ]);
  expect(
    localDependencies({
      dependencies: { c: "./src/zzpkg", d: "/abs/zzpkg" },
      optionalDependencies: { e: "file:./src/zze" },
      peerDependencies: { f: "file:./src/zzf" },
    }),
  ).toEqual([
    'dependency "c" points into the file system: ./src/zzpkg',
    'dependency "d" points into the file system: /abs/zzpkg',
    'dependency "e" points into the file system: file:./src/zze',
    'dependency "f" points into the file system: file:./src/zzf',
  ]);
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

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the closure follows symlinks and aliases to the real decide (X4 Y7)", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "x4-y7-"));
  tempRoots.push(tempRoot);
  const realRootDir = realpathSync(tempRoot);
  const root = `${realRootDir}/`;
  const approvalsDir = join(realRootDir, "src", "approvals");
  const mcpDir = join(realRootDir, "src", "mcp");
  const utilModulesDir = join(realRootDir, "src", "util", "node_modules");
  mkdirSync(approvalsDir, { recursive: true });
  mkdirSync(mcpDir, { recursive: true });
  mkdirSync(utilModulesDir, { recursive: true });
  const decide = join(approvalsDir, "decide.ts");
  writeFileSync(decide, 'export function decideRequest(): string { return "decide"; }\n');
  writeFileSync(
    join(realRootDir, "package.json"),
    '{"name":"x4-y7","imports":{"#zz/*":"./src/approvals/*"}}\n',
  );
  writeFileSync(
    join(realRootDir, "tsconfig.json"),
    '{"compilerOptions":{"paths":{"@zz/*":["./src/approvals/*"]}}}\n',
  );
  const relayTarget = join(approvalsDir, "decide.ts");
  writeFileSync(
    join(utilModulesDir, "zz-relay.ts"),
    'export * from "../../approvals/decide.ts";\n',
  );
  const entries: string[] = [];
  const entrySpecs = [
    ["file-symlink", 'export { decideRequest } from "../approvals/zz-decide.ts";\n'],
    ["dir-symlink", 'export { decideRequest } from "../zzdir/decide.ts";\n'],
    ["package-alias", 'export { decideRequest } from "#zz/decide.ts";\n'],
    ["tsconfig-alias", 'export { decideRequest } from "@zz/decide.ts";\n'],
    ["nested-modules", 'export { decideRequest } from "../util/node_modules/zz-relay.ts";\n'],
    [
      "data-module",
      "export { decideRequest } from \"data:text/javascript,import { decideRequest } from './src/approvals/decide.ts';export { decideRequest };\";\n",
    ],
  ] as const;
  symlinkSync(relayTarget, join(approvalsDir, "zz-decide.ts"));
  symlinkSync(approvalsDir, join(realRootDir, "src", "zzdir"));
  entrySpecs.forEach(([name, source], index) => {
    const entry = join(mcpDir, `entry-${String(index)}-${name}.ts`);
    writeFileSync(entry, source);
    entries.push(entry);
  });
  const realDecide = realpathSync(decide);
  entries.forEach((entry, index) => {
    const label = entrySpecs[index]?.[0] ?? "unknown";
    if (label === "data-module") {
      expect(() => importClosure([entry], root)).toThrow("resolves to a non-file module");
      return;
    }
    const closure = importClosure([entry], root);
    const found = closure.has(realDecide) ? "true" : "false";
    expect(`${label}: ${found}`).toBe(`${label}: true`);
  });
});

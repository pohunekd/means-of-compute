// Isolation test: only src/dispatcher/adapter/ may import @pohunek/sdk.
// Each case writes a temporary real file (the typed parser needs it on
// disk) under one run directory that is removed as a whole in finally.
// The restricted directory lives under src/ but outside the adapter path;
// the allowed directory lives under the adapter path. Deterministic,
// no network.
import { expect, test } from "bun:test";
import { ESLint } from "eslint";
import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const STATIC_CODE =
  'import type { A } from "@pohunek/sdk";\n' +
  "export type B = A;\n" +
  "export async function load(): Promise<unknown> {\n" +
  '  return import("@pohunek/sdk/client");\n' +
  "}\n";

const TYPE_CODE = 'export type C = import("@pohunek/sdk").A;\n';

const TEMPLATE_CODE =
  "export async function loadTemplate(): Promise<unknown> {\n" +
  "  return import(`@pohunek/sdk/client`);\n" +
  "}\n";

interface LintOutcome {
  readonly rules: readonly (string | null)[];
  readonly fatal: readonly unknown[];
}

async function dirExisted(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function lintCodeAt(relativePath: string, code: string): Promise<LintOutcome> {
  const full = join(process.cwd(), relativePath);
  await writeFile(full, code);
  const lint = new ESLint({ cwd: process.cwd() });
  const results = await lint.lintFiles([relativePath]);
  const messages = results[0]?.messages ?? [];
  return {
    rules: messages.map((message) => message.ruleId),
    fatal: messages.filter((message) => message.fatal === true),
  };
}

async function lintUnder(dir: string, name: string, code: string): Promise<LintOutcome> {
  const relativePath = join(dir, name).replace(`${process.cwd()}/`, "");
  return lintCodeAt(relativePath, code);
}

async function withRunDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = join(process.cwd(), "src", "__sdk-proof-run");
  await mkdir(dir, { recursive: true });
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("static and dynamic SDK imports are restricted outside the adapter", async () => {
  await withRunDir(async (dir) => {
    const outcome = await lintUnder(dir, "proof.ts", STATIC_CODE);
    expect(outcome.fatal).toEqual([]);
    expect(outcome.rules).toContain("no-restricted-imports");
    expect(outcome.rules).toContain("no-restricted-syntax");
  });
});

test("a type import of the SDK is restricted outside the adapter", async () => {
  await withRunDir(async (dir) => {
    const outcome = await lintUnder(dir, "type-proof.ts", TYPE_CODE);
    expect(outcome.fatal).toEqual([]);
    expect(outcome.rules).toContain("no-restricted-syntax");
  });
});

test("a template-literal SDK import is restricted outside the adapter", async () => {
  await withRunDir(async (dir) => {
    const outcome = await lintUnder(dir, "template-proof.ts", TEMPLATE_CODE);
    expect(outcome.fatal).toEqual([]);
    expect(outcome.rules).toContain("no-restricted-syntax");
  });
});

test("no tracked file outside the adapter names the SDK specifier", async () => {
  // Second D4 check alongside the lint selectors: any loader spelling
  // (import.meta.require, createRequire, global require) past the lint
  // rules is caught by matching the specifier text itself.
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: process.cwd() });
  expect(listed.exitCode).toBe(0);
  const extensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
  const allowListed = new Set(["eslint.config.js", "tests/dispatcher/isolation.test.ts"]);
  const specifier = /@pohunek\/(sdk|protocol)\b/;
  const paths = Buffer.from(listed.stdout)
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0);
  const hits: string[] = [];
  for (const path of paths) {
    if (path.startsWith("src/dispatcher/adapter/")) {
      continue;
    }
    if (allowListed.has(path)) {
      continue;
    }
    if (!extensions.has(extname(path))) {
      continue;
    }
    const text = await readFile(join(process.cwd(), path), "utf8").catch((error: unknown) => {
      // A path listed by git but missing on disk is an unstaged deletion:
      // it carries no specifier text, so it cannot match.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (text === null) {
      continue;
    }
    if (specifier.test(text)) {
      hits.push(path);
    }
  }
  expect(hits).toEqual([]);
});

test("the same SDK imports are allowed under the adapter path", async () => {
  const adapterDir = join(process.cwd(), "src", "dispatcher", "adapter");
  const createdAdapter = !(await dirExisted(adapterDir));
  const dir = join(adapterDir, "__sdk-proof-run");
  await mkdir(dir, { recursive: true });
  try {
    for (const [name, code] of [
      ["proof.ts", STATIC_CODE],
      ["type-proof.ts", TYPE_CODE],
      ["template-proof.ts", TEMPLATE_CODE],
    ] as const) {
      const outcome = await lintUnder(dir, name, code);
      expect(outcome.fatal).toEqual([]);
      expect(outcome.rules).toEqual([]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (createdAdapter) {
      await rmdir(adapterDir);
    }
  }
});

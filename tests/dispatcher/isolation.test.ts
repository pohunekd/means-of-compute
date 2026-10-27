// Isolation test: only src/dispatcher/adapter/ may import @pohunek/sdk.
// A static and a dynamic SDK import are written to a temporary real file
// (the typed parser needs it on disk) under src/x/ (restricted) and under
// the adapter path (allowed). Deterministic, no network.
import { expect, test } from "bun:test";
import { ESLint } from "eslint";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CODE =
  'import type { A } from "@pohunek/sdk";\n' +
  "export type B = A | null;\n" +
  "export async function load(): Promise<unknown> {\n" +
  '  return import("@pohunek/sdk/client");\n' +
  "}\n";

async function lintRulesAt(relativePath: string): Promise<readonly (string | null)[]> {
  const full = join(process.cwd(), relativePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, CODE);
  try {
    const lint = new ESLint({ cwd: process.cwd() });
    const results = await lint.lintFiles([relativePath]);
    return (results[0]?.messages ?? []).map((message) => message.ruleId);
  } finally {
    await rm(full, { force: true });
  }
}

function sdkRules(rules: readonly (string | null)[]): readonly (string | null)[] {
  return rules.filter(
    (rule) => rule === "no-restricted-imports" || rule === "no-restricted-syntax",
  );
}

test("static and dynamic SDK imports are restricted outside the adapter", async () => {
  const rules = await lintRulesAt("src/x/__sdk-proof.ts");
  expect(rules).toContain("no-restricted-imports");
  expect(rules).toContain("no-restricted-syntax");
});

test("the same SDK imports are allowed under the adapter path", async () => {
  const rules = await lintRulesAt("src/dispatcher/adapter/__sdk-proof.ts");
  expect(sdkRules(rules)).toEqual([]);
});

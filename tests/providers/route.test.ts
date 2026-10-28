// Route loader tests: one case per rule of coordinator decision 6, each
// naming the mutation that must fail it. Files live in a temp dir so the
// committed config is never touched.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProviderRoute } from "../../src/providers/route.js";

const KNOWN = new Set(["nvidia-build", "meta-api"]);
const PATH = "route.json";

function isKnownId(id: string): Promise<boolean> {
  return Promise.resolve(KNOWN.has(id));
}

async function writeCase(dir: string, contents: string | null): Promise<string> {
  const path = join(dir, PATH);
  if (contents !== null) {
    await Bun.write(path, contents);
  }
  return path;
}

async function expectRule(contents: string | null, fragment: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "provider-route-"));
  try {
    const path = await writeCase(dir, contents);
    let message = "";
    let cause: unknown;
    try {
      await loadProviderRoute(path, isKnownId);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
      cause = error instanceof Error ? error.cause : undefined;
    }
    expect(message).toContain(`Provider route ${path}: ${fragment}`);
    if (fragment === "not valid JSON") {
      expect(cause).toBeDefined();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("route loads the ids in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "provider-route-"));
  try {
    const path = await writeCase(dir, JSON.stringify({ providers: ["nvidia-build", "meta-api"] }));
    const ids = await loadProviderRoute(path, isKnownId);
    expect([...ids]).toEqual(["nvidia-build", "meta-api"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("route: missing file (mutation: drop the absent check)", async () => {
  await expectRule(null, "file is missing");
});

test("route: invalid JSON (mutation: drop the try around JSON.parse)", async () => {
  await expectRule("{oops", "not valid JSON");
});

test("route: wrong shape (mutation: drop the only-key check)", async () => {
  await expectRule(
    JSON.stringify({ providers: ["nvidia-build"], extra: 1 }),
    'needs exactly the key "providers"',
  );
  await expectRule(JSON.stringify(["nvidia-build"]), 'needs exactly the key "providers"');
});

test("route: null content (mutation: drop the raw === null check)", async () => {
  await expectRule("null", 'needs exactly the key "providers"');
});

test("route: non-string array (mutation: drop the string-array check)", async () => {
  await expectRule(
    JSON.stringify({ providers: "nvidia-build" }),
    'needs a string array "providers"',
  );
  await expectRule(
    JSON.stringify({ providers: ["nvidia-build", 7] }),
    'needs a string array "providers"',
  );
});

test("route: empty list (mutation: drop the non-empty check)", async () => {
  await expectRule(JSON.stringify({ providers: [] }), "providers must not be empty");
});

test("route: duplicate id (mutation: drop the duplicate check)", async () => {
  await expectRule(
    JSON.stringify({ providers: ["nvidia-build", "nvidia-build"] }),
    'duplicate provider id "nvidia-build"',
  );
});

test("route: unknown id (mutation: drop the knownIds check)", async () => {
  await expectRule(
    JSON.stringify({ providers: ["nvidia-build", "ghost-api"] }),
    'unknown provider id "ghost-api"',
  );
});

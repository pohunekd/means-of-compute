// Work config and factory-specs loader tests (F1): every key required,
// no extra key, non-empty unique models, bounded integers; specs need at
// least one valid entry with a unique repo.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFactorySpecs } from "../../src/work/specs.js";
import { loadWorkConfig } from "../../src/work/config.js";

function validWork(): Record<string, unknown> {
  return {
    storePath: "logs/work-items.json",
    factorySpecsPath: "config/factory-specs.json",
    models: ["meta/muse-glimmer-30b", "muse-spark-1.3-contributor"],
    maxItemsPerSubmit: 50,
    maxItemBytes: 16384,
    maxStoreItems: 1000,
  };
}

async function writeJson(dir: string, name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await Bun.write(path, `${JSON.stringify(value)}\n`);
  return path;
}

async function failsWith(path: string, fragment: string): Promise<void> {
  let message = "";
  try {
    await loadWorkConfig(path);
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain(fragment);
}

test("valid work config loads with committed bounds (F1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-config-"));
  try {
    const path = await writeJson(dir, "work.json", validWork());
    const config = await loadWorkConfig(path);
    expect(config.models).toEqual(["meta/muse-glimmer-30b", "muse-spark-1.3-contributor"]);
    expect(config.maxItemsPerSubmit).toBe(50);
    expect(config.maxItemBytes).toBe(16384);
    expect(config.maxStoreItems).toBe(1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work config missing key or empty models names it (F1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-config-"));
  try {
    const missing = validWork();
    delete missing["maxStoreItems"];
    await failsWith(await writeJson(dir, "missing.json", missing), '"maxStoreItems"');
    await failsWith(await writeJson(dir, "empty-models.json", { ...validWork(), models: [] }), '"models"');
    const extra = { ...validWork(), extra: true };
    await failsWith(await writeJson(dir, "extra.json", extra), '"extra"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factory specs reject a duplicate repo and an invalid entry (F1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "work-config-"));
  try {
    const dup = [
      { schemaVersion: "v1", repo: "example/demo-repo", mergeMode: "by-rule" },
      { schemaVersion: "v1", repo: "example/demo-repo", mergeMode: "by-rule" },
    ];
    let message = "";
    try {
      await loadFactorySpecs(await writeJson(dir, "dup.json", dup));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('duplicate repo "example/demo-repo"');
    message = "";
    try {
      await loadFactorySpecs(
        await writeJson(dir, "bad.json", [{ schemaVersion: "v1", repo: "no-slash" }]),
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("not a valid FactorySpec");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factory specs load the committed entry (F1)", async () => {
  const specs = await loadFactorySpecs("config/factory-specs.json");
  expect(specs).toEqual([
    { schemaVersion: "v1", repo: "pohunekd/means-of-compute", mergeMode: "by-rule" },
  ]);
});

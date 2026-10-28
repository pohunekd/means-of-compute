// Loop config tests (matrix rows L1-L2): a missing stall.maxRetries names
// the key, and the stub section is rejected in production but required in
// stub mode. The valid cases load the checked-in production config.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopConfigError, loadLoopConfig } from "../../src/loop/config.js";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "loop-config-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(dir: string, value: unknown): Promise<string> {
  const path = join(dir, "loop.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

async function productionBase(): Promise<Record<string, unknown>> {
  const text = await readFile("config/loop.json", "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

test("the checked-in production config loads (L1 valid case)", async () => {
  const config = await loadLoopConfig("config/loop.json", "production");
  expect(config.tickMs).toBe(5000);
  expect(config.stub).toBeNull();
  expect(config.repos).toHaveLength(1);
  expect(config.repos[0]?.idPrefix).toBe("moc");
});

test("a missing stall.maxRetries fails naming the key (L1)", async () => {
  await withTempDir(async (dir) => {
    const base = await productionBase();
    const stall = { ...(base["stall"] as Record<string, unknown>) };
    delete stall["maxRetries"];
    const path = await writeConfig(dir, { ...base, stall });
    let message = "";
    try {
      await loadLoopConfig(path, "production");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("stall.maxRetries");
  });
});

test("the checked-in production config has no stub section (L2 valid case)", async () => {
  const base = await productionBase();
  await withTempDir(async (dir) => {
    const path = await writeConfig(dir, { ...base, stub: { foo: 1 } });
    let error: unknown;
    try {
      await loadLoopConfig(path, "production");
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopConfigError);
  });
});

test("stub present in production mode is an error (L2)", async () => {
  await withTempDir(async (dir) => {
    const base = await productionBase();
    const path = await writeConfig(dir, {
      ...base,
      stub: {
        sandboxDir: "logs/loop-demo",
        demoRepoDir: "tests/fixtures/loop/demo-repo",
        observationsPath: "tests/fixtures/loop/hosts.json",
        recordingsPath: "tests/fixtures/loop/recordings.json",
      },
    });
    let message = "";
    try {
      await loadLoopConfig(path, "production");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('"stub"');
  });
});

test("absent stub in stub mode is an error (L2)", async () => {
  await withTempDir(async (dir) => {
    const base = await productionBase();
    const path = await writeConfig(dir, base);
    let message = "";
    try {
      await loadLoopConfig(path, "stub");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('"stub"');
  });
});

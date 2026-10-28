// Loop config tests (matrix rows L1-L2, decision F1): a missing
// stall.maxRetries names the key, the stub section is rejected in
// production but required in stub mode, and the demo config resolves in
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

test("the demo config resolves in stub mode with a stub work setup (F1)", async () => {
  const demo = JSON.parse(await readFile("config/loop-demo.json", "utf8")) as Record<
    string,
    unknown
  >;
  const sandbox = await mkdtemp(join(tmpdir(), "loop-demo-"));
  // Input fixtures live outside the sandbox (stub step 4 clears it), as in
  // the committed demo config.
  const fixtureDir = await mkdtemp(join(tmpdir(), "loop-demo-input-"));
  try {
    const workPath = join(fixtureDir, "work.json");
    await writeFile(
      workPath,
      JSON.stringify({
        storePath: join(fixtureDir, "work-items.json"),
        factorySpecsPath: join(fixtureDir, "factory-specs.json"),
        models: ["meta/muse-glimmer-30b"],
        maxItemsPerSubmit: 50,
        maxItemBytes: 16384,
        maxStoreItems: 1000,
      }),
    );
    await writeFile(
      join(fixtureDir, "factory-specs.json"),
      JSON.stringify([{ schemaVersion: "v1", repo: "example/demo-repo", mergeMode: "by-rule" }]),
    );
    const sandboxDemo = {
      ...demo,
      statePath: join(sandbox, "loop-state.json"),
      logPath: join(sandbox, "loop.jsonl"),
      resultsPath: join(sandbox, "loop-results.jsonl"),
      workConfigPath: workPath,
      github: {
        ...(demo["github"] as Record<string, unknown>),
        configDir: join(sandbox, "gh-config"),
      },
      digest: { dir: join(sandbox, "digest"), onExit: true },
      trialMerge: {
        ...(demo["trialMerge"] as Record<string, unknown>),
        scratchDir: join(sandbox, "trial"),
      },
      repos: [
        { repo: "example/demo-repo", checkoutDir: join(sandbox, "checkout"), idPrefix: "demo" },
      ],
      stub: {
        ...(demo["stub"] as Record<string, unknown>),
        sandboxDir: sandbox,
      },
    };
    const path = await writeConfig(sandbox, sandboxDemo);
    const config = await loadLoopConfig(path, "stub");
    expect(config.stub?.sandboxDir).toBe(sandbox);
    expect(config.statePath).toBe(join(sandbox, "loop-state.json"));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("a written path outside the stub sandbox is rejected naming the key (F1)", async () => {
  const demo = JSON.parse(await readFile("config/loop-demo.json", "utf8")) as Record<
    string,
    unknown
  >;
  const sandbox = await mkdtemp(join(tmpdir(), "loop-demo-outside-"));
  try {
    const workPath = join(sandbox, "work.json");
    await writeFile(
      workPath,
      JSON.stringify({
        storePath: join(sandbox, "work-items.json"),
        factorySpecsPath: join(sandbox, "factory-specs.json"),
        models: ["meta/muse-glimmer-30b"],
        maxItemsPerSubmit: 50,
        maxItemBytes: 16384,
        maxStoreItems: 1000,
      }),
    );
    await writeFile(
      join(sandbox, "factory-specs.json"),
      JSON.stringify([{ schemaVersion: "v1", repo: "example/demo-repo", mergeMode: "by-rule" }]),
    );
    const outside = {
      ...demo,
      statePath: join(tmpdir(), "loop-state-outside.json"),
      workConfigPath: workPath,
      stub: { ...(demo["stub"] as Record<string, unknown>), sandboxDir: sandbox },
    };
    const path = await writeConfig(sandbox, outside);
    let error: unknown;
    try {
      await loadLoopConfig(path, "stub");
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopConfigError);
    expect((error as Error).message).toContain("stub path outside the sandbox: statePath");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
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

test("an unknown key in audit or digest is rejected naming the key (F2)", async () => {
  await withTempDir(async (dir) => {
    const base = await productionBase();
    for (const [section, key, name] of [
      ["audit", "bogus", "audit.bogus"],
      ["digest", "bogus", "digest.bogus"],
    ] as const) {
      const path = await writeConfig(dir, {
        ...base,
        [section]: { ...(base[section] as Record<string, unknown>), [key]: 1 },
      });
      let error: unknown;
      try {
        await loadLoopConfig(path, "production");
      } catch (thrown: unknown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(LoopConfigError);
      expect((error as Error).message).toContain(`unexpected key "${name}"`);
    }
  });
});

test("an empty audit section reports the missing retries key (F2)", async () => {
  await withTempDir(async (dir) => {
    const base = await productionBase();
    const path = await writeConfig(dir, { ...base, audit: {} });
    let error: unknown;
    try {
      await loadLoopConfig(path, "production");
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopConfigError);
    expect((error as Error).message).toContain('missing required key "audit.retries"');
  });
});

test("duplicate repos entries are rejected naming the repo key (F3)", async () => {
  await withTempDir(async (dir) => {
    const base = await productionBase();
    const first = { ...((base["repos"] as unknown[])[0] as Record<string, unknown>) };
    const second = { ...first, idPrefix: "moc2", checkoutDir: "logs/checkouts/other" };
    const path = await writeConfig(dir, { ...base, repos: [first, second] });
    let error: unknown;
    try {
      await loadLoopConfig(path, "production");
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopConfigError);
    expect((error as Error).message).toContain("repos[1].repo");
  });
});

test("a null adapter path in production mode names the key (F6)", async () => {
  await withTempDir(async (dir) => {
    const base = await productionBase();
    const path = await writeConfig(dir, { ...base, adapterConfigPath: null });
    let error: unknown;
    try {
      await loadLoopConfig(path, "production");
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopConfigError);
    expect((error as Error).message).toContain('invalid required key "adapterConfigPath"');
  });
});

test("a missing config file throws LoopConfigError (F7)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-config-missing-"));
  try {
    let error: unknown;
    try {
      await loadLoopConfig(join(dir, "nope", "loop.json"), "stub");
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LoopConfigError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

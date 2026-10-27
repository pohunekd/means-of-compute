// Config loader tests: descriptor validation (decision H1). Each case builds
// a temp copy of the config tree and reads it through a child process, so the
// committed config is never touched and no network is used.
// Mutations: skip the schema validation in loadDescriptor.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { makeTempConfig, removeTempConfig, runLoadCheck } from "./temp-config.js";

async function withDescriptor(
  transform: (descriptor: Record<string, unknown>) => void,
): Promise<{ code: number; output: string }> {
  const dir = await makeTempConfig();
  try {
    const path = join(dir, "config", "providers", "meta-api.json");
    const descriptor = (await Bun.file(path).json()) as Record<string, unknown>;
    transform(descriptor);
    await Bun.write(path, JSON.stringify(descriptor));
    return await runLoadCheck(dir);
  } finally {
    removeTempConfig(dir);
  }
}

test("config: descriptor without timeoutMs throws naming the path and timeoutMs", async () => {
  const result = await withDescriptor((descriptor) => {
    delete descriptor["timeoutMs"];
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain("config/providers/meta-api.json");
  expect(result.output).toContain("timeoutMs");
});

test("config: descriptor with timeoutMs 0 throws (mutation: skip the validation)", async () => {
  const result = await withDescriptor((descriptor) => {
    descriptor["timeoutMs"] = 0;
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain("config/providers/meta-api.json");
  expect(result.output).toContain("timeoutMs");
});

test("config: descriptor with timeoutMs 600001 throws (mutation: drop maximum)", async () => {
  const result = await withDescriptor((descriptor) => {
    descriptor["timeoutMs"] = 600001;
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain("config/providers/meta-api.json");
  expect(result.output).toContain("timeoutMs");
});

test("config: timeout override 600001 throws (mutation: larger literal)", async () => {
  const {
    makeTempConfig: make,
    removeTempConfig: remove,
    runLoadCheck: load,
  } = await import("./temp-config.js");
  const { setChildEnv } = await import("./temp-config.js");
  const dir = await make();
  try {
    setChildEnv({ PROVIDER_META_API_TIMEOUT_MS: "600001" });
    const result = await load(dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("PROVIDER_META_API_TIMEOUT_MS");
  } finally {
    remove(dir);
  }
});

test("config: valid descriptors load", async () => {
  const dir = await makeTempConfig();
  try {
    const result = await runLoadCheck(dir);
    expect(result.code).toBe(0);
    expect(result.output).toContain("loaded");
  } finally {
    removeTempConfig(dir);
  }
});

test("config: duplicated route ids throw (mutation: restore the lenient parser)", async () => {
  const { join } = await import("node:path");
  const dir = await makeTempConfig();
  try {
    await Bun.write(
      join(dir, "config", "providers", "route.json"),
      JSON.stringify({ providers: ["nvidia-build", "nvidia-build"] }),
    );
    const result = await runLoadCheck(dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain('duplicate provider id "nvidia-build"');
  } finally {
    removeTempConfig(dir);
  }
});

test("config: schema timeoutMs.maximum 2147483648 fails the load (mutation: drop the setTimeout limit)", async () => {
  const { join } = await import("node:path");
  const dir = await makeTempConfig();
  try {
    const schemaPath = join(dir, "config", "providers", "schema.json");
    const schema = await Bun.file(schemaPath).json();
    schema.properties.timeoutMs.maximum = 2147483648;
    await Bun.write(schemaPath, JSON.stringify(schema));
    const result = await runLoadCheck(dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("config/providers/schema.json");
    expect(result.output).toContain("timeoutMs.maximum");
  } finally {
    removeTempConfig(dir);
  }
});

test("config: schema timeoutMs.maximum 2147483647 loads (mutation: >= instead of <=)", async () => {
  const { join } = await import("node:path");
  const dir = await makeTempConfig();
  try {
    const schemaPath = join(dir, "config", "providers", "schema.json");
    const schema = await Bun.file(schemaPath).json();
    schema.properties.timeoutMs.maximum = 2147483647;
    await Bun.write(schemaPath, JSON.stringify(schema));
    const result = await runLoadCheck(dir);
    expect(result.code).toBe(0);
    expect(result.output).toContain("loaded");
  } finally {
    removeTempConfig(dir);
  }
});

test("config: missing schema rejects getProviders, not the import (mutation: load the schema at module top level)", async () => {
  const { join } = await import("node:path");
  const dir = await makeTempConfig();
  try {
    await Bun.file(join(dir, "config", "providers", "schema.json")).remove();
    const result = await runLoadCheck(dir);
    expect(result.code).toBe(1);
    expect(result.output.trim()).toBe("Provider schema config/providers/schema.json: file is missing");
  } finally {
    removeTempConfig(dir);
  }
});

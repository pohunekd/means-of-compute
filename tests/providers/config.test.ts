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

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

test("config: descriptor with a non-allow-listed model throws naming the path and model (mutation: drop the enum)", async () => {
  const result = await withDescriptor((descriptor) => {
    descriptor["model"] = "other-vendor-model";
  });
  expect(result.code).toBe(1);
  expect(result.output.trim()).toBe(
    "Provider descriptor config/providers/meta-api.json: data/model must be equal to one of the allowed values",
  );
});

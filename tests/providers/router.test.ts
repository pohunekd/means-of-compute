import { afterEach, test } from "bun:test";
import { startLoopback } from "../../src/providers/loopback.js";
import { resetProvidersCache } from "../../src/providers/config.js";

// Every test sets placeholder keys and loopback URLs; restore the
// pre-file values after each test so nothing leaks into later files
// in the same process (L3).
const ENV_KEYS = [
  "NVIDIA_API_KEY",
  "META_API_KEY",
  "LOCAL_MODEL_BASE_URL",
  "PROVIDER_NVIDIA_BUILD_BASE_URL",
  "PROVIDER_META_API_BASE_URL",
  "PROVIDER_NVIDIA_BUILD_TIMEOUT_MS",
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) {
  savedEnv.set(key, process.env[key]);
}
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  resetProvidersCache();
});

async function withProviders(
  primaryPath: string,
  fallbackPath: string,
  extraEnv: Record<string, string> = {},
) {
  resetProvidersCache();
  process.env.NVIDIA_API_KEY = "test";
  process.env.META_API_KEY = "test";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  for (const [k, v] of Object.entries(extraEnv)) {
    process.env[k] = v;
  }
  const primaryServer = await startLoopback(primaryPath);
  const fallbackServer = await startLoopback(fallbackPath);
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(primaryServer.port)}`;
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(fallbackServer.port)}`;
  return { primaryServer, fallbackServer };
}

function cleanupEnv() {
  delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
  delete process.env.PROVIDER_META_API_BASE_URL;
  delete process.env.PROVIDER_NVIDIA_BUILD_TIMEOUT_MS;
  resetProvidersCache();
}

test("router fails over on 429", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-429.json",
    "tests/providers/recordings/fallback-200.json",
  );
  const { callWithFallback } = await import("../../src/providers/router.js");
  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  if (result.providerId !== "meta-api") throw new Error("Expected fallback to meta-api");
  if (result.failoverReason !== "rate_limit")
    throw new Error("Expected failover reason rate_limit");
  if (result.content !== "fallback response") throw new Error("Unexpected content");
});

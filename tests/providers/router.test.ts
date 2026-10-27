import { test } from "bun:test";
import { startLoopback } from "../../src/providers/loopback.js";
import { resetProvidersCache } from "../../src/providers/config.js";

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

test("router does not fail over on 401", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-401.json",
    "tests/providers/recordings/fallback-200.json",
  );
  const { callWithFallback } = await import("../../src/providers/router.js");
  let threw = false;
  try {
    await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  } catch {
    threw = true;
  }
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  if (!threw) throw new Error("Expected error on 401");
});

test("router fails over on timeout", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-delay.json",
    "tests/providers/recordings/fallback-200.json",
    { PROVIDER_NVIDIA_BUILD_TIMEOUT_MS: "10" },
  );
  const { callWithFallback } = await import("../../src/providers/router.js");
  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  if (result.providerId !== "meta-api") throw new Error("Expected fallback to meta-api");
  if (result.failoverReason !== "timeout") throw new Error("Expected failover reason timeout");
  if (result.content !== "fallback response") throw new Error("Unexpected content");
});

test("router fails over on connection error", async () => {
  resetProvidersCache();
  process.env.NVIDIA_API_KEY = "test";
  process.env.META_API_KEY = "test";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = "http://127.0.0.1:9";
  const fallbackServer = await startLoopback("tests/providers/recordings/fallback-200.json");
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(fallbackServer.port)}`;
  const { callWithFallback } = await import("../../src/providers/router.js");
  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  void fallbackServer.stop();
  cleanupEnv();
  if (result.providerId !== "meta-api") throw new Error("Expected fallback to meta-api");
  if (result.failoverReason !== "connection")
    throw new Error("Expected failover reason connection");
  if (result.content !== "fallback response") throw new Error("Unexpected content");
});

test("router fails over on invalid content", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-invalid-content.json",
    "tests/providers/recordings/fallback-200.json",
  );
  const { callWithFallback } = await import("../../src/providers/router.js");
  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  if (result.providerId !== "meta-api") throw new Error("Expected fallback to meta-api");
  if (result.failoverReason !== "server_error")
    throw new Error("Expected failover reason server_error");
  if (result.content !== "fallback response") throw new Error("Unexpected content");
});

import { afterEach, expect, test } from "bun:test";
import { startLoopback } from "../../src/providers/loopback.js";
import { resetProvidersCache } from "../../src/providers/config.js";
import {
  ProviderCallError,
  ProviderError,
  ProvidersExhaustedError,
} from "../../src/providers/router.js";

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

test("router fails over on a non-JSON 200 (mutation: parse with resp.json() again)", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-non-json.json",
    "tests/providers/recordings/fallback-200.json",
  );
  const { callWithFallback } = await import("../../src/providers/router.js");
  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  expect(result.providerId).toBe("meta-api");
  expect(result.failoverReason).toBe("server_error");
  expect(result.content).toBe("fallback response");
});

test("router throws ProvidersExhaustedError naming the last reason (mutation: plain Error)", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-429.json",
    "tests/providers/recordings/fallback-500.json",
  );
  const { callWithFallback } = await import("../../src/providers/router.js");
  let caught: unknown;
  try {
    await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  } catch (error: unknown) {
    caught = error;
  }
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  expect(caught).toBeInstanceOf(ProvidersExhaustedError);
  const exhausted = caught as ProvidersExhaustedError;
  expect(exhausted.lastReason).toBe("server_error");
  expect(exhausted.message).toContain("server_error");
  expect(exhausted.cause).toBeInstanceOf(Error);
});

test("router maps HTTP 503 to server_error (mutation: 503 becomes connection)", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-503.json",
    "tests/providers/recordings/fallback-200.json",
  );
  const { callWithFallback } = await import("../../src/providers/router.js");
  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  expect(result.providerId).toBe("meta-api");
  expect(result.failoverReason).toBe("server_error");
  expect(result.content).toBe("fallback response");
});

test("router maps HTTP 504 to server_error", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-504.json",
    "tests/providers/recordings/fallback-200.json",
  );
  const { callWithFallback } = await import("../../src/providers/router.js");
  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  expect(result.providerId).toBe("meta-api");
  expect(result.failoverReason).toBe("server_error");
  expect(result.content).toBe("fallback response");
});

test("router maps HTTP 500 to server_error", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-500.json",
    "tests/providers/recordings/fallback-200.json",
  );
  const { callWithFallback } = await import("../../src/providers/router.js");
  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  expect(result.providerId).toBe("meta-api");
  expect(result.failoverReason).toBe("server_error");
  expect(result.content).toBe("fallback response");
});

test("router rejects a bad timeout override naming the variable (mutation: isNaN fallback)", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-429.json",
    "tests/providers/recordings/fallback-200.json",
    { PROVIDER_NVIDIA_BUILD_TIMEOUT_MS: "abc" },
  );
  const { callWithFallback } = await import("../../src/providers/router.js");
  let message = "";
  try {
    await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  expect(message).toContain("PROVIDER_NVIDIA_BUILD_TIMEOUT_MS");
});

test("router rejects an unknown route id (mutation: predicate always true)", async () => {
  const { makeTempConfig, removeTempConfig, runCallCheck } = await import("./temp-config.js");
  const dir = await makeTempConfig();
  try {
    const { join } = await import("node:path");
    await Bun.write(
      join(dir, "config", "providers", "route.json"),
      JSON.stringify({ providers: ["nvidia-build", "ghost-api"] }),
    );
    const result = await runCallCheck(dir);
    if (result.code === 0) throw new Error("Expected the unknown route id to fail");
    if (!result.output.includes('unknown provider id "ghost-api"')) {
      throw new Error(`Unexpected output: ${result.output}`);
    }
  } finally {
    removeTempConfig(dir);
  }
});

test("callProviderOnce on a 429 throws without a second call (mutation: fall back to the next provider)", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-429.json",
    "tests/providers/recordings/fallback-200.json",
  );
  const { callProviderOnce } = await import("../../src/providers/router.js");
  let caught: unknown;
  try {
    await callProviderOnce("nvidia-build", { messages: [{ role: "user", content: "hi" }] });
  } catch (error: unknown) {
    caught = error;
  }
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  expect(caught).toBeInstanceOf(ProviderError);
  expect((caught as ProviderError).status).toBe(429);
});

test("callProviderOnce without usage gives null token counts (mutation: default the counts to 0)", async () => {
  resetProvidersCache();
  process.env.NVIDIA_API_KEY = "test";
  process.env.META_API_KEY = "test";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  const server = await startLoopback("tests/providers/recordings/single-no-usage.json");
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  const { callProviderOnce } = await import("../../src/providers/router.js");
  const result = await callProviderOnce("nvidia-build", {
    messages: [{ role: "user", content: "hi" }],
  });
  void server.stop();
  cleanupEnv();
  expect(result.providerId).toBe("nvidia-build");
  expect(result.content).toBe("single response");
  expect(result.inputTokens).toBeNull();
  expect(result.outputTokens).toBeNull();
});

test("callProviderOnce on a 200 with null content throws ProviderCallError with usage (mutation: plain ProviderError)", async () => {
  resetProvidersCache();
  process.env.NVIDIA_API_KEY = "test";
  process.env.META_API_KEY = "test";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  const server = await startLoopback("tests/providers/recordings/primary-invalid-content.json");
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  const { callProviderOnce } = await import("../../src/providers/router.js");
  let caught: unknown;
  try {
    await callProviderOnce("nvidia-build", { messages: [{ role: "user", content: "hi" }] });
  } catch (error: unknown) {
    caught = error;
  }
  void server.stop();
  cleanupEnv();
  expect(caught).toBeInstanceOf(ProviderCallError);
  const failure = caught as ProviderCallError;
  expect(failure).toBeInstanceOf(ProviderError);
  expect(failure.reachedProvider).toBe(true);
  expect(failure.usage).toEqual({ inputTokens: null, outputTokens: null });
});

test("callProviderOnce on a non-JSON 200 throws ProviderCallError with null usage", async () => {
  resetProvidersCache();
  process.env.NVIDIA_API_KEY = "test";
  process.env.META_API_KEY = "test";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  const server = await startLoopback("tests/providers/recordings/primary-non-json.json");
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(server.port)}`;
  const { callProviderOnce } = await import("../../src/providers/router.js");
  let caught: unknown;
  try {
    await callProviderOnce("nvidia-build", { messages: [{ role: "user", content: "hi" }] });
  } catch (error: unknown) {
    caught = error;
  }
  void server.stop();
  cleanupEnv();
  expect(caught).toBeInstanceOf(ProviderCallError);
  const failure = caught as ProviderCallError;
  expect(failure.reachedProvider).toBe(true);
  expect(failure.usage).toBeNull();
});

test("callProviderOnce on a refused connection throws ProviderCallError that did not reach the provider", async () => {
  resetProvidersCache();
  process.env.NVIDIA_API_KEY = "test";
  process.env.META_API_KEY = "test";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = "http://127.0.0.1:9";
  const { callProviderOnce } = await import("../../src/providers/router.js");
  let caught: unknown;
  try {
    await callProviderOnce("nvidia-build", { messages: [{ role: "user", content: "hi" }] });
  } catch (error: unknown) {
    caught = error;
  }
  cleanupEnv();
  expect(caught).toBeInstanceOf(ProviderCallError);
  const failure = caught as ProviderCallError;
  expect(failure.reachedProvider).toBe(false);
  expect(failure.usage).toBeNull();
});

test("callProviderOnce on a non-200 throws ProviderCallError that did not reach billing (L-3)", async () => {
  const { primaryServer, fallbackServer } = await withProviders(
    "tests/providers/recordings/primary-429.json",
    "tests/providers/recordings/fallback-200.json",
  );
  const { callProviderOnce } = await import("../../src/providers/router.js");
  let caught: unknown;
  try {
    await callProviderOnce("nvidia-build", { messages: [{ role: "user", content: "hi" }] });
  } catch (error: unknown) {
    caught = error;
  }
  void primaryServer.stop();
  void fallbackServer.stop();
  cleanupEnv();
  expect(caught).toBeInstanceOf(ProviderCallError);
  const failure = caught as ProviderCallError;
  expect(failure).toBeInstanceOf(ProviderError);
  expect(failure.message).toBe("Provider nvidia-build responded 429");
  expect(failure.status).toBe(429);
  expect(failure.reachedProvider).toBe(false);
  expect(failure.usage).toBeNull();
});

test("callProviderOnce rejects an unknown provider id", async () => {
  resetProvidersCache();
  process.env.NVIDIA_API_KEY = "test";
  process.env.META_API_KEY = "test";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  const { callProviderOnce } = await import("../../src/providers/router.js");
  let message = "";
  try {
    await callProviderOnce("ghost-api", { messages: [{ role: "user", content: "hi" }] });
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  cleanupEnv();
  expect(message).toBe("Unknown provider ghost-api");
});

test("router rejects a duplicate route id on a warm cache (mutation: unvalidated route read)", async () => {
  const { makeTempConfig, removeTempConfig, runWarmCallCheck } = await import("./temp-config.js");
  const dir = await makeTempConfig();
  try {
    const result = await runWarmCallCheck(dir, { providers: ["nvidia-build", "nvidia-build"] });
    if (result.code === 0) throw new Error("Expected the duplicate route id to fail");
    if (!result.output.includes('duplicate provider id "nvidia-build"')) {
      throw new Error(`Unexpected output: ${result.output}`);
    }
  } finally {
    removeTempConfig(dir);
  }
});

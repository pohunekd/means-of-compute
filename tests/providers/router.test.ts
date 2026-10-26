import { test } from "bun:test";
import { startLoopback } from "../../src/providers/loopback.js";

test("router fails over on 429", async () => {
  process.env.NVIDIA_API_KEY = "test";
  process.env.META_API_KEY = "test";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";

  const primaryServer = startLoopback([{ status: 429, body: { error: "rate limited" } }]);
  const fallbackServer = startLoopback([
    { status: 200, body: { choices: [{ message: { content: "fallback response" } }] } },
  ]);

  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(primaryServer.port)}`;
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(fallbackServer.port)}`;

  const { callWithFallback } = await import("../../src/providers/router.js");

  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });

  void primaryServer.stop();
  void fallbackServer.stop();

  if (result.providerId !== "meta-api") throw new Error("Expected fallback to meta-api");
  if (result.failoverReason !== "rate_limit")
    throw new Error("Expected failover reason rate_limit");
  if (result.content !== "fallback response") throw new Error("Unexpected content");
});

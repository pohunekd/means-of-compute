import { getProviders } from "./config.js";
import type { ProviderDescriptor } from "./types.js";

export interface ModelCallResult {
  providerId: string;
  model: string;
  content: string;
  failoverReason?: string;
}

export interface ModelRequest {
  messages: Array<{ role: string; content: string }>;
}

class ProviderError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ProviderError";
  }
}

async function callProvider(provider: ProviderDescriptor, request: ModelRequest): Promise<string> {
  const base = provider.baseUrl.replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  const controller = new AbortController();
  const timeoutMs = provider.timeoutMs;
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: request.messages,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new ProviderError(
        `Provider ${provider.id} responded ${String(resp.status)}`,
        resp.status,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(await resp.text()) as unknown;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        throw new ProviderError(`Provider ${provider.id} returned a non-JSON body`, 502);
      }
      throw error;
    }
    const content = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
      ?.message?.content;
    if (typeof content !== "string") {
      throw new ProviderError(`Provider ${provider.id} returned invalid content`, 502);
    }
    return content;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadRoute(): Promise<string[]> {
  const routeFile = Bun.file("config/providers/route.json");
  const json = (await routeFile.json()) as { providers: string[] };
  return json.providers;
}

export async function callWithFallback(request: ModelRequest): Promise<ModelCallResult> {
  const providers = await getProviders();
  const route = await loadRoute();
  let lastReason: string | undefined;
  for (const id of route) {
    const provider = providers[id];
    if (!provider) {
      throw new Error(`Unknown provider ${id}`);
    }
    try {
      const content = await callProvider(provider, request);
      if (lastReason) {
        return {
          providerId: provider.id,
          model: provider.model,
          content,
          failoverReason: lastReason,
        };
      }
      return { providerId: provider.id, model: provider.model, content };
    } catch (e: unknown) {
      if (e instanceof ProviderError) {
        const status = e.status;
        if (status === 429) {
          lastReason = "rate_limit";
        } else if (status >= 500 && status < 600) {
          lastReason = "server_error";
        } else {
          throw e;
        }
      } else if (e instanceof Error) {
        if (e.message === "timeout") {
          lastReason = "timeout";
        } else if (e.name === "AbortError") {
          lastReason = "timeout";
        } else if (e instanceof TypeError) {
          lastReason = "connection";
        } else {
          throw e;
        }
      } else {
        throw e;
      }
      // continue to next provider
    }
  }
  throw new Error("All providers failed");
}

import { getProviders, providerDescriptorExists, ROUTE_PATH } from "./config.js";
import { loadProviderRoute } from "./route.js";
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

export class ProviderError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ProviderError";
  }
}

export class ProvidersExhaustedError extends Error {
  readonly lastReason: string;
  constructor(lastReason: string, lastError: unknown) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    super(`All providers failed (last: ${lastReason}: ${detail})`, { cause: lastError });
    this.lastReason = lastReason;
    this.name = "ProvidersExhaustedError";
  }
}

export interface SingleCallResult {
  readonly providerId: string;
  readonly model: string;
  readonly content: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

function usageCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function callProvider(
  provider: ProviderDescriptor,
  request: ModelRequest,
): Promise<Omit<SingleCallResult, "providerId" | "model">> {
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
    const usage = (data as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
      .usage;
    return {
      content,
      inputTokens: usageCount(usage?.prompt_tokens),
      outputTokens: usageCount(usage?.completion_tokens),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function callProviderOnce(
  providerId: string,
  request: ModelRequest,
): Promise<SingleCallResult> {
  const providers = await getProviders();
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider ${providerId}`);
  }
  const result = await callProvider(provider, request);
  return {
    providerId: provider.id,
    model: provider.model,
    content: result.content,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

export async function callWithFallback(request: ModelRequest): Promise<ModelCallResult> {
  const providers = await getProviders();
  const route = await loadProviderRoute(ROUTE_PATH, providerDescriptorExists);
  let lastReason: string | undefined;
  let lastError: unknown;
  for (const id of route) {
    const provider = providers[id];
    if (!provider) {
      throw new Error(`Unknown provider ${id}`);
    }
    try {
      const { content } = await callProvider(provider, request);
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
        if (e.name === "AbortError") {
          lastReason = "timeout";
        } else if (e instanceof TypeError) {
          lastReason = "connection";
        } else {
          throw e;
        }
      } else {
        throw e;
      }
      lastError = e;
      // continue to next provider
    }
  }
  throw new ProvidersExhaustedError(lastReason ?? "unknown", lastError);
}

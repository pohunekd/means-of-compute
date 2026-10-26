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

function getProviderSync(
  providers: Record<string, ProviderDescriptor>,
  id: string,
): ProviderDescriptor {
  const p = providers[id];
  if (!p) throw new Error(`Unknown provider ${id}`);
  return p;
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
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: provider.model,
      messages: request.messages,
    }),
  });
  if (!resp.ok) {
    throw new ProviderError(
      `Provider ${provider.id} responded ${String(resp.status)}`,
      resp.status,
    );
  }
  const data = await resp.json();
  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
    ?.message?.content;
  return typeof content === "string" ? content : "";
}

export async function callWithFallback(request: ModelRequest): Promise<ModelCallResult> {
  const providers = await getProviders();
  const primary = getProviderSync(providers, "nvidia-build");
  const fallback = getProviderSync(providers, "meta-api");
  try {
    const content = await callProvider(primary, request);
    return { providerId: primary.id, model: primary.model, content };
  } catch (e: unknown) {
    const status = e instanceof ProviderError ? e.status : undefined;
    const reason = status === 429 ? "rate_limit" : "outage";
    const content = await callProvider(fallback, request);
    return {
      providerId: fallback.id,
      model: fallback.model,
      content,
      failoverReason: reason,
    };
  }
}

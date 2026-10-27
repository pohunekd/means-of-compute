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

export interface ProviderUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export class ProviderCallError extends ProviderError {
  readonly reachedProvider: boolean;
  readonly usage: ProviderUsage | null;
  constructor(
    message: string,
    status: number,
    reachedProvider: boolean,
    usage: ProviderUsage | null,
    options?: ErrorOptions,
  ) {
    super(message, status);
    this.name = "ProviderCallError";
    this.reachedProvider = reachedProvider;
    this.usage = usage;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
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

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
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
  // Reached means fetch resolved: any failure from here on may be
  // billed server-side, even when the body never arrives.
  const state = { timedOut: false, responded: false };
  const timeoutId = setTimeout(() => {
    state.timedOut = true;
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
    // The provider answered: everything below reads the body of a
    // call that can already be billed.
    state.responded = true;
    if (!resp.ok) {
      throw new ProviderCallError(
        `Provider ${provider.id} responded ${String(resp.status)}`,
        resp.status,
        false,
        null,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(await resp.text()) as unknown;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        // The provider answered 200, so the call may be billed even
        // though the body cannot be parsed: usage is unknown.
        throw new ProviderCallError(
          `Provider ${provider.id} returned a non-JSON body`,
          502,
          true,
          null,
          { cause: error },
        );
      }
      throw error;
    }
    const content = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
      ?.message?.content;
    const usage = (data as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
      .usage;
    if (typeof content !== "string") {
      // The provider answered 200 with usage attached, so the call may
      // be billed: carry the parsed usage for the ledger entry.
      throw new ProviderCallError(
        `Provider ${provider.id} returned invalid content`,
        502,
        true,
        {
          inputTokens: usageCount(usage?.prompt_tokens),
          outputTokens: usageCount(usage?.completion_tokens),
        },
        { cause: data },
      );
    }
    return {
      content,
      inputTokens: usageCount(usage?.prompt_tokens),
      outputTokens: usageCount(usage?.completion_tokens),
    };
  } catch (error: unknown) {
    if (error instanceof ProviderCallError) {
      // Already classified above (non-200, non-JSON, invalid content):
      // a classified failure is never re-wrapped.
      throw error;
    }
    if (isAbortError(error)) {
      // The request was sent before the abort, so the call may be billed:
      // a late reply still counts server-side. Usage is unknown.
      if (state.timedOut) {
        throw new ProviderCallError(`Provider ${provider.id} timed out`, 504, true, null, {
          cause: error,
        });
      }
      throw error;
    }
    if (error instanceof TypeError) {
      // A TypeError before fetch resolved is a connection failure:
      // the call never reached the provider. The same error after
      // the response began means the provider may still bill it.
      throw new ProviderCallError(
        `Provider ${provider.id} connection failed: ${error.message}`,
        503,
        state.responded,
        null,
        { cause: error },
      );
    }
    if (state.responded) {
      // Any other error while reading the body of an answered call
      // is billed the same way: reached, with unknown usage.
      throw new ProviderCallError(
        `Provider ${provider.id} failed reading the response: ${
          error instanceof Error ? error.message : String(error)
        }`,
        502,
        true,
        null,
        { cause: error },
      );
    }
    throw error;
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
      if (e instanceof ProviderCallError) {
        // Single-call failures carry their own reason. Status wins
        // over reachability: a 429 is a rate limit and a 5xx a server
        // error even when the response already rules out billing.
        // Only an unreached 503 is a connection failure; any other
        // unclassified status throws instead of failing over.
        if (e.status === 504) {
          lastReason = "timeout";
        } else if (!e.reachedProvider && e.status === 503) {
          lastReason = "connection";
        } else if (e.status === 429) {
          lastReason = "rate_limit";
        } else if (e.status >= 500 && e.status < 600) {
          lastReason = "server_error";
        } else {
          throw e;
        }
      } else if (e instanceof ProviderError) {
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

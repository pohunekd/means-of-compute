export interface ProviderPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
}

export interface ProviderRateLimit {
  rpm: number;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  pricing?: ProviderPricing;
  rateLimit?: ProviderRateLimit;
}

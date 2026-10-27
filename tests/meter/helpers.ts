// Shared meter test setup: a meter on 127.0.0.1:0 with the host map
// {"laptop-a": ["127.0.0.1"]} and placeholder keys from the router tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadMeterConfig, resolveMeterEnv } from "../../src/meter/config.js";
import type { MeterConfig } from "../../src/meter/config.js";
import { startMeter, type Meter, type MeterLogEvent } from "../../src/meter/meter.js";
import { resetProvidersCache } from "../../src/providers/config.js";
import { startLoopback } from "../../src/providers/loopback.js";

export interface MeterFixture {
  readonly meter: Meter;
  readonly events: MeterLogEvent[];
  readonly logPath: string;
  readonly tokenFor: (requestId: string) => string;
}

const META_MODEL = "muse-spark-1.3-contributor";
const NVIDIA_MODEL = "meta/muse-glimmer-30b";

export async function withMeter(
  recordingsPath: string,
  run: (fixture: MeterFixture) => Promise<void>,
  meterOverrides: Partial<MeterConfig> = {},
): Promise<void> {
  const secret = randomBytes(32).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "meter-proxy-"));
  const hostsFile = join(dir, "hosts.json");
  const logPath = join(dir, "usage.jsonl");
  await Bun.write(hostsFile, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
  const loopback = await startLoopback(recordingsPath);
  resetProvidersCache();
  process.env.META_API_KEY = "test-meta-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_META_API_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = `http://127.0.0.1:${String(loopback.port)}`;
  const events: MeterLogEvent[] = [];
  const base = await loadMeterConfig();
  const config: MeterConfig = { ...base, usageLogPath: logPath, ...meterOverrides };
  const env = await resolveMeterEnv(
    config,
    {
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: secret,
      MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
    },
  );
  const { getProviders } = await import("../../src/providers/config.js");
  const providers = await getProviders();
  const meter = await startMeter({ config, env, providers, now: () => new Date(), log: (e) => events.push(e) });
  try {
    await run({
      meter,
      events,
      logPath,
      tokenFor: (requestId: string) => meter.tokenFor(requestId),
    });
  } finally {
    await meter.close();
    await loopback.stop();
    resetProvidersCache();
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.META_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.LOCAL_MODEL_BASE_URL;
    rmSync(dir, { recursive: true, force: true });
  }
}

export function meterUrl(meter: { readonly port: number }, path = "/v1/chat/completions"): string {
  return `http://127.0.0.1:${String(meter.port)}${path}`;
}

export async function openBoundGrant(
  meter: Meter,
  overrides: { requestId?: string; providerId?: string; model?: string } = {},
): Promise<{ requestId: string; token: string; sessionId: string }> {
  const requestId = overrides.requestId ?? "w1-demo:0";
  const providerId = overrides.providerId ?? "meta-api";
  const model = overrides.model ?? (providerId === "meta-api" ? META_MODEL : NVIDIA_MODEL);
  await meter.openGrant({
    requestId,
    workItemId: requestId.split(":")[0] as string,
    hostAlias: "laptop-a",
    providerId,
    model,
  });
  const sessionId = `sess-${requestId.replace(/[^a-z0-9]/gi, "-")}`;
  await meter.bindGrant(requestId, sessionId);
  return { requestId, token: meter.tokenFor(requestId), sessionId };
}

export async function readLogLines(logPath: string): Promise<string[]> {
  const text = await Bun.file(logPath).text();
  return text.split("\n").filter((line) => line.length > 0);
}

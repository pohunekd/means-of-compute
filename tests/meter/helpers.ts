// Shared meter test setup: a meter on 127.0.0.1:0 with the host map
// {"laptop-a": ["127.0.0.1"]} and placeholder keys from the router tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadMeterConfig, resolveMeterEnv } from "../../src/meter/config.js";
import type { MeterConfig } from "../../src/meter/config.js";
import {
  startMeter,
  type Meter,
  type MeterLiveView,
  type MeterLogEvent,
} from "../../src/meter/meter.js";
import type { UsageLogIo } from "../../src/meter/usage-log.js";
import { systemUsageLogIo } from "../../src/meter/usage-log.js";
import { resetProvidersCache } from "../../src/providers/config.js";
import { startLoopback } from "../../src/providers/loopback.js";
import { createManualTimers, type ManualTimers } from "./manual-timers.js";

export interface MeterFixture {
  readonly meter: Meter;
  readonly live: MeterLiveView;
  readonly events: MeterLogEvent[];
  readonly logPath: string;
  readonly loopback: Awaited<ReturnType<typeof startLoopback>>;
  readonly timers: ManualTimers;
  readonly tokenFor: (requestId: string) => string;
  readonly waitForEvent: (match: (e: MeterLogEvent) => boolean) => Promise<MeterLogEvent>;
}

const META_MODEL = "muse-spark-1.3-contributor";
const NVIDIA_MODEL = "meta/muse-glimmer-30b";

export interface MeterOverrides {
  config?: Partial<MeterConfig>;
  logIo?: UsageLogIo;
  hosts?: Record<string, string[]>;
  now?: () => Date;
  upstreamBaseUrl?: string;
}

export async function withMeter(
  recordingsPath: string,
  run: (fixture: MeterFixture) => Promise<void>,
  overrides: MeterOverrides = {},
): Promise<void> {
  const secret = randomBytes(32).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "meter-proxy-"));
  const hostsFile = join(dir, "hosts.json");
  const logPath = join(dir, "usage.jsonl");
  await Bun.write(hostsFile, JSON.stringify(overrides.hosts ?? { "laptop-a": ["127.0.0.1"] }));
  const loopback = await startLoopback(recordingsPath);
  resetProvidersCache();
  process.env.META_API_KEY = "test-meta-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  const upstream = overrides.upstreamBaseUrl ?? `http://127.0.0.1:${String(loopback.port)}`;
  process.env.PROVIDER_META_API_BASE_URL = upstream;
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = upstream;
  const events: MeterLogEvent[] = [];
  const eventWaiters: Array<{
    match: (e: MeterLogEvent) => boolean;
    resolve: (e: MeterLogEvent) => void;
  }> = [];
  const log = (e: MeterLogEvent): void => {
    events.push(e);
    for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = eventWaiters[i] as {
        match: (e: MeterLogEvent) => boolean;
        resolve: (e: MeterLogEvent) => void;
      };
      if (waiter.match(e)) {
        eventWaiters.splice(i, 1);
        waiter.resolve(e);
      }
    }
  };
  const timers = createManualTimers();
  const base = await loadMeterConfig();
  const config: MeterConfig = { ...base, usageLogPath: logPath, ...overrides.config };
  const env = await resolveMeterEnv(config, {
    MOC_METER_LISTEN: "127.0.0.1:0",
    MOC_METER_SECRET: secret,
    MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
  });
  const { getProviders } = await import("../../src/providers/config.js");
  const providers = await getProviders();
  const meter = await startMeter({
    config,
    env,
    providers,
    timers,
    logIo: overrides.logIo ?? systemUsageLogIo,
    now: overrides.now ?? (() => new Date()),
    log,
  });
  const waitForEvent = (match: (e: MeterLogEvent) => boolean): Promise<MeterLogEvent> => {
    const past = events.find(match);
    if (past !== undefined) {
      return Promise.resolve(past);
    }
    return new Promise<MeterLogEvent>((resolve) => {
      eventWaiters.push({ match, resolve });
    });
  };
  try {
    await run({
      meter,
      live: meter,
      events,
      logPath,
      loopback,
      timers,
      tokenFor: (requestId: string) => meter.tokenFor(requestId),
      waitForEvent,
    });
  } finally {
    loopback.release();
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

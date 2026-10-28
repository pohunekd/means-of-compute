// Meter startup tests: a throwing listening log still releases the bound
// port before startMeter rejects (design section 2.7).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  MeterConfigError,
  loadMeterConfig,
  resolveMeterEnv,
} from "../../src/meter/config.js";
import type { MeterConfig } from "../../src/meter/config.js";
import { startMeter, type Meter, type MeterLogEvent } from "../../src/meter/meter.js";
import { getProviders, resetProvidersCache } from "../../src/providers/config.js";
import { systemUsageLogIo } from "../../src/meter/usage-log.js";
import { createManualTimers } from "./manual-timers.js";

test("a throwing listening log releases the bound port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meter-startup-"));
  const hostsFile = join(dir, "hosts.json");
  await Bun.write(hostsFile, JSON.stringify({ "laptop-a": ["127.0.0.1"] }));
  resetProvidersCache();
  const savedEnv: Record<string, string | undefined> = {
    META_API_KEY: process.env.META_API_KEY,
    NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
    LOCAL_MODEL_BASE_URL: process.env.LOCAL_MODEL_BASE_URL,
    PROVIDER_META_API_BASE_URL: process.env.PROVIDER_META_API_BASE_URL,
    PROVIDER_NVIDIA_BUILD_BASE_URL: process.env.PROVIDER_NVIDIA_BUILD_BASE_URL,
  };
  const restoreEnv = (): void => {
    for (const key of Object.keys(savedEnv)) {
      const value = savedEnv[key];
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  process.env.META_API_KEY = "test-meta-key";
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
  process.env.LOCAL_MODEL_BASE_URL = "http://localhost:1234/v1";
  process.env.PROVIDER_META_API_BASE_URL = "http://127.0.0.1:1";
  process.env.PROVIDER_NVIDIA_BUILD_BASE_URL = "http://127.0.0.1:1";
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(): Response {
      return new Response("probe");
    },
  });
  const port = probe.port;
  probe.stop(true);
  const started: Meter[] = [];
  try {
    const base = await loadMeterConfig();
    const secret = randomBytes(32).toString("base64");
    const config: MeterConfig = { ...base, usageLogPath: join(dir, "usage.jsonl") };
    const envOf = (): Promise<Awaited<ReturnType<typeof resolveMeterEnv>>> =>
      resolveMeterEnv(config, {
        MOC_METER_LISTEN: `127.0.0.1:${String(port)}`,
        MOC_METER_SECRET: secret,
        MOC_METER_HOST_ADDRESSES_FILE: hostsFile,
      });
    const providers = await getProviders();
    const startArgs = {
      config,
      providers,
      timers: createManualTimers(),
      logIo: systemUsageLogIo,
      now: () => new Date(),
    };
    const throwingLog = (event: MeterLogEvent): void => {
      if (event.event === "listening") {
        throw new Error("injected log failure");
      }
    };
    let failure: unknown = null;
    try {
      await startMeter({ ...startArgs, env: await envOf(), log: throwingLog });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MeterConfigError);
    // The bound listener is gone: the same port binds again.
    const events: MeterLogEvent[] = [];
    const second = await startMeter({
      ...startArgs,
      env: await envOf(),
      log: (event: MeterLogEvent): void => {
        events.push(event);
      },
    });
    started.push(second);
    expect(events.some((event) => event.event === "listening")).toBe(true);
  } finally {
    for (const meter of started) {
      await meter.close().catch(() => {});
    }
    resetProvidersCache();
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

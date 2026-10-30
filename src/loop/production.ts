// Production loop composition: GitHub and path checks, the meter, the
// Pohunek dispatch and host-state ports, the recovery pass and the tick loop.
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PohunekAdapterConfig } from "../dispatcher/adapter/config.js";
import type { DispatcherPort } from "../dispatcher/port.js";
import type { AdapterLogEvent } from "../dispatcher/adapter/pohunek-port.js";
import { createDispatcher } from "../dispatcher/dispatcher.js";
import { createCliBudgetGate } from "../budget/gate.js";
import { requireInputDir } from "../fs/input.js";
import { requireWritableTarget } from "../fs/write.js";
import { loadHostStateConfig } from "../hoststate/config.js";
import type { HostStateConfig } from "../hoststate/config.js";
import type { HostStatePort } from "../hoststate/port.js";
import { createCollector } from "../hoststate/collector.js";
import type { HostStateLogEvent } from "../hoststate/collector.js";
import {
  LoopStartupError,
  closeAll,
  schedulerContextOf,
  stopScheduler,
  toStartupError,
  withRegistryLock,
  type Closer,
  type LoopConfigs,
  type StopSignal,
} from "./compose.js";
import type { LoopGithubConfig } from "./config.js";
import type { AuditorConfig } from "../auditor/config.js";
import { GitHubError, type GhEnv, type GitHubPort } from "./github.js";
import { openLoopLog } from "./log.js";
import { createScheduler, recoverAtStartup } from "./scheduler.js";
import type { Scheduler } from "./scheduler.js";
import { readLoopState } from "./state.js";
import { openCallLog } from "../mcp/call-log.js";
import type { MeterLogEvent } from "../meter/meter.js";
import { createMeteredPort } from "../meter/metered-port.js";
import { startMeter } from "../meter/meter.js";
import { systemTimers } from "../meter/timers.js";
import { systemUsageLogIo } from "../meter/usage-log.js";
import { loadProviderDescriptor } from "../providers/config.js";
import { PROVIDERS_DIR } from "../providers/paths.js";
import type { MeterEnv } from "../meter/config.js";
import type { MeterConfig } from "../meter/config.js";
import type { ProviderDescriptor } from "../providers/types.js";
import type { ModelRequest, SingleCallResult } from "../providers/router.js";

export interface ProductionOpeners {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly loadAdapterConfig: (path: string) => Promise<PohunekAdapterConfig>;
  readonly openGitHub: (config: LoopGithubConfig, env: GhEnv) => GitHubPort;
  readonly resolveMeterEnv: (
    config: MeterConfig,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<MeterEnv>;
  readonly loadProviders: () => Promise<Record<string, ProviderDescriptor>>;
  readonly openPort: (
    config: PohunekAdapterConfig,
    log: (event: AdapterLogEvent) => void,
    env: Readonly<Record<string, string | undefined>>,
    tokenFor: (requestId: string) => string,
  ) => Promise<DispatcherPort>;
  readonly openHostState: (
    config: PohunekAdapterConfig,
    command: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<HostStatePort>;
  readonly auditCall: (providerId: string, request: ModelRequest) => Promise<SingleCallResult>;
}

export interface ProductionRunDeps {
  readonly configs: LoopConfigs;
  readonly openers: ProductionOpeners;
  readonly stop: StopSignal;
  readonly out: (line: string) => void;
  readonly warn: (line: string) => void;
}

async function requireOwnedDir(key: string, path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw new LoopStartupError(`cannot create ${key}`, { cause: error });
  }
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new LoopStartupError(`${name} is not set`);
  }
  return value;
}

async function checkGitHub(
  config: LoopGithubConfig,
  env: Readonly<Record<string, string | undefined>>,
  openGitHub: (config: LoopGithubConfig, env: GhEnv) => GitHubPort,
): Promise<GitHubPort> {
  const token = env[config.tokenEnv];
  if (token === undefined || token === "") {
    throw new LoopStartupError("github token missing");
  }
  if (config.factoryLogin === null) {
    throw new LoopStartupError("github.factoryLogin is not set");
  }
  const port = openGitHub(config, { PATH: requiredEnv(env, "PATH"), token });
  let login: string;
  try {
    login = await port.viewerLogin();
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      throw new LoopStartupError(`github login check failed: ${error.kind}`, { cause: error });
    }
    throw error;
  }
  if (login !== config.factoryLogin) {
    throw new LoopStartupError("github login mismatch");
  }
  return port;
}

async function checkAuditSettlesInGrace(
  shutdownGraceMs: number,
  auditor: AuditorConfig,
): Promise<void> {
  const entries = [...auditor.auditors, auditor.mergeAuditor];
  let largest = { timeoutMs: 0, providerId: "" };
  for (const entry of entries) {
    const descriptor = await loadProviderDescriptor(entry.providerId);
    if (descriptor.timeoutMs > largest.timeoutMs) {
      largest = { timeoutMs: descriptor.timeoutMs, providerId: descriptor.id };
    }
  }
  if (shutdownGraceMs <= largest.timeoutMs) {
    throw new LoopStartupError(
      `shutdownGraceMs ${String(shutdownGraceMs)} must exceed the largest audit provider timeoutMs ${String(largest.timeoutMs)} (${largest.providerId})`,
    );
  }
}

export async function runProduction(deps: ProductionRunDeps): Promise<0 | 1> {
  const { configs, openers } = deps;
  const loop = configs.loop;
  if (loop.adapterConfigPath === null || loop.hostStateConfigPath === null) {
    throw new LoopStartupError("production mode needs adapter and host-state config paths");
  }
  const adapterPath = loop.adapterConfigPath;
  const hostStatePath = loop.hostStateConfigPath;
  let adapter: PohunekAdapterConfig;
  let hostState: HostStateConfig;
  let meterEnv: MeterEnv;
  try {
    adapter = await openers.loadAdapterConfig(adapterPath);
    hostState = loadHostStateConfig(hostStatePath);
    meterEnv = await openers.resolveMeterEnv(configs.meter, openers.env);
  } catch (error: unknown) {
    throw toStartupError(error);
  }
  const github = await checkGitHub(loop.github, openers.env, openers.openGitHub);
  await checkAuditSettlesInGrace(loop.shutdownGraceMs, configs.auditor);
  const registryPath = resolve(configs.dispatcher.registryPath);
  const statePath = resolve(loop.statePath);
  const storePath = resolve(configs.work.storePath);
  const resultsPath = resolve(loop.resultsPath);
  const ledgerPath = resolve(configs.ledgerPath);
  const usageLogPath = resolve(configs.meter.usageLogPath);
  const verdictDir = resolve(configs.auditor.verdictDir);
  const digestDir = resolve(loop.digest.dir);
  const scratchDir = resolve(loop.trialMerge.scratchDir);
  const configDir = resolve(loop.github.configDir);
  try {
    await requireWritableTarget("loop state", statePath);
    await requireWritableTarget("loop log", resolve(loop.logPath));
    await requireWritableTarget("results", resultsPath);
    await requireWritableTarget("work store", storePath);
    await requireWritableTarget("ledger", ledgerPath);
    await requireWritableTarget("registry", registryPath);
    await requireWritableTarget("meter usage log", usageLogPath);
    await requireOwnedDir("verdictDir", verdictDir);
    await requireOwnedDir("digest.dir", digestDir);
    await requireOwnedDir("trialMerge.scratchDir", scratchDir);
    await requireOwnedDir("github.configDir", configDir);
    await requireInputDir("verdictDir", verdictDir);
    await requireInputDir("digest.dir", digestDir);
    await requireInputDir("trialMerge.scratchDir", scratchDir);
    await requireInputDir("github.configDir", configDir);
    for (const repo of loop.repos) {
      await requireInputDir(`checkout missing for ${repo.repo}`, resolve(repo.checkoutDir));
    }
  } catch (error: unknown) {
    throw toStartupError(error);
  }
  return withRegistryLock(registryPath, async () => {
    const closers: Closer[] = [];
    try {
      return await runInside(deps, configs, adapter, hostState, meterEnv, github, closers);
    } finally {
      await closeAll(closers, deps.warn);
    }
  });
}

async function runInside(
  deps: ProductionRunDeps,
  configs: LoopConfigs,
  adapter: PohunekAdapterConfig,
  hostState: HostStateConfig,
  meterEnv: MeterEnv,
  github: GitHubPort,
  closers: Closer[],
): Promise<0 | 1> {
  const { openers } = deps;
  const loop = configs.loop;
  let running = false;
  let started: Scheduler | null = null;
  try {
    const log = await openLoopLog(loop.logPath, () => new Date());
    closers.push({ name: "loop-log", close: () => log.close() });
    log.log({ event: "factory-start" });
    const portsLog = await openCallLog(join(dirname(resolve(loop.logPath)), "loop-ports.jsonl"));
    closers.push({ name: "ports-log", close: () => portsLog.close() });
    const portsState: { failed: boolean } = { failed: false };
    const append = (
      source: "meter" | "port" | "dispatcher" | "host-state",
      event: Record<string, unknown>,
    ): void => {
      portsLog.append({ ts: new Date().toISOString(), source, ...event }).catch(() => {
        portsState.failed = true;
      });
    };
    const meter = await startMeter({
      config: configs.meter,
      env: meterEnv,
      providers: await openers.loadProviders(),
      now: () => new Date(),
      log: (event: MeterLogEvent) => {
        append("meter", { ...(event as unknown as Record<string, unknown>) });
      },
      timers: systemTimers,
      logIo: systemUsageLogIo,
    });
    closers.push({ name: "meter", close: () => meter.close() });
    const port = await openers.openPort(
      adapter,
      (event: AdapterLogEvent) => {
        append("port", { ...(event as unknown as Record<string, unknown>) });
      },
      openers.env,
      (requestId: string) => meter.tokenFor(requestId),
    );
    closers.push({ name: "dispatch-port", close: () => port.close() });
    const hostStatePort = await openers.openHostState(
      adapter,
      hostState.package.command,
      openers.env,
    );
    closers.push({ name: "host-state-port", close: () => hostStatePort.close() });
    const budgetGate = createCliBudgetGate({
      command: [...configs.budgetGate.command],
      timeoutMs: configs.budgetGate.timeoutMs,
      cwd: process.cwd(),
      env: { PATH: requiredEnv(openers.env, "PATH"), HOME: requiredEnv(openers.env, "HOME") },
    });
    const metered = createMeteredPort(port, meter, (event: MeterLogEvent) => {
      append("port", { ...(event as unknown as Record<string, unknown>) });
    });
    const dispatcher = createDispatcher({
      port: metered,
      budget: budgetGate,
      ledgerPath: configs.ledgerPath,
      config: configs.dispatcher,
      now: () => new Date(),
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
      log: (event) => {
        append("dispatcher", { ...(event as unknown as Record<string, unknown>) });
      },
      settleUsage: (requestId, state) => meter.settleRequest(requestId, state),
    });
    const collector = createCollector({
      port: hostStatePort,
      config: hostState,
      now: () => new Date(),
      sleep: (ms: number, signal: AbortSignal) =>
        new Promise<void>((done) => {
          if (signal.aborted) {
            done();
            return;
          }
          const timer = setTimeout(done, ms);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              done();
            },
            { once: true },
          );
        }),
      log: (event: HostStateLogEvent) => {
        append("host-state", { ...(event as unknown as Record<string, unknown>) });
      },
    });
    const ctx = schedulerContextOf(configs, {
      github,
      dispatcher,
      collector,
      auditBudget: budgetGate,
      auditCall: openers.auditCall,
      log,
      now: () => new Date(),
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
      home: requiredEnv(openers.env, "HOME"),
      gitPath: requiredEnv(openers.env, "PATH"),
      providersDir: PROVIDERS_DIR,
    });
    await recoverAtStartup(ctx);
    const state = await readLoopState(loop.statePath);
    let active = 0;
    for (const item of Object.values(state.items)) {
      if (item.phase !== "idle" && item.phase !== "final") {
        active += 1;
      }
    }
    deps.out(`loop: running (${String(active)} active)`);
    const scheduler = createScheduler(ctx);
    started = scheduler;
    running = true;
    deps.stop.onStop(() => {
      scheduler.stop();
    });
    for (;;) {
      if (deps.stop.stopping()) {
        break;
      }
      await scheduler.tick();
      if (portsState.failed) {
        throw new Error("ports log failed");
      }
      if (log.failed()) {
        throw new Error("loop log failed");
      }
      await deps.stop.sleep(loop.tickMs);
    }
    await stopScheduler(scheduler, loop.shutdownGraceMs);
    log.log({ event: "factory-stop" });
    return 0;
  } catch (error: unknown) {
    if (!running) {
      throw toStartupError(error);
    }
    if (started !== null) {
      await stopScheduler(started, loop.shutdownGraceMs).catch(() => undefined);
    }
    throw error;
  }
}

// Shared loop composition: config loading, the registry lock, the
// closers and the scheduler context the production mode reuses.
import { loadApprovalsConfig, type ApprovalsConfig } from "../approvals/config.js";
import { createApprovalsView, type ApprovalsView } from "./approvals-view.js";
import { loadAuditorConfig, type AuditorConfig } from "../auditor/config.js";
import type { AuditDeps } from "../auditor/audit-types.js";
import { loadBudgetConfig } from "../budget/config.js";
import { loadBudgetGateConfig } from "../budget/gate.js";
import { loadDispatcherConfig, type DispatcherConfig } from "../dispatcher/config.js";
import { FileLockError, withFileLock } from "../fs/lock.js";
import { loadLedgerConfig } from "../ledger/read.js";
import { createMergeMutex, type MergeMutex } from "./merge.js";
import { loadMeterConfig, type MeterConfig } from "../meter/config.js";
import { loadPlacementConfig, type PlacementConfig } from "../placement/config.js";
import type { GitHubPort } from "./github.js";
import type { GitDeps } from "./git.js";
import type { HostStateCollector } from "../hoststate/collector.js";
import type { Scheduler, SchedulerContext } from "./scheduler.js";
import { loadWorkConfig, type WorkConfig } from "../work/config.js";
import { loadFactorySpecs } from "../work/specs.js";
import { loadLoopConfig, type LoopConfig, type LoopMode } from "./config.js";
import type { LoopLog } from "./log.js";
import type { StartDispatcher } from "./start.js";

export class LoopStartupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopStartupError";
  }
}

export interface LoopConfigs {
  readonly loop: LoopConfig;
  readonly work: WorkConfig;
  readonly specs: readonly import("../../contracts/v1/types.js").FactorySpec[];
  readonly dispatcher: DispatcherConfig;
  readonly auditor: AuditorConfig;
  readonly ledgerPath: string;
  readonly budgetGate: { readonly command: readonly string[]; readonly timeoutMs: number };
  readonly placement: PlacementConfig;
  readonly approvals: ApprovalsConfig;
  readonly meter: MeterConfig;
  readonly nvidiaProviderId: string;
}

export async function loadLoopConfigs(path: string, mode: LoopMode): Promise<LoopConfigs> {
  let loop: LoopConfig;
  try {
    loop = await loadLoopConfig(path, mode);
  } catch (error: unknown) {
    throw new LoopStartupError(loopMessage(path, error), { cause: error });
  }
  try {
    const work = await loadWorkConfig(loop.workConfigPath);
    const [specs, dispatcher, auditor, ledger, budgetGate, placement, approvals, meter, budget] =
      await Promise.all([
        loadFactorySpecs(work.factorySpecsPath),
        loadDispatcherConfig(loop.dispatcherConfigPath),
        loadAuditorConfig(loop.auditorConfigPath),
        loadLedgerConfig(loop.ledgerConfigPath),
        loadBudgetGateConfig(loop.budgetGateConfigPath),
        loadPlacementConfig(loop.placementConfigPath),
        loadApprovalsConfig(loop.approvalsConfigPath),
        loadMeterConfig(loop.meterConfigPath),
        loadBudgetConfig(),
      ]);
    return {
      loop,
      work,
      specs,
      dispatcher,
      auditor,
      ledgerPath: ledger.ledgerPath,
      budgetGate,
      placement,
      approvals,
      meter,
      nvidiaProviderId: budget.nvidiaProviderId,
    };
  } catch (error: unknown) {
    throw new LoopStartupError(loopMessage(path, error), { cause: error });
  }
}

function loopMessage(path: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${path}: ${detail}`;
}

export function toStartupError(error: unknown): LoopStartupError {
  if (error instanceof LoopStartupError) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new LoopStartupError(detail, { cause: error });
}

export async function withRegistryLock<T>(
  registryPath: string,
  body: () => Promise<T>,
): Promise<T> {
  const state: { entered: boolean } = { entered: false };
  try {
    return await withFileLock("dispatcher registry", registryPath, () => {
      state.entered = true;
      return body();
    });
  } catch (error: unknown) {
    if (state.entered) {
      throw error;
    }
    if (error instanceof FileLockError && error.code === "busy") {
      throw new LoopStartupError("dispatcher registry is held by another process", {
        cause: error,
      });
    }
    throw toStartupError(error);
  }
}

export interface Closer {
  readonly name: string;
  readonly close: () => Promise<void>;
}

export async function closeAll(
  closers: readonly Closer[],
  warn: (line: string) => void,
): Promise<void> {
  for (let index = closers.length - 1; index >= 0; index -= 1) {
    const closer = closers[index] as Closer;
    try {
      await closer.close();
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      warn(`loop: close ${closer.name}: ${detail}`);
    }
  }
}

export interface LoopPorts {
  readonly github: GitHubPort;
  readonly dispatcher: StartDispatcher;
  readonly collector: HostStateCollector;
  readonly auditBudget: AuditDeps["budget"];
  readonly auditCall: AuditDeps["call"];
  readonly log: LoopLog;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly home: string;
  readonly gitPath: string;
  readonly providersDir: string;
}

export function schedulerContextOf(configs: LoopConfigs, ports: LoopPorts): SchedulerContext {
  if (configs.loop.github.factoryLogin === null) {
    throw new LoopStartupError("github.factoryLogin is not set");
  }
  const factoryLogin = configs.loop.github.factoryLogin;
  const mergeMutex: MergeMutex = createMergeMutex();
  const approvals: ApprovalsView = createApprovalsView(configs.approvals.requestsPath);
  const git: GitDeps = { PATH: ports.gitPath, timeoutMs: configs.loop.github.timeoutMs };
  return {
    branchPrefix: configs.dispatcher.branchPrefix,
    storePath: configs.work.storePath,
    statePath: configs.loop.statePath,
    resultsPath: configs.loop.resultsPath,
    stall: configs.loop.stall,
    log: ports.log,
    now: ports.now,
    collector: ports.collector,
    placementConfig: configs.placement,
    routing: configs.loop.routing,
    maxActiveItems: configs.loop.maxActiveItems,
    maxBriefBytes: configs.loop.maxBriefBytes,
    ciPollMs: configs.loop.github.ciPollMs,
    intake: configs.loop.github.intake,
    trustedAssociations: configs.loop.github.trustedAssociations,
    maxItemBytes: configs.work.maxItemBytes,
    digestDir: configs.loop.digest.dir,
    providersDir: ports.providersDir,
    nvidiaProviderId: configs.nvidiaProviderId,
    dispatcher: ports.dispatcher,
    dispatcherConfig: configs.dispatcher,
    sessionTimeoutMs: configs.loop.sessionTimeoutMs,
    unreachableRetryMs: configs.loop.unreachableRetryMs,
    budgetBackoffMs: configs.loop.budgetBackoffMs,
    maxStartRejections: configs.loop.maxStartRejections,
    sleep: ports.sleep,
    repos: configs.loop.repos,
    git,
    requiredChecks: configs.loop.github.requiredChecks,
    ciTimeoutMs: configs.loop.github.ciTimeoutMs,
    auditRetries: configs.loop.audit.retries,
    auditor: {
      config: configs.auditor,
      budget: ports.auditBudget,
      call: ports.auditCall,
    },
    specs: configs.specs,
    approvals,
    mergeRetries: configs.loop.github.mergeRetries,
    trialMerge: configs.loop.trialMerge,
    home: ports.home,
    mergeMutex,
    github: ports.github,
    factoryLogin,
    ledgerPath: configs.ledgerPath,
    escalationLabel: configs.loop.github.escalationLabel,
    readyLabel: configs.loop.github.intake.readyLabel,
    blockedLabel: configs.loop.github.intake.blockedLabel,
    maxRetries: configs.loop.stall.maxRetries,
    followupLabels: configs.loop.github.followupLabels,
    verdictDir: configs.auditor.verdictDir,
  };
}

// P5: the first SIGINT or SIGTERM stops the run, later ones are ignored.
// Handlers stop the scheduler at once, and a pending tick sleep wakes.
export interface StopSignal {
  stopping(): boolean;
  onStop(handler: () => void): void;
  sleep(ms: number): Promise<void>;
}

export function createStopSignal(): StopSignal {
  let stopped = false;
  const handlers = new Set<() => void>();
  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    const pending = [...handlers];
    handlers.clear();
    for (const handler of pending) {
      handler();
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return {
    stopping: () => stopped,
    onStop: (handler) => {
      if (stopped) {
        handler();
      } else {
        handlers.add(handler);
      }
    },
    sleep: (ms) =>
      new Promise<void>((done) => {
        if (stopped) {
          done();
          return;
        }
        const wake = (): void => {
          clearTimeout(timer);
          done();
        };
        const timer = setTimeout(() => {
          handlers.delete(wake);
          done();
        }, ms);
        handlers.add(wake);
      }),
  };
}

// Every exit path stops the scheduler before the closers run, and waits
// for its non-watch calls at most shutdownGraceMs (P5). A failure that
// settled() reports inside the window is rethrown to the caller.
export async function stopScheduler(scheduler: Scheduler, graceMs: number): Promise<void> {
  scheduler.stop();
  const settled = scheduler.settled();
  settled.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((done) => {
    timer = setTimeout(done, graceMs);
  });
  try {
    await Promise.race([settled, grace]);
  } finally {
    clearTimeout(timer);
  }
}

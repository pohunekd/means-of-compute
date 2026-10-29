// Demo stub run: the MS4/MS5 composition over the merged modules.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkItem } from "../../../contracts/v1/types.js";
import { isWorkItem } from "../../../contracts/v1/validate.js";
import type { AuditDeps } from "../../auditor/audit-types.js";
import { createCliBudgetGate } from "../../budget/gate.js";
import { utcCalendarDay } from "../../budget/cost.js";
import { closeAll, schedulerContextOf, withRegistryLock, type Closer } from "../compose.js";
import type { LoopConfigs } from "../compose.js";
import { digestFor, writeDigestFile } from "../digest.js";
import { openLoopLog } from "../log.js";
import { createDispatcher } from "../../dispatcher/dispatcher.js";
import { createMemoryPort } from "../../dispatcher/memory-port.js";
import type { GitHubPort } from "../github.js";
import { readInputText, statInputPath } from "../../fs/input.js";
import { createStubGitHub } from "./github.js";
import { createStubCollector } from "./observations.js";
import { createStubWorker } from "./worker.js";
import { prepareSandbox } from "./sandbox.js";
import { createMeteredPort } from "../../meter/metered-port.js";
import { startMeter } from "../../meter/meter.js";
import { systemTimers } from "../../meter/timers.js";
import { systemUsageLogIo } from "../../meter/usage-log.js";
import { loadProviderSchema } from "../../providers/schema.js";
import type { ProviderDescriptor } from "../../providers/types.js";
import type { ModelRequest, SingleCallResult } from "../../providers/router.js";
import { callProvider } from "../../providers/router.js";
import { startLoopback } from "../../providers/loopback.js";
import { checkItems, applySubmission } from "../../work/submit.js";
import { readWorkStore, updateWorkStore, readyItems } from "../../work/store.js";
import { readLoopState } from "../state.js";
import { requireWritableTarget } from "../../fs/write.js";
import { createScheduler, recoverAtStartup } from "../scheduler.js";
import type { LoopItem } from "../types.js";

export interface StubQueue {
  readonly items: readonly WorkItem[];
  readonly scripts: Readonly<Record<string, readonly string[]>>;
}

export interface StubRunDeps {
  readonly configs: LoopConfigs;
  readonly queuePath: string;
  readonly stopping: () => boolean;
  readonly out: (line: string) => void;
  readonly warn: (line: string) => void;
}

function readScripts(scripts: unknown, path: string): Record<string, readonly string[]> {
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error(`queue ${path}: scripts must be an object`);
  }
  const out: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error(`queue ${path}: scripts for ${id} must be a string array`);
    }
    out[id] = [...(value as string[])];
  }
  return out;
}

async function readQueue(path: string): Promise<StubQueue> {
  const text = await readFile(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`queue ${path}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`queue ${path}: must hold items and scripts`);
  }
  const record = raw as { items?: unknown; scripts?: unknown };
  if (!Array.isArray(record.items)) {
    throw new Error(`queue ${path}: items must be an array`);
  }
  for (const item of record.items) {
    if (!isWorkItem(item)) {
      throw new Error(`queue ${path}: an item fails the WorkItem contract`);
    }
  }
  return { items: record.items as WorkItem[], scripts: readScripts(record.scripts, path) };
}

// The loopback descriptors: schema-checked, baseUrl set to the loopback
// URL, no key or URL env.
async function loopbackDescriptors(
  ids: readonly string[],
  dir: string,
  url: string,
): Promise<Readonly<Record<string, ProviderDescriptor>>> {
  const schema = await loadProviderSchema();
  const descriptors: Record<string, ProviderDescriptor> = {};
  for (const id of ids) {
    const file = join(dir, `${id}.json`);
    if ((await statInputPath("Provider descriptor", file)) === "absent") {
      throw new Error(`Provider descriptor ${file}: file is missing`);
    }
    const text = await readInputText("Provider descriptor", file);
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Provider descriptor ${file}: not valid JSON`);
    }
    const errors = schema.descriptorErrors({ ...(raw as Record<string, unknown>), baseUrl: url });
    if (errors !== null) {
      throw new Error(`provider ${id}: ${errors}`);
    }
    const descriptor = raw as ProviderDescriptor;
    descriptors[id] = { ...descriptor, baseUrl: url, apiKeyEnv: undefined };
  }
  return descriptors;
}

async function observedAliases(path: string): Promise<readonly string[]> {
  const text = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("observations file must hold an array");
  }
  const aliases: string[] = [];
  for (const entry of parsed) {
    const alias = (entry as { hostAlias?: unknown }).hostAlias;
    if (typeof alias !== "string") {
      throw new Error("observations entry has no hostAlias");
    }
    aliases.push(alias);
  }
  return aliases;
}

export async function runStub(deps: StubRunDeps): Promise<0 | 1 | 3> {
  const { configs } = deps;
  const loop = configs.loop;
  if (loop.stub === null) {
    throw new Error("stub mode requires the stub config");
  }
  const sandboxDir = resolve(loop.stub.sandboxDir);
  const within = (path: string): boolean =>
    path === sandboxDir || path.startsWith(`${sandboxDir}/`);
  const registryPath = resolve(configs.dispatcher.registryPath);
  const meterLogPath = resolve(configs.meter.usageLogPath);
  const ledgerPath = resolve(configs.ledgerPath);
  const verdictDir = resolve(configs.auditor.verdictDir);
  const statePath = resolve(loop.statePath);
  const storePath = resolve(configs.work.storePath);
  const approvalsPath = resolve(configs.approvals.requestsPath);
  const resultsPath = resolve(loop.resultsPath);
  for (const [label, path] of [
    ["meter usage log", meterLogPath],
    ["ledger", ledgerPath],
    ["verdict dir", verdictDir],
    ["loop state", statePath],
    ["work store", storePath],
    ["approvals requests", approvalsPath],
  ] as const) {
    if (!within(path)) {
      throw new Error(`${label} ${path} is outside the sandbox`);
    }
  }
  if (!within(registryPath)) {
    throw new Error(`registry ${registryPath} is outside the sandbox`);
  }
  const queue = await readQueue(resolve(deps.queuePath));
  await mkdir(dirname(registryPath), { recursive: true });
  return withRegistryLock(registryPath, async () => {
    const closers: Closer[] = [];
    try {
      return await runInside(deps, configs, queue, sandboxDir, closers);
    } finally {
      await closeAll(closers, deps.warn);
    }
  });
}

async function runInside(
  deps: StubRunDeps,
  configs: LoopConfigs,
  queue: StubQueue,
  sandboxDir: string,
  closers: Closer[],
): Promise<0 | 1 | 3> {
  const loop = configs.loop;
  const stub = loop.stub;
  if (stub === null) {
    throw new Error("stub mode requires the stub config");
  }
  const registryPath = resolve(configs.dispatcher.registryPath);
  const ledgerPath = resolve(configs.ledgerPath);
  const verdictDir = resolve(configs.auditor.verdictDir);
  const statePath = resolve(loop.statePath);
  const storePath = resolve(configs.work.storePath);
  const approvalsPath = resolve(configs.approvals.requestsPath);
  const resultsPath = resolve(loop.resultsPath);
  const digestDir = resolve(loop.digest.dir);
  const scratchDir = resolve(loop.trialMerge.scratchDir);
  const configDir = resolve(loop.github.configDir);
  await prepareSandbox({
    sandboxDir,
    demoRepoDir: resolve(stub.demoRepoDir),
    registryPath,
    ownedDirs: [verdictDir, digestDir, scratchDir, configDir],
    configDir: "config",
    ledgerPath,
    git: { PATH: process.env.PATH ?? "", timeoutMs: loop.github.timeoutMs },
  });
  const refusal = checkItems(
    queue.items,
    configs.work.maxItemBytes,
    configs.work.models,
    new Set(configs.specs.map((spec) => spec.repo)),
  );
  if (refusal !== null) {
    throw new Error(`queue refused: ${refusal.code}`);
  }
  await updateWorkStore(storePath, async (store) => {
    const applied = applySubmission(
      store,
      queue.items,
      "stub",
      new Date().toISOString(),
      configs.work.maxStoreItems,
    );
    if (applied.value.kind === "refused") {
      throw new Error(`queue refused: ${applied.value.refusal.code}`);
    }
    return { next: applied.next, value: undefined };
  });
  await requireWritableTarget("loop state", statePath);
  await requireWritableTarget("work store", storePath);
  await requireWritableTarget("ledger", ledgerPath);
  await requireWritableTarget("approvals", approvalsPath);
  await requireWritableTarget("results", resultsPath);
  const log = await openLoopLog(loop.logPath, () => new Date());
  closers.push({ name: "loop-log", close: () => log.close() });
  log.log({ event: "factory-start" });
  const loopback = await startLoopback(resolve(stub.recordingsPath));
  closers.push({
    name: "loopback",
    close: () => {
      const result = loopback.stop();
      return result instanceof Promise ? result : Promise.resolve();
    },
  });
  const url = `http://127.0.0.1:${String(loopback.port)}`;
  const providerIds = new Set<string>(Object.values(loop.routing.models));
  for (const entry of configs.auditor.auditors) {
    providerIds.add(entry.providerId);
  }
  providerIds.add(configs.auditor.mergeAuditor.providerId);
  const sandboxProvidersDir = join(sandboxDir, "config", "providers");
  const descriptors = await loopbackDescriptors([...providerIds], sandboxProvidersDir, url);
  const aliases = await observedAliases(resolve(stub.observationsPath));
  const hostsPath = join(sandboxDir, "meter-hosts.json");
  const hostsFile: Record<string, readonly string[]> = {};
  const hostAddresses = new Map<string, ReadonlySet<string>>();
  for (const alias of aliases) {
    hostsFile[alias] = ["127.0.0.1"];
    hostAddresses.set(alias, new Set(["127.0.0.1"]));
  }
  await writeFile(hostsPath, `${JSON.stringify(hostsFile)}\n`, { mode: 0o600 });
  const meter = await startMeter({
    config: configs.meter,
    env: {
      listen: { host: "127.0.0.1", port: 0 },
      secret: randomBytes(32),
      hostAddresses,
      hostAddressesFile: hostsPath,
    },
    providers: descriptors,
    now: () => new Date(),
    log: () => undefined,
    timers: systemTimers,
    logIo: systemUsageLogIo,
  });
  closers.push({ name: "meter", close: () => meter.close() });
  const budgetGate = createCliBudgetGate({
    command: ["bun", resolve("src/budget/check.ts")],
    timeoutMs: configs.budgetGate.timeoutMs,
    cwd: sandboxDir,
    env: { PATH: process.env.PATH ?? "", HOME: sandboxDir },
  });
  const control = createMemoryPort();
  const memoryPort = createMeteredPort(control.port, meter, () => undefined);
  const dispatcher = createDispatcher({
    port: memoryPort,
    budget: budgetGate,
    ledgerPath,
    config: configs.dispatcher,
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    log: () => undefined,
    settleUsage: (requestId, state) => meter.settleRequest(requestId, state),
  });
  const github: GitHubPort = createStubGitHub({
    repo: configs.specs[0]?.repo ?? "example/demo-repo",
    originDir: join(sandboxDir, "origin.git"),
    baseBranch: configs.dispatcher.baseBranch,
    factoryLogin: loop.github.factoryLogin ?? "moc-demo",
    git: { PATH: process.env.PATH ?? "", timeoutMs: loop.github.timeoutMs },
    scratchDir,
    ci: () => "success",
  });
  const collector = createStubCollector(resolve(stub.observationsPath), () => new Date());
  const auditCall: AuditDeps["call"] = async (
    providerId: string,
    request: ModelRequest,
  ): Promise<SingleCallResult> => {
    const descriptor = descriptors[providerId];
    if (descriptor === undefined) {
      throw new Error(`audit: unknown provider ${providerId}`);
    }
    const result = await callProvider(descriptor, request);
    return {
      providerId: descriptor.id,
      model: descriptor.model,
      content: result.content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  };
  const ctx = schedulerContextOf(configs, {
    github,
    dispatcher,
    collector,
    auditBudget: budgetGate,
    auditCall,
    log,
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    home: sandboxDir,
    gitPath: process.env.PATH ?? "",
    providersDir: sandboxProvidersDir,
  });
  const scheduler = createScheduler(ctx);
  await recoverAtStartup(ctx);
  deps.out("loop: running (stub)");
  const worker = createStubWorker({
    control,
    meter: { port: meter.port, tokenFor: (id: string) => meter.tokenFor(id) },
    sessionModelId: configs.meter.sessionModelId,
    originDir: join(sandboxDir, "origin.git"),
    hostsDir: join(sandboxDir, "hosts"),
    git: { PATH: process.env.PATH ?? "", timeoutMs: loop.github.timeoutMs },
    patchFor: (workItemId: string, round: number) => {
      const scripts = queue.scripts[workItemId] ?? [];
      const entry = scripts[round];
      return entry === undefined ? null : resolve(entry);
    },
  });
  for (;;) {
    if (deps.stopping()) {
      break;
    }
    await scheduler.tick();
    await worker.step();
    if (log.failed()) {
      return 1;
    }
    const store = await readWorkStore(storePath);
    const state = await readLoopState(statePath);
    const active = store.items.some((entry) => {
      const li = state.items[entry.id] as unknown as LoopItem | undefined;
      return li !== undefined && li.phase !== "idle" && li.phase !== "final";
    });
    const parked = store.items.some((entry) => {
      const li = state.items[entry.id] as unknown as LoopItem | undefined;
      return (
        li !== undefined &&
        li.park !== null &&
        li.park.kind !== "operator" &&
        li.park.kind !== "blocked"
      );
    });
    const unfinished = store.items.some((entry) => {
      const li = state.items[entry.id] as unknown as LoopItem | undefined;
      return li !== undefined && li.finalize !== null && !li.finalize.done;
    });
    if (!active && readyItems(store).length === 0 && !parked && !unfinished) {
      break;
    }
    await new Promise<void>((done) => setTimeout(done, loop.tickMs));
  }
  scheduler.stop();
  await scheduler.settled();
  if (deps.stopping()) {
    return 0;
  }
  if (loop.digest.onExit) {
    const today = utcCalendarDay(new Date());
    const text = await digestFor(
      {
        statePath,
        storePath,
        resultsPath,
        ledgerPath,
        digestDir,
        providersDir: sandboxProvidersDir,
        nvidiaProviderId: configs.nvidiaProviderId,
        log,
        now: () => new Date(),
      },
      today,
    );
    await writeDigestFile(digestDir, today, text);
  }
  const finalStore = await readWorkStore(storePath);
  const finalState = await readLoopState(statePath);
  let merged = 0;
  let blocked = 0;
  let parked = 0;
  for (const entry of queue.items) {
    const li = finalState.items[entry.id] as unknown as LoopItem | undefined;
    if (li?.finalize?.result === "success") {
      merged += 1;
    } else if (li?.park?.kind === "blocked") {
      blocked += 1;
    } else {
      parked += 1;
    }
  }
  void finalStore;
  deps.out(
    `loop: stub run done merged=${String(merged)} blocked=${String(blocked)} parked=${String(parked)}`,
  );
  if (merged === queue.items.length) {
    return 0;
  }
  return 3;
}

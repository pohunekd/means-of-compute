// Coordinator runner: arg parsing, startup checks, seed, plan and watch runs.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openCallLog, type FileCallLog } from "../mcp/call-log.js";
import { ClientError, definedEnv, runClientCall } from "../mcp/client.js";
import { withFileLock, FileLockError } from "../fs/lock.js";
import { writeFileAtomic } from "../fs/write.js";
import { readInputText } from "../fs/input.js";
import {
  createCliBudgetGate,
  loadBudgetGateConfig,
  BudgetGateError,
  type Admission,
  type BudgetGate,
} from "../budget/gate.js";
import { loadWorkConfig, type WorkConfig } from "../work/config.js";
import { checkWorkStore } from "../work/store.js";
import { loadApprovalsConfig } from "../approvals/config.js";
import { loadDispatcherConfig } from "../dispatcher/config.js";
import type { MergeMode } from "../../contracts/v1/types.js";
import { loadFactorySpecs } from "../work/specs.js";
import { COORD_CONFIG_PATH, loadCoordConfig, type LoadedCoordConfig } from "./config.js";
import { museArgv, type MuseSession } from "./argv.js";
import { loadGoal, type Goal } from "./goal.js";
import { renderPlanPrompt, renderReactPrompt, type SkillText } from "./prompt.js";
import { readCoordCalls, type CoordCallEnd } from "./calls.js";
import {
  buildReport,
  parseListSnapshot,
  renderReportMd,
  type FinalSnapshot,
  type Report,
  type ReportGate,
  type ReportSession,
} from "./report.js";
import {
  checkSessionEnv,
  prepareSessionDirs,
  runMuseSession,
  type MuseSessionResult,
} from "./session.js";
import {
  attentionOf,
  auditTargets,
  isGoalTerminal,
  parseFleet,
  parseVerdicts,
  parseWatchRows,
  scopeRows,
  type WatchContext,
  type WatchRow,
} from "./watch.js";
import { readSurface, runSurfaceProbe, type SurfaceVerdict } from "./surface.js";

type Phase = "plan" | "watch" | "full";

interface PlanArgs {
  readonly goalPath: string;
  readonly phase: Phase;
  readonly configPath: string;
  readonly dryRun: boolean;
}

function failPrefix(message: string): string {
  return message.startsWith("coord: ") ? message : `coord: ${message}`;
}

function parseArgs(argv: readonly string[]): PlanArgs {
  let goalPath: string | null = null;
  let phase: string | null = null;
  let configPath: string | null = null;
  let dryRun = false;
  let goalCount = 0;
  let phaseCount = 0;
  let configCount = 0;
  let dryRunCount = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--goal") {
      goalCount += 1;
      if (goalCount > 1) {
        throw new Error("coord: --goal given more than once");
      }
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("coord: --goal needs a value");
      }
      goalPath = value;
      i += 1;
    } else if (arg === "--phase") {
      phaseCount += 1;
      if (phaseCount > 1) {
        throw new Error("coord: --phase given more than once");
      }
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("coord: --phase needs a value");
      }
      phase = value;
      i += 1;
    } else if (arg === "--config") {
      configCount += 1;
      if (configCount > 1) {
        throw new Error("coord: --config given more than once");
      }
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("coord: --config needs a value");
      }
      configPath = value;
      i += 1;
    } else if (arg === "--dry-run") {
      dryRunCount += 1;
      if (dryRunCount > 1) {
        throw new Error("coord: --dry-run given more than once");
      }
      dryRun = true;
    } else {
      throw new Error(`coord: unknown argument ${arg}`);
    }
  }
  if (goalPath === null) {
    throw new Error("coord: --goal is required");
  }
  if (phase === null) {
    throw new Error("coord: --phase is required");
  }
  if (phase !== "plan" && phase !== "watch" && phase !== "full") {
    throw new Error("coord: --phase must be plan, watch or full");
  }
  if (dryRun && phase !== "plan" && phase !== "full") {
    throw new Error("coord: --dry-run needs --phase plan or full");
  }
  return {
    goalPath,
    phase,
    configPath: configPath ?? COORD_CONFIG_PATH,
    dryRun,
  };
}

interface SessionRecord {
  readonly runId: string;
  readonly k: number;
  readonly pid: number;
}

function parseSessionRecord(text: string): SessionRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3) {
    return null;
  }
  const runId = record["runId"];
  const k = record["k"];
  const pid = record["pid"];
  if (typeof runId !== "string") {
    return null;
  }
  if (typeof k !== "number" || !Number.isInteger(k) || k < 1) {
    return null;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) {
    return null;
  }
  return { runId, k, pid };
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function checkSessionRecord(recordPath: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(recordPath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const parsed = parseSessionRecord(text);
  if (parsed === null) {
    throw new Error(`coord: ${recordPath} is not a valid session record`);
  }
  if (!processGroupAlive(parsed.pid)) {
    await rm(recordPath, { force: true });
    process.stderr.write(
      `coord: session ${String(parsed.k)} of run ${parsed.runId} ended without its launcher\n`,
    );
    return;
  }
  throw new Error(
    `coord: session ${String(parsed.k)} of run ${parsed.runId} may still be running (process group ${String(parsed.pid)}); stop it, then remove ${recordPath}`,
  );
}

function runIdTimestamp(date: Date): { readonly day: string; readonly stamp: string } {
  const iso = date.toISOString();
  const day = iso.slice(0, 10).replaceAll("-", "");
  const stamp = `${day}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return { day, stamp };
}

async function countRunsToday(runsDir: string, day: string): Promise<number> {
  const entries = await readdir(runsDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.startsWith(day)) {
      continue;
    }
    if (entry.name.endsWith("-dry")) {
      continue;
    }
    count += 1;
  }
  return count;
}

async function loadGoalPrecondition(
  mcpConfigPath: string,
  serverVersion: string,
  clientTimeoutMs: number,
  goalId: string,
  idPrefix: string,
  env: Record<string, string>,
  phase: Phase,
): Promise<FinalSnapshot> {
  let payload: unknown;
  try {
    payload = await runClientCall({
      tool: "list_work",
      args: { status: ["queued", "running", "review", "parked", "blocked", "done"] },
      configPath: mcpConfigPath,
      serverVersion,
      clientTimeoutMs,
      env,
    });
  } catch (error: unknown) {
    if (error instanceof ClientError) {
      return { ok: false, code: "client-error" };
    }
    throw error;
  }
  const snapshot = parseListSnapshot(payload);
  if (!snapshot.ok) {
    return snapshot;
  }
  if (phase === "watch") {
    const found = snapshot.snapshot.items.some((row) => row.id.startsWith(`${idPrefix}-`));
    if (!found) {
      throw new Error(`coord: no items with prefix ${idPrefix}-`);
    }
    return snapshot;
  }
  for (const row of snapshot.snapshot.items) {
    if (row.id.startsWith(`${idPrefix}-`)) {
      throw new Error(`coord: goal ${goalId} already planned (ids with prefix ${idPrefix}- exist)`);
    }
  }
  return snapshot;
}

async function run(argv: readonly string[]): Promise<number> {
  let parsed: PlanArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error: unknown) {
    process.stderr.write(`${failPrefix((error as Error).message)}\n`);
    return 2;
  }
  try {
    return await runStartup(parsed);
  } catch (error: unknown) {
    process.stderr.write(`${failPrefix((error as Error).message)}\n`);
    return 2;
  }
}

interface Startup {
  readonly config: LoadedCoordConfig["config"];
  readonly loaded: LoadedCoordConfig;
  readonly goal: Goal;
  readonly mergeMode: MergeMode;
  readonly workConfig: WorkConfig;
  readonly gate: BudgetGate | null;
  readonly key: string | null;
  readonly childEnv: Record<string, string>;
}

async function seedStateDir(
  config: LoadedCoordConfig["config"],
  mcp: LoadedCoordConfig["mcp"],
  workConfig: WorkConfig,
): Promise<void> {
  const seed = config.seed;
  if (seed === null) {
    return;
  }
  const approvals = await loadApprovalsConfig(mcp.approvalsConfigPath);
  const dispatcher = await loadDispatcherConfig(mcp.dispatcherConfigPath);
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["storePath", workConfig.storePath],
    ["requestsPath", approvals.requestsPath],
    ["registryPath", dispatcher.registryPath],
    ["callLogPath", mcp.callLogPath],
  ];
  const stateDir = resolve(seed.stateDir);
  for (const [key, path] of pairs) {
    if (!(resolve(path) + "/").startsWith(`${stateDir}/`)) {
      throw new Error(`coord: seed ${key} ${path} is outside ${seed.stateDir}`);
    }
  }
  const resolvedRunsDir = resolve(config.runsDir);
  if (resolvedRunsDir === stateDir || resolvedRunsDir.startsWith(`${stateDir}/`)) {
    throw new Error("coord: runsDir is inside seed stateDir");
  }
  let seedText: string | null = null;
  if (seed.storeSeedPath !== null) {
    const text = await readInputText("Seed store", seed.storeSeedPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`coord: seed storeSeedPath ${seed.storeSeedPath} is not valid JSON`);
    }
    checkWorkStore(parsed, seed.storeSeedPath);
    seedText = text;
  }
  let markerMissing = false;
  try {
    await stat(join(stateDir, ".coord-demo"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      let exists = false;
      try {
        await stat(stateDir);
        exists = true;
      } catch (inner: unknown) {
        if ((inner as NodeJS.ErrnoException).code !== "ENOENT") {
          throw inner;
        }
      }
      if (exists) {
        markerMissing = true;
      }
    } else {
      throw error;
    }
  }
  if (markerMissing) {
    throw new Error(`coord: ${seed.stateDir} is not a coordinator demo dir`);
  }
  await rm(stateDir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFileAtomic("Seed marker", join(stateDir, ".coord-demo"), "coordinator demo dir\n");
  if (seedText !== null) {
    await writeFileAtomic("Seed store", workConfig.storePath, seedText);
  }
}

async function runStartup(args: PlanArgs): Promise<number> {
  const checkoutText = await readInputText("Checkout", join(process.cwd(), "package.json"));
  let checkout: unknown;
  try {
    checkout = JSON.parse(checkoutText) as unknown;
  } catch {
    throw new Error(`coord: ${process.cwd()} is not a means-of-compute checkout`);
  }
  if (
    typeof checkout !== "object" ||
    checkout === null ||
    Array.isArray(checkout) ||
    (checkout as Record<string, unknown>)["name"] !== "means-of-compute"
  ) {
    throw new Error(`coord: ${process.cwd()} is not a means-of-compute checkout`);
  }
  const loaded: LoadedCoordConfig = await loadCoordConfig(args.configPath);
  const { config, apiKeyEnv, mcp } = loaded;
  let key: string | null = null;
  let childEnv: Record<string, string> = {};
  if (!args.dryRun) {
    checkSessionEnv(config.envPassthrough, apiKeyEnv, process.env);
    key = process.env[apiKeyEnv] as string;
    // Bun.spawn without env inherits the launch environment, so the cleaned
    // environment is copied explicitly for every child except Muse.
    childEnv = definedEnv(process.env);
    Reflect.deleteProperty(childEnv, apiKeyEnv);
  }
  const workConfig = await loadWorkConfig(mcp.workConfigPath);
  const specs = await loadFactorySpecs(workConfig.factorySpecsPath);
  const goal: Goal = await loadGoal(args.goalPath, {
    maxOutcomeChars: config.maxOutcomeChars,
    workConfig,
    specs,
  });
  // loadGoal rejects a repo with no factory spec, so the find below always
  // returns an entry.
  const spec = specs.find((entry) => entry.repo === goal.repo) as { readonly mergeMode: MergeMode };
  let gate: BudgetGate | null = null;
  if (!args.dryRun) {
    const gateConfig = await loadBudgetGateConfig(config.budgetGateConfigPath);
    gate = createCliBudgetGate({ ...gateConfig, cwd: process.cwd(), env: childEnv });
  }
  await mkdir(config.runsDir, { recursive: true, mode: 0o700 });
  // The key leaves process.env before the first child spawn below.
  if (!args.dryRun) {
    Reflect.deleteProperty(process.env, apiKeyEnv);
  }
  const startup: Startup = {
    config,
    loaded,
    goal,
    mergeMode: spec.mergeMode,
    workConfig,
    gate,
    key,
    childEnv,
  };
  try {
    return await withFileLock("coordinator runs", join(config.runsDir, "coordinator"), () =>
      runFromStep13(startup, args),
    );
  } catch (error: unknown) {
    if (error instanceof FileLockError && error.code === "busy") {
      throw new Error("coord: another coordinator run is active", { cause: error });
    }
    if (error instanceof FileLockError && error.code === "release-failed") {
      process.stderr.write(`coord: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function runFromStep13(startup: Startup, args: PlanArgs): Promise<number> {
  const { config, loaded, goal, gate, key } = startup;
  const { mcp, skill } = loaded;
  const recordPath = join(config.runsDir, "coordinator-session.json");
  await checkSessionRecord(recordPath);
  const t0 = new Date();
  const { day, stamp } = runIdTimestamp(t0);
  if (!args.dryRun) {
    const count = await countRunsToday(config.runsDir, day);
    if (count >= config.maxRunsPerDay) {
      process.stderr.write(`coord: run-cap ${String(count)} runs today\n`);
      return 3;
    }
    await seedStateDir(config, mcp, startup.workConfig);
    const pre = await loadGoalPrecondition(
      config.mcpConfigPath,
      mcp.serverInfo.version,
      mcp.clientTimeoutMs,
      goal.goalId,
      goal.idPrefix,
      startup.childEnv,
      args.phase === "watch" ? "watch" : "plan",
    );
    if (!pre.ok) {
      throw new Error(`coord: goal ${goal.goalId} precondition failed (${pre.code})`);
    }
  }
  // From step 13 on, every failure prints one coord line and exits 1 by
  // construction: only throws from steps 1 to 12 reach run's rc 2 mapping.
  try {
    const suffix = randomBytes(3).toString("hex");
    const runId = `${stamp}-${goal.goalId}-${suffix}${args.dryRun ? "-dry" : ""}`;
    const runDir = resolve(config.runsDir, runId);
    await mkdir(runDir, { mode: 0o700 });
    await writeFileAtomic(
      "Run mcp config",
      join(runDir, "mcp.json"),
      `${JSON.stringify({ ...mcp, callLogPath: join(runDir, "mcp-calls.jsonl") }, null, 2)}\n`,
    );
    await prepareSessionDirs(runDir);
    const session: MuseSession = {
      kind: "plan",
      k: 1,
      sessionId: randomUUID(),
      runDir,
      checkoutDir: process.cwd(),
      bunPath: process.execPath,
    };
    if (args.phase !== "watch") {
      await writeFileAtomic(
        "Plan prompt",
        join(runDir, "prompt-1.md"),
        renderPlanPrompt({
          skill,
          goal,
          runId,
          mergeMode: startup.mergeMode,
          limits: { maxSubmitAttempts: config.plan.maxSubmitAttempts },
        }),
      );
    }
    if (args.dryRun) {
      const line = JSON.stringify({
        runDir,
        cwd: join(runDir, "workspace"),
        argv: museArgv(config, session),
        phase: args.phase,
        covers: "plan",
      });
      process.stdout.write(`${line}\n`);
      return 0;
    }
    if (gate === null || key === null) {
      throw new Error("coord: unreachable dry-run gate");
    }
    return await runSession(
      config,
      startup.loaded,
      goal,
      startup.mergeMode,
      args,
      runId,
      runDir,
      session,
      recordPath,
      t0,
      gate,
      key,
      startup.childEnv,
    );
  } catch (error: unknown) {
    process.stderr.write(`${failPrefix((error as Error).message)}\n`);
    return 1;
  }
}

interface RunCtx {
  readonly config: LoadedCoordConfig["config"];
  readonly loaded: LoadedCoordConfig;
  readonly goal: Goal;
  readonly skill: SkillText;
  readonly runId: string;
  readonly runDir: string;
  readonly recordPath: string;
  readonly gate: BudgetGate;
  readonly key: string;
  readonly childEnv: Record<string, string>;
  readonly log: FileCallLog;
  readonly controller: AbortController;
  readonly gates: ReportGate[];
  readonly sessions: ReportSession[];
  readonly results: Map<number, MuseSessionResult>;
  readonly consumed: Set<string>;
}

async function sessionStep(
  ctx: RunCtx,
  kind: "plan" | "react",
  k: number,
  attentionKeys: readonly string[],
): Promise<string | null> {
  const { config, loaded, runId, runDir, recordPath, gate } = ctx;
  const { apiKeyEnv } = loaded;
  const log = ctx.log;
  const wasAborted = (): boolean => ctx.controller.signal.aborted;
  if (wasAborted()) {
    return "signal";
  }
  {
    let admit = false;
    let reason: string | null = null;
    try {
      const admission: Admission = await gate.admit();
      if (admission.admit) {
        admit = true;
      } else {
        reason = admission.reason;
      }
    } catch (error: unknown) {
      if (error instanceof BudgetGateError) {
        reason = "budget-gate-error";
      } else {
        throw error;
      }
    }
    ctx.gates.push({ k, admit, reason: admit ? null : reason });
    await log.append({
      ts: new Date().toISOString(),
      event: "gate",
      k,
      admit,
      reason: admit ? null : reason,
    });
    if (!admit) {
      return "budget-refused";
    }
  }
  if (wasAborted()) {
    return "signal";
  }
  const probeBase: MuseSession = {
    kind,
    k,
    sessionId: randomUUID(),
    runDir,
    checkoutDir: process.cwd(),
    bunPath: process.execPath,
  };
  const probe = await runSurfaceProbe(
    { config, session: probeBase, signal: ctx.controller.signal },
    { env: ctx.childEnv },
  );
  if (probe.kind === "checked") {
    const verdict = probe.verdict;
    await log.append({
      ts: new Date().toISOString(),
      event: "surface",
      k,
      stage: "probe",
      ok: verdict.ok,
      reason: verdict.ok ? null : verdict.reason,
      extra: verdict.ok ? [] : verdict.extra,
      missing: verdict.ok ? [] : verdict.missing,
    });
    if (!verdict.ok) {
      return "tool-surface";
    }
  } else if (probe.kind === "probe-failed") {
    await log.append({
      ts: new Date().toISOString(),
      event: "surface",
      k,
      stage: "probe",
      ok: false,
      reason: probe.reason,
      extra: [],
      missing: [],
    });
    return "tool-surface";
  } else if (probe.kind === "spawn-failed") {
    await log.append({
      ts: new Date().toISOString(),
      event: "surface",
      k,
      stage: "probe",
      ok: false,
      reason: "probe-spawn",
      extra: [],
      missing: [],
    });
    return "muse-unavailable";
  } else {
    return "signal";
  }
  const sessionAborted = (): boolean => ctx.controller.signal.aborted;
  if (sessionAborted()) {
    return "signal";
  }
  const session: MuseSession = {
    kind,
    k,
    sessionId: randomUUID(),
    runDir,
    checkoutDir: process.cwd(),
    bunPath: process.execPath,
  };
  const onSpawn = (pid: number): void => {
    writeFileSync(recordPath, `${JSON.stringify({ runId, k, pid })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  };
  const timeoutMs = kind === "plan" ? config.plan.timeoutMs : config.react.timeoutMs;
  const result = await runMuseSession(
    {
      config,
      session,
      apiKeyEnv,
      timeoutMs,
      killGraceMs: config.killGraceMs,
      signal: ctx.controller.signal,
    },
    { env: { ...process.env, [apiKeyEnv]: ctx.key }, log, now: () => new Date(), onSpawn },
  );
  await rm(recordPath, { force: true });
  ctx.sessions.push({
    k,
    kind,
    sessionId: session.sessionId,
    outcome: result.outcome,
    durationMs: result.durationMs,
    exportOk: result.exportOk,
    attentionKeys: [...attentionKeys],
  });
  ctx.results.set(k, result);
  let surfaceOk = true;
  if (result.outcome.kind !== "spawn-failed") {
    const verdict: SurfaceVerdict = result.exportOk
      ? await readSurface(join(runDir, `session-${String(k)}-export.json`))
      : { ok: false, reason: "unreadable", extra: [], missing: [] };
    await log.append({
      ts: new Date().toISOString(),
      event: "surface",
      k,
      stage: "session",
      ok: verdict.ok,
      reason: verdict.ok ? null : verdict.reason,
      extra: verdict.ok ? [] : verdict.extra,
      missing: verdict.ok ? [] : verdict.missing,
    });
    surfaceOk = verdict.ok;
  }
  if (result.outcome.kind === "spawn-failed") {
    return "muse-unavailable";
  }
  if (result.outcome.kind === "aborted") {
    return "signal";
  }
  if (!surfaceOk) {
    return "tool-surface";
  }
  return null;
}

async function watchLoop(ctx: RunCtx, firstK: number, mergeMode: MergeMode): Promise<string> {
  const { config, loaded, goal } = ctx;
  const { mcp } = loaded;
  const watch = config.watch;
  const t0 = Date.now();
  const consumed = ctx.consumed;
  let reactSessions = 0;
  let failedInRow = 0;
  let pollErrors = 0;
  let k = firstK;
  const workConfig = await loadWorkConfig(mcp.workConfigPath);
  const specs = await loadFactorySpecs(workConfig.factorySpecsPath);
  const mergeModes = new Map(specs.map((entry) => [entry.repo, entry.mergeMode] as const));
  const goalId = goal.goalId;
  const idPrefix = goal.idPrefix;
  const callerEnv = ctx.childEnv;
  const runMcpPath = join(ctx.runDir, "mcp.json");
  const readFiledFollowups = async (): Promise<number> => {
    const calls = (await readCoordCalls(join(ctx.runDir, "mcp-calls.jsonl"))) ?? [];
    const seen = new Set<string>();
    for (const call of calls) {
      if (call.caller !== "coordinator" || call.tool !== "submit_work" || call.outcome !== "ok") {
        continue;
      }
      const summary = call.summary;
      if (summary === null) {
        continue;
      }
      const itemIds: unknown = (summary as Record<string, unknown>)["itemIds"];
      if (!Array.isArray(itemIds)) {
        continue;
      }
      for (const id of itemIds) {
        if (typeof id === "string" && id.endsWith("-fu")) {
          seen.add(id);
        }
      }
    }
    return seen.size;
  };
  for (;;) {
    if (ctx.controller.signal.aborted) {
      return "signal";
    }
    if (Date.now() - t0 >= watch.deadlineMs) {
      return "deadline";
    }
    let rows: readonly WatchRow[];
    let revision = 0;
    let fleet: { readonly paused: boolean; readonly pendingTools: readonly string[] };
    const verdicts = new Map<
      string,
      readonly {
        readonly headSha: string;
        readonly pullNumber: number | null;
        readonly auditorModel: string;
        readonly counts: { readonly high: number; readonly medium: number; readonly low: number };
      }[]
    >();
    try {
      const rowsPayload = await runClientCall({
        tool: "list_work",
        args: { status: ["queued", "running", "review", "parked", "blocked", "done"] },
        configPath: runMcpPath,
        serverVersion: mcp.serverInfo.version,
        clientTimeoutMs: mcp.clientTimeoutMs,
        env: callerEnv,
      });
      const rowsParsed = parseWatchRows(rowsPayload);
      if (!rowsParsed.ok) {
        throw new Error(rowsParsed.code);
      }
      rows = rowsParsed.value.rows;
      revision = rowsParsed.value.revision;
      const fleetPayload = await runClientCall({
        tool: "fleet_status",
        args: {},
        configPath: runMcpPath,
        serverVersion: mcp.serverInfo.version,
        clientTimeoutMs: mcp.clientTimeoutMs,
        env: callerEnv,
      });
      const fleetParsed = parseFleet(fleetPayload);
      if (!fleetParsed.ok) {
        throw new Error(fleetParsed.code);
      }
      fleet = fleetParsed.value;
      const followupsFiled = await readFiledFollowups();
      const watchCtx: WatchContext = {
        goalId,
        idPrefix,
        mergeModes,
        maxFollowupsPerRun: watch.maxFollowupsPerRun,
        pauseRequestBlockedItems: watch.pauseRequestBlockedItems,
        followupsFiled,
        consumed,
      };
      for (const id of auditTargets(rows, watchCtx)) {
        const verdictPayload = await runClientCall({
          tool: "audit_results",
          args: { workItemId: id },
          configPath: runMcpPath,
          serverVersion: mcp.serverInfo.version,
          clientTimeoutMs: mcp.clientTimeoutMs,
          env: callerEnv,
        });
        const verdictsParsed = parseVerdicts(verdictPayload);
        if (!verdictsParsed.ok) {
          throw new Error(verdictsParsed.code);
        }
        verdicts.set(id, verdictsParsed.value);
      }
      pollErrors = 0;
    } catch (error: unknown) {
      const code = error instanceof ClientError ? "client-error" : "client-error";
      const tool = "list_work";
      pollErrors += 1;
      await ctx.log.append({
        ts: new Date().toISOString(),
        event: "poll-error",
        revision,
        tool,
        code,
      });
      if (pollErrors >= watch.maxPollErrors) {
        return "factory-unreadable";
      }
      await new Promise<void>((done) => {
        const t = setTimeout(done, watch.pollMs);
        ctx.controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            done();
          },
          { once: true },
        );
      });
      continue;
    }
    const followupsFiled = await readFiledFollowups();
    const watchCtx: WatchContext = {
      goalId,
      idPrefix,
      mergeModes,
      maxFollowupsPerRun: watch.maxFollowupsPerRun,
      pauseRequestBlockedItems: watch.pauseRequestBlockedItems,
      followupsFiled,
      consumed,
    };
    const attention = attentionOf({ rows, verdicts, fleet }, watchCtx);
    await ctx.log.append({
      ts: new Date().toISOString(),
      event: "poll",
      revision,
      scope: scopeRows(rows, idPrefix).length,
      attention: attention.length,
    });
    if (isGoalTerminal(rows, idPrefix) && attention.length === 0) {
      return "goal-terminal";
    }
    if (attention.length > 0) {
      if (reactSessions >= watch.maxReactSessions) {
        return "max-sessions";
      }
      const entries = attention.slice(0, config.react.maxEntries);
      const keys = entries.map((entry) => entry.key);
      await ctx.log.append({
        ts: new Date().toISOString(),
        event: "attention",
        k,
        keys,
      });
      await writeFileAtomic(
        `React prompt ${String(k)}`,
        join(ctx.runDir, `prompt-${String(k)}.md`),
        renderReactPrompt({
          skill: ctx.skill,
          goal,
          runId: ctx.runId,
          mergeMode,
          attention: entries,
          limits: { maxSubmitPerEntry: config.react.maxSubmitPerEntry },
        }),
      );
      const outcome = await sessionStep(ctx, "react", k, keys);
      for (const entryKey of keys) {
        consumed.add(entryKey);
      }
      reactSessions += 1;
      if (outcome !== null) {
        return outcome;
      }
      const sessionResult = ctx.results.get(k);
      if (sessionResult !== undefined) {
        const sessionOutcome = sessionResult.outcome;
        if (
          sessionOutcome.kind === "timeout" ||
          (sessionOutcome.kind === "exited" && sessionOutcome.rc !== 0)
        ) {
          failedInRow += 1;
        } else {
          failedInRow = 0;
        }
        if (failedInRow >= watch.maxFailedSessions) {
          return "session-failed";
        }
      }
      k += 1;
    }
    await new Promise<void>((done) => {
      const t = setTimeout(done, watch.pollMs);
      ctx.controller.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          done();
        },
        { once: true },
      );
    });
  }
}

async function runSession(
  config: LoadedCoordConfig["config"],
  loaded: LoadedCoordConfig,
  goal: Goal,
  mergeMode: MergeMode,
  args: PlanArgs,
  runId: string,
  runDir: string,
  session: MuseSession,
  recordPath: string,
  t0: Date,
  gate: BudgetGate,
  key: string,
  childEnv: Record<string, string>,
): Promise<number> {
  const log = await openCallLog(join(runDir, "coord.jsonl"));
  try {
    await log.append({
      ts: new Date().toISOString(),
      event: "run-start",
      runId,
      goalId: goal.goalId,
      phase: args.phase,
      configPath: args.configPath,
      configSha256: loaded.configSha256,
    });
    const controller = new AbortController();
    const onSignal = (): void => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const gates: ReportGate[] = [];
    const sessions: ReportSession[] = [];
    const results = new Map<number, MuseSessionResult>();
    const consumed = new Set<string>();
    const ctx: RunCtx = {
      config,
      loaded,
      goal,
      skill: loaded.skill,
      runId,
      runDir,
      recordPath,
      gate,
      key,
      childEnv,
      log,
      controller,
      gates,
      sessions,
      results,
      consumed,
    };
    let stop: string | null = null;
    if (args.phase === "plan" || args.phase === "full") {
      stop = await sessionStep(ctx, "plan", 1, []);
      if (stop === null) {
        const calls = (await readCoordCalls(join(runDir, "mcp-calls.jsonl"))) ?? [];
        const okSubmit = calls.some((call) => call.tool === "submit_work" && call.outcome === "ok");
        stop = okSubmit ? "plan-done" : "no-submission";
        if (args.phase === "plan") {
          const code = await finishRun(ctx, args, runId, runDir, t0, stop);
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
          await log.close();
          return code;
        }
      } else if (args.phase === "plan") {
        const code = await finishRun(ctx, args, runId, runDir, t0, stop);
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        await log.close();
        return code;
      }
    }
    let doneStop: string | null = stop;
    if (doneStop === "plan-done" && args.phase === "full") {
      doneStop = await watchLoop(ctx, 2, mergeMode);
    } else if (args.phase === "watch" && doneStop === null) {
      doneStop = await watchLoop(ctx, 1, mergeMode);
    }
    const finalStop = doneStop === null ? "signal" : doneStop;
    const code = await finishRun(ctx, args, runId, runDir, t0, finalStop);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await log.close();
    return code;
  } catch (error: unknown) {
    try {
      await log.close();
    } catch {
      // The run already failed; closing the log must not hide the cause.
    }
    const message = (error as Error).message;
    process.stderr.write(`${failPrefix(message)}\n`);
    return 1;
  }
}

async function finishRun(
  ctx: RunCtx,
  args: PlanArgs,
  runId: string,
  runDir: string,
  t0: Date,
  stop: string,
): Promise<number> {
  const { loaded, goal } = ctx;
  const { mcp } = loaded;
  let finalSnapshot: FinalSnapshot;
  try {
    const payload = await runClientCall({
      tool: "list_work",
      args: { status: ["queued", "running", "review", "parked", "blocked", "done"] },
      configPath: join(runDir, "mcp.json"),
      serverVersion: mcp.serverInfo.version,
      clientTimeoutMs: mcp.clientTimeoutMs,
      env: ctx.childEnv,
    });
    finalSnapshot = parseListSnapshot(payload);
  } catch (error: unknown) {
    if (error instanceof ClientError) {
      finalSnapshot = { ok: false, code: "client-error" };
    } else {
      throw error;
    }
  }
  const calls: readonly CoordCallEnd[] =
    (await readCoordCalls(join(runDir, "mcp-calls.jsonl"))) ?? [];
  const consumed = [...ctx.consumed];
  const failedSnapshot = !finalSnapshot.ok;
  let report: Report;
  try {
    report = buildReport({
      runId,
      goalId: goal.goalId,
      idPrefix: goal.idPrefix,
      repo: goal.repo,
      phase: args.phase,
      stop,
      startedAt: t0.toISOString(),
      endedAt: new Date().toISOString(),
      configPath: args.configPath,
      configSha256: loaded.configSha256,
      gates: ctx.gates,
      sessions: ctx.sessions,
      calls,
      consumed,
      finalSnapshot,
    });
    await writeFileAtomic(
      "Run report",
      join(runDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFileAtomic("Run report markdown", join(runDir, "report.md"), renderReportMd(report));
    await ctx.log.append({
      ts: new Date().toISOString(),
      event: "report",
      path: join(runDir, "report.md"),
    });
    await ctx.log.append({ ts: new Date().toISOString(), event: "run-end", stop });
    const okSubmits = calls.filter(
      (call) => call.tool === "submit_work" && call.outcome === "ok",
    ).length;
    const itemsText = report.items === null ? "unknown" : String(report.items.length);
    process.stdout.write(
      `coord: run ${runId} stop=${stop} submitted=${String(okSubmits)} items=${itemsText} followups=${String(report.followups.length)} report=${join(runDir, "report.md")}\n`,
    );
    if (
      stop === "plan-done" ||
      stop === "signal" ||
      stop === "goal-terminal" ||
      stop === "deadline"
    ) {
      return failedSnapshot ? 3 : 0;
    }
    return 3;
  } catch (error: unknown) {
    const message = (error as Error).message;
    process.stderr.write(`${failPrefix(message)}\n`);
    return 1;
  }
}

process.exitCode = await run(Bun.argv.slice(2));

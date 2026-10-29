// Coordinator plan runner: arg parsing, startup checks, dry run, session.
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openCallLog } from "../mcp/call-log.js";
import { ClientError, runClientCall } from "../mcp/client.js";
import { withFileLock, FileLockError } from "../fs/lock.js";
import { writeFileAtomic } from "../fs/write.js";
import { readInputText } from "../fs/input.js";
import { createCliBudgetGate, loadBudgetGateConfig, BudgetGateError } from "../budget/gate.js";
import { loadWorkConfig } from "../work/config.js";
import { loadFactorySpecs } from "../work/specs.js";
import { COORD_CONFIG_PATH, loadCoordConfig, type LoadedCoordConfig } from "./config.js";
import { museArgv, type MuseSession } from "./argv.js";
import { loadGoal, type Goal } from "./goal.js";
import { renderPlanPrompt } from "./prompt.js";
import { readCoordCalls, type CoordCallEnd } from "./calls.js";
import { parseListSnapshot } from "./report.js";
import {
  buildReport,
  renderReportMd,
  type FinalSnapshot,
  type ReportGate,
  type ReportSession,
} from "./report.js";
import {
  checkSessionEnv,
  prepareSessionDirs,
  runMuseSession,
  type MuseSessionResult,
} from "./session.js";

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
  if (phase === "watch") {
    throw new Error("coord: --phase watch is not implemented");
  }
  if (phase === "full" && !dryRun) {
    throw new Error("coord: --phase full is not implemented");
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
): Promise<FinalSnapshot> {
  let payload: unknown;
  try {
    payload = await runClientCall({
      tool: "list_work",
      args: { status: ["queued", "running", "review", "parked", "blocked", "done"] },
      configPath: mcpConfigPath,
      serverVersion,
      clientTimeoutMs,
    });
  } catch (error: unknown) {
    if (error instanceof ClientError) {
      return { ok: false, code: "client-error" };
    }
    throw error;
  }
  const snapshot = parseListSnapshot(payload);
  if (snapshot.ok) {
    for (const row of snapshot.snapshot.items) {
      if (row.id.startsWith(`${idPrefix}-`)) {
        throw new Error(
          `coord: goal ${goalId} already planned (ids with prefix ${idPrefix}- exist)`,
        );
      }
    }
  }
  return snapshot;
}

export async function run(argv: readonly string[]): Promise<number> {
  let parsed: PlanArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error: unknown) {
    process.stderr.write(`${failPrefix((error as Error).message)}\n`);
    return 2;
  }
  try {
    return await runPlan(parsed);
  } catch (error: unknown) {
    process.stderr.write(`${failPrefix((error as Error).message)}\n`);
    const message = (error as Error).message;
    if (message.startsWith("coord: ")) {
      const startupSignals = [
        "is not a means-of-compute checkout",
        "is not a valid session record",
        "may still be running",
        "ended without its launcher",
        "already planned",
        "precondition failed",
        "run-cap",
        "another coordinator run is active",
        "seed is not implemented",
      ];
      if (startupSignals.some((signal) => message.includes(signal))) {
        return 2;
      }
    }
    return 1;
  }
}

async function runPlan(args: PlanArgs): Promise<number> {
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
  const { config, apiKeyEnv, mcp, skill } = loaded;
  if (config.seed !== null) {
    throw new Error("coord: seed is not implemented");
  }
  if (!args.dryRun) {
    checkSessionEnv(config.envPassthrough, apiKeyEnv, process.env);
  }
  const workConfig = await loadWorkConfig(loaded.mcp.workConfigPath);
  const specs = await loadFactorySpecs(workConfig.factorySpecsPath);
  const goal: Goal = await loadGoal(args.goalPath, {
    maxOutcomeChars: config.maxOutcomeChars,
    workConfig,
    specs,
  });
  const spec = specs.find((entry) => entry.repo === goal.repo);
  if (spec === undefined) {
    throw new Error(`coord: no factory spec for repo ${goal.repo}`);
  }
  const mergeMode = spec.mergeMode;
  let gate: { admit(): Promise<{ admit: boolean; reason?: string; line?: string }> } | null = null;
  if (!args.dryRun) {
    const gateConfig = await loadBudgetGateConfig(config.budgetGateConfigPath);
    gate = createCliBudgetGate({ ...gateConfig, cwd: process.cwd() });
  }
  await mkdir(config.runsDir, { recursive: true, mode: 0o700 });
  const runFn = async (): Promise<number> => {
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
      const pre = await loadGoalPrecondition(
        config.mcpConfigPath,
        mcp.serverInfo.version,
        mcp.clientTimeoutMs,
        goal.goalId,
        goal.idPrefix,
      );
      if (!pre.ok) {
        throw new Error(`coord: goal ${goal.goalId} precondition failed (${pre.code})`);
      }
    }
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
    await writeFileAtomic(
      "Plan prompt",
      join(runDir, "prompt-1.md"),
      renderPlanPrompt({
        skill,
        goal,
        runId,
        mergeMode,
        limits: { maxSubmitAttempts: config.plan.maxSubmitAttempts },
      }),
    );
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
    return runSession(
      config,
      loaded,
      goal,
      args,
      runId,
      runDir,
      session,
      recordPath,
      t0,
      gate as {
        admit(): Promise<{
          readonly admit: boolean;
          readonly reason?: string;
          readonly line?: string;
        }>;
      },
    );
  };
  try {
    return await withFileLock("coordinator runs", join(config.runsDir, "coordinator"), runFn);
  } catch (error: unknown) {
    if (error instanceof FileLockError && error.code === "busy") {
      throw new Error("coord: another coordinator run is active", { cause: error });
    }
    throw error;
  }
}

async function runSession(
  config: LoadedCoordConfig["config"],
  loaded: LoadedCoordConfig,
  goal: Goal,
  args: PlanArgs,
  runId: string,
  runDir: string,
  session: MuseSession,
  recordPath: string,
  t0: Date,
  gate: {
    admit(): Promise<{ readonly admit: boolean; readonly reason?: string; readonly line?: string }>;
  },
): Promise<number> {
  const { apiKeyEnv, mcp } = loaded;
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
    let stop: string | null = null;
    const gates: ReportGate[] = [];
    const sessions: ReportSession[] = [];
    let admissionReason: string | null = null;
    if (!controller.signal.aborted) {
      try {
        const admission = await gate.admit();
        if (admission.admit) {
          gates.push({ k: 1, admit: true, reason: null });
        } else {
          admissionReason = (admission as { readonly reason?: string }).reason ?? "unknown";
          gates.push({ k: 1, admit: false, reason: admissionReason });
          stop = "budget-refused";
        }
      } catch (error: unknown) {
        if (error instanceof BudgetGateError) {
          gates.push({ k: 1, admit: false, reason: "budget-gate-error" });
          stop = "budget-refused";
        } else {
          throw error;
        }
      }
      await log.append({
        ts: new Date().toISOString(),
        event: "gate",
        k: 1,
        admit: gates[0]?.admit ?? false,
        reason: (gates[0]?.admit ?? false) ? null : (gates[0] as ReportGate).reason,
      });
    } else {
      stop = "signal";
    }
    let result: MuseSessionResult | null = null;
    if (stop === null && !controller.signal.aborted) {
      const onSpawn = (pid: number): void => {
        writeFile(recordPath, `${JSON.stringify({ runId, k: 1, pid })}\n`, {
          flag: "wx",
          mode: 0o600,
        }).catch(() => {});
      };
      try {
        result = await runMuseSession(
          {
            config,
            session,
            apiKeyEnv,
            timeoutMs: config.plan.timeoutMs,
            killGraceMs: config.killGraceMs,
            signal: controller.signal,
          },
          { env: process.env, log, now: () => new Date(), onSpawn },
        );
      } finally {
        await rm(recordPath, { force: true });
      }
      sessions.push({
        k: 1,
        kind: "plan",
        sessionId: session.sessionId,
        outcome: result.outcome,
        durationMs: result.durationMs,
        exportOk: result.exportOk,
        attentionKeys: [],
      });
    } else if (stop === null) {
      stop = "signal";
    }
    let finalSnapshot: FinalSnapshot;
    try {
      const payload = await runClientCall({
        tool: "list_work",
        args: { status: ["queued", "running", "review", "parked", "blocked", "done"] },
        configPath: join(runDir, "mcp.json"),
        serverVersion: mcp.serverInfo.version,
        clientTimeoutMs: mcp.clientTimeoutMs,
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
    if (stop === null) {
      if (result !== null && result.outcome.kind === "spawn-failed") {
        stop = "muse-unavailable";
      } else if (result !== null && result.outcome.kind === "aborted") {
        stop = "signal";
      } else if (calls.some((call) => call.tool === "submit_work" && call.outcome === "ok")) {
        stop = "plan-done";
      } else {
        stop = "no-submission";
      }
    }
    const failedSnapshot = !finalSnapshot.ok;
    const report = buildReport({
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
      gates,
      sessions,
      calls,
      consumed: [],
      finalSnapshot,
    });
    await writeFileAtomic(
      "Run report",
      join(runDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFileAtomic("Run report markdown", join(runDir, "report.md"), renderReportMd(report));
    await log.append({
      ts: new Date().toISOString(),
      event: "report",
      path: join(runDir, "report.md"),
    });
    await log.append({ ts: new Date().toISOString(), event: "run-end", stop });
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await log.close();
    const okSubmits = calls.filter(
      (call) => call.tool === "submit_work" && call.outcome === "ok",
    ).length;
    const itemsText = report.items === null ? "unknown" : String(report.items.length);
    process.stdout.write(
      `coord: run ${runId} stop=${stop} submitted=${String(okSubmits)} items=${itemsText} followups=${String(report.followups.length)} report=${join(runDir, "report.md")}\n`,
    );
    if (stop === "plan-done" || stop === "signal") {
      return failedSnapshot ? 3 : 0;
    }
    return 3;
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

process.exitCode = await run(Bun.argv.slice(2));

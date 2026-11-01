// Dashboard CLI: bun run factory:serve [--ledger <path>] [--verdicts <dir>] [--registry <path>]
// [--results <path>] [--work <path>].
// Startup parses the flags, pins the clock when asked, loads every config,
// binds the loopback listener and serves until SIGINT or SIGTERM. Any
// startup failure prints "factory: <message>" and exits 2; signals exit 0.
import { loadAuditorConfig } from "../auditor/config.js";
import { loadDispatcherConfig } from "../dispatcher/config.js";
import { DEFAULT_LOOP_CONFIG_PATH, loadLoopConfig } from "../loop/config.js";
import { loadBudgetConfig } from "../budget/config.js";
import { loadPricingForIds } from "../budget/pricing.js";
import {
  loadDashboardConfig,
  readDashboardNow,
  resolveDashboardListen,
  type DashboardConfig,
} from "../dashboard/config.js";
import { createLogAppender, startDashboard, type DashboardServer } from "../dashboard/server.js";
import { requireWritableTarget } from "../fs/write.js";
import { loadLedgerConfig } from "../ledger/read.js";
import { providerDescriptorExists } from "../providers/config.js";
import { PROVIDERS_DIR, PROVIDER_ROUTE_PATH } from "../providers/paths.js";
import { loadProviderRoute } from "../providers/route.js";
import { loadWorkConfig } from "../work/config.js";

function parseServeArgs(argv: readonly string[]): {
  ledger: string | null;
  verdicts: string | null;
  registry: string | null;
  results: string | null;
  work: string | null;
} {
  let ledger: string | null = null;
  let verdicts: string | null = null;
  let registry: string | null = null;
  let results: string | null = null;
  let work: string | null = null;
  let seenLedger = false;
  let seenVerdicts = false;
  let seenRegistry = false;
  let seenResults = false;
  let seenWork = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--ledger") {
      if (seenLedger) {
        throw new Error("--ledger given twice");
      }
      seenLedger = true;
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === "") {
        throw new Error("--ledger needs a value");
      }
      if (value.startsWith("--")) {
        throw new Error("--ledger needs a value");
      }
      ledger = value;
    } else if (arg === "--verdicts") {
      if (seenVerdicts) {
        throw new Error("--verdicts given twice");
      }
      seenVerdicts = true;
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === "") {
        throw new Error("--verdicts needs a value");
      }
      if (value.startsWith("--")) {
        throw new Error("--verdicts needs a value");
      }
      verdicts = value;
    } else if (arg === "--registry") {
      if (seenRegistry) {
        throw new Error("--registry given twice");
      }
      seenRegistry = true;
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === "") {
        throw new Error("--registry needs a value");
      }
      if (value.startsWith("--")) {
        throw new Error("--registry needs a value");
      }
      registry = value;
    } else if (arg === "--results") {
      if (seenResults) {
        throw new Error("--results given twice");
      }
      seenResults = true;
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === "") {
        throw new Error("--results needs a value");
      }
      if (value.startsWith("--")) {
        throw new Error("--results needs a value");
      }
      results = value;
    } else if (arg === "--work") {
      if (seenWork) {
        throw new Error("--work given twice");
      }
      seenWork = true;
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === "") {
        throw new Error("--work needs a value");
      }
      if (value.startsWith("--")) {
        throw new Error("--work needs a value");
      }
      work = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  return { ledger, verdicts, registry, results, work };
}

async function serve(): Promise<number> {
  let flags: {
    ledger: string | null;
    verdicts: string | null;
    registry: string | null;
    results: string | null;
    work: string | null;
  };
  try {
    flags = parseServeArgs(Bun.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`factory: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let pinned: Date | null;
  try {
    pinned = readDashboardNow(process.env);
  } catch (error: unknown) {
    process.stderr.write(`factory: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (pinned !== null) {
    process.stderr.write(
      `factory: dashboard time pinned by MOC_DASHBOARD_NOW: ${pinned.toISOString()}\n`,
    );
  }
  let config: DashboardConfig;
  try {
    config = await loadDashboardConfig();
  } catch (error: unknown) {
    process.stderr.write(`factory: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let listen: { host: string; port: number };
  try {
    listen = resolveDashboardListen(config, process.env);
  } catch (error: unknown) {
    process.stderr.write(`factory: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const log = createLogAppender(config.logPath);
  try {
    await requireWritableTarget("Dashboard log", config.logPath);
  } catch (error: unknown) {
    process.stderr.write(`factory: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let ledgerPath: string;
  let verdictDir: string;
  let registryPath: string;
  let fixed: {
    budget: Awaited<ReturnType<typeof loadBudgetConfig>>;
    route: readonly string[];
    baselines: DashboardConfig["baselines"];
    workRowLimit: number;
    logPath: string;
  };
  let resultsPath: string;
  let workStorePath: string;
  try {
    const budget = await loadBudgetConfig();
    const route = await loadProviderRoute(PROVIDER_ROUTE_PATH, providerDescriptorExists);
    if (!route.includes(budget.nvidiaProviderId)) {
      throw new Error(
        `budget guard: route is missing the NVIDIA provider ${budget.nvidiaProviderId}`,
      );
    }
    await loadPricingForIds(PROVIDERS_DIR, [...route, budget.nvidiaProviderId]);
    ledgerPath = flags.ledger ?? (await loadLedgerConfig()).ledgerPath;
    verdictDir = flags.verdicts ?? (await loadAuditorConfig()).verdictDir;
    registryPath = flags.registry ?? (await loadDispatcherConfig()).registryPath;
    resultsPath =
      flags.results ?? (await loadLoopConfig(DEFAULT_LOOP_CONFIG_PATH, "production")).resultsPath;
    workStorePath = flags.work ?? (await loadWorkConfig()).storePath;
    fixed = {
      budget,
      route,
      baselines: config.baselines,
      workRowLimit: config.workRowLimit,
      logPath: config.logPath,
    };
  } catch (error: unknown) {
    process.stderr.write(`factory: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let server: DashboardServer;
  try {
    server = await startDashboard({
      config,
      listen,
      fixed,
      sources: {
        ledgerPath,
        verdictDir,
        hostState: null,
        registryPath,
        resultsPath,
        workStorePath,
      },
      now: pinned === null ? () => new Date() : () => pinned,
      log,
    });
  } catch (error: unknown) {
    process.stderr.write(`factory: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  process.stdout.write(
    `factory: dashboard listening (${config.listenAlias}) port ${String(server.port)}\n`,
  );
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await server.stop();
  return 0;
}

const status = await serve();
process.exit(status);

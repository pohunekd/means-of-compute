// Dashboard snapshot CLI: bun run dashboard:snapshot --as-of <iso> --out <file>
// [--ledger <path>] [--verdicts <dir>] [--registry <path>] [--results <path>] [--work <path>]
// [--ports <path>] [--hosts <path>].
// Renders the dashboard page once through the server's path (gatherInputs,
// buildDashboard, renderDashboard) with the clock fixed at --as-of and no
// host state round: the Fleet shows the newest host-state probe per alias
// recorded in the loop ports log at or before --as-of. It writes atomically. A usage, config or input
// error exits 2 and a privacy hit exits 3; neither writes the file.
import { loadAuditorConfig } from "../auditor/config.js";
import { loadBudgetConfig } from "../budget/config.js";
import { COORD_CONFIG_PATH, loadCoordConfig } from "../coord/config.js";
import {
  DashboardConfigError,
  loadDashboardConfig,
  readDashboardNow,
} from "../dashboard/config.js";
import { gatherInputs } from "../dashboard/inputs.js";
import { buildDashboard } from "../dashboard/model.js";
import { renderDashboard } from "../dashboard/render.js";
import { loadDispatcherConfig } from "../dispatcher/config.js";
import { readInputText, statInputPath } from "../fs/input.js";
import { writeFileAtomic } from "../fs/write.js";
import { loadLedgerConfig } from "../ledger/read.js";
import { DEFAULT_LOOP_CONFIG_PATH, loadLoopConfig, portsLogPath } from "../loop/config.js";
import { providerDescriptorExists } from "../providers/config.js";
import { PROVIDER_ROUTE_PATH } from "../providers/paths.js";
import { loadProviderRoute } from "../providers/route.js";
import { loadWorkConfig } from "../work/config.js";

const HOSTS_MAP_PATH = "config/hosts.json";

const FLAGS = [
  "--as-of",
  "--out",
  "--ledger",
  "--verdicts",
  "--registry",
  "--results",
  "--work",
  "--ports",
  "--hosts",
] as const;

type Flag = (typeof FLAGS)[number];

function isFlag(arg: string): arg is Flag {
  return (FLAGS as readonly string[]).includes(arg);
}

function parseSnapshotArgs(argv: readonly string[]): ReadonlyMap<Flag, string> {
  const flags = new Map<Flag, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!isFlag(arg)) {
      throw new Error(arg.startsWith("--") ? `unknown flag ${arg}` : `unexpected argument ${arg}`);
    }
    if (flags.has(arg)) {
      throw new Error(`${arg} given twice`);
    }
    const value = argv[index + 1];
    index += 1;
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${arg} needs a value`);
    }
    flags.set(arg, value);
  }
  for (const required of ["--as-of", "--out"] as const) {
    if (!flags.has(required)) {
      throw new Error(`${required} is required`);
    }
  }
  return flags;
}

// The host map is gitignored, so a fresh clone has none; then only the deny
// patterns guard the page. Keys that equal their alias are not private.
async function readHostNames(path: string): Promise<ReadonlyMap<string, string>> {
  if ((await statInputPath("Host map", path)) === "absent") {
    process.stderr.write(`dashboard:snapshot: host map ${path} absent, host name check skipped\n`);
    return new Map();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readInputText("Host map", path)) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`host map ${path}: not valid JSON`, { cause: error });
    }
    throw error;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`host map ${path}: must be a JSON object`);
  }
  const names = new Map<string, string>();
  for (const [hostname, alias] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof alias !== "string") {
      throw new Error(`host map ${path}: every value must be a string`);
    }
    if (hostname !== alias) {
      names.set(hostname, alias);
    }
  }
  return names;
}

// Problems name the pattern index or the alias, never the matched text. A
// host name matches case-insensitively anywhere in the page, also inside a
// longer token such as a hyphenated work item id: the page is public, so a
// false hit that blocks the snapshot is the safe failure.
function privacyProblems(
  page: string,
  denyPatterns: readonly string[],
  hostNames: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  denyPatterns.forEach((pattern, index) => {
    if (new RegExp(pattern).test(page)) {
      problems.push(`page matches deny pattern ${String(index)} of ${COORD_CONFIG_PATH}`);
    }
  });
  const lowered = page.toLowerCase();
  for (const [hostname, alias] of hostNames) {
    if (lowered.includes(hostname.toLowerCase())) {
      problems.push(`page contains the host name mapped to alias ${alias}`);
    }
  }
  return problems;
}

async function snapshot(): Promise<number> {
  const fail = (error: unknown): number => {
    process.stderr.write(
      `dashboard:snapshot: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  };
  let flags: ReadonlyMap<Flag, string>;
  try {
    flags = parseSnapshotArgs(Bun.argv.slice(2));
  } catch (error: unknown) {
    return fail(error);
  }
  // readDashboardNow holds the timestamp rule; its message names the env
  // variable, so the flag gets its own.
  let asOf: Date | null;
  try {
    asOf = readDashboardNow({ MOC_DASHBOARD_NOW: flags.get("--as-of") });
  } catch (error: unknown) {
    if (!(error instanceof DashboardConfigError)) {
      throw error;
    }
    asOf = null;
  }
  if (asOf === null) {
    return fail(new Error("--as-of must be an ISO-8601 UTC timestamp"));
  }
  let page: string;
  try {
    const config = await loadDashboardConfig();
    const budget = await loadBudgetConfig();
    const route = await loadProviderRoute(PROVIDER_ROUTE_PATH, providerDescriptorExists);
    if (!route.includes(budget.nvidiaProviderId)) {
      throw new Error(
        `budget guard: route is missing the NVIDIA provider ${budget.nvidiaProviderId}`,
      );
    }
    const denyPatterns = (await loadCoordConfig(COORD_CONFIG_PATH)).config.evidenceDenyPatterns;
    const hostNames = await readHostNames(flags.get("--hosts") ?? HOSTS_MAP_PATH);
    const sources = {
      ledgerPath: flags.get("--ledger") ?? (await loadLedgerConfig()).ledgerPath,
      verdictDir: flags.get("--verdicts") ?? (await loadAuditorConfig()).verdictDir,
      hostState: {
        kind: "log" as const,
        path:
          flags.get("--ports") ??
          portsLogPath((await loadLoopConfig(DEFAULT_LOOP_CONFIG_PATH, "production")).logPath),
      },
      registryPath: flags.get("--registry") ?? (await loadDispatcherConfig()).registryPath,
      resultsPath:
        flags.get("--results") ??
        (await loadLoopConfig(DEFAULT_LOOP_CONFIG_PATH, "production")).resultsPath,
      workStorePath: flags.get("--work") ?? (await loadWorkConfig()).storePath,
    };
    const fixed = {
      budget,
      route,
      baselines: config.baselines,
      workRowLimit: config.workRowLimit,
      logPath: config.logPath,
    };
    const inputErrors: string[] = [];
    const inputs = await gatherInputs(sources, fixed, asOf, (entry) => {
      inputErrors.push(`input ${entry.input} ${entry.code}: ${entry.message}`);
    });
    if (inputErrors.length > 0) {
      throw new Error(inputErrors.join("; "));
    }
    page = renderDashboard(buildDashboard(inputs));
    const problems = privacyProblems(page, denyPatterns, hostNames);
    if (problems.length > 0) {
      for (const problem of problems) {
        process.stderr.write(`dashboard:snapshot: ${problem}\n`);
      }
      return 3;
    }
    await writeFileAtomic("Dashboard snapshot", flags.get("--out") as string, page);
  } catch (error: unknown) {
    return fail(error);
  }
  process.stdout.write(
    `dashboard:snapshot: wrote ${flags.get("--out") as string} as of ${asOf.toISOString()}\n`,
  );
  return 0;
}

const status = await snapshot();
process.exit(status);

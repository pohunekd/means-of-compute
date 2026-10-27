// CLI entry point for the budget guard: bun run budget:check. Exit 0 on
// admit, 3 on refuse, 2 on a config or data error. Without flags the guard
// reads config/budget.json, prices from config/providers/, the route from
// config/providers/route.json and spend from the configured ledger. A
// descriptor without a pricing block is a load error; --day-cap or
// --total-cap without --spend exits 2. The --spend / --day-cap / --total-cap
// flags are a test override that injects totals into the same decision
// function; the override never writes escalation state or the escalation
// log, it only prints `would escalate: <event key>` on stderr.
import { loadBudgetConfig } from "./config.js";
import { readUsageLedger } from "./ledger.js";
import type { BudgetDecision } from "./decision.js";
import { decideAdmission } from "./decision.js";
import { capKindOfReason, eventKeyString, maybeEscalate } from "./escalation.js";
import { loadPricing } from "./pricing.js";
import { summarizeSpend } from "./cost.js";

interface CliArgs {
  readonly spendTotal: number | null;
  readonly dayCap: number | null;
  readonly totalCap: number | null;
}

async function loadRoute(routePath = "config/providers/route.json"): Promise<string[]> {
  let raw: unknown;
  try {
    raw = (await Bun.file(routePath).json()) as unknown;
  } catch {
    throw new Error(`Budget route ${routePath}: cannot read file or not valid JSON`);
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as Record<string, unknown>).providers) ||
    ((raw as Record<string, unknown>).providers as unknown[]).some(
      (entry: unknown) => typeof entry !== "string",
    )
  ) {
    throw new Error(`Budget route ${routePath}: needs a string array "providers"`);
  }
  return (raw as { providers: string[] }).providers;
}

const NUMBER_PATTERN = /^[0-9]+(\.[0-9]+)?$/;

function parseOptionalNumber(args: string[], flag: string): number | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const raw = args[index + 1];
  if (raw === undefined || !NUMBER_PATTERN.test(raw)) {
    throw new Error(`budget:check: ${flag} needs a non-negative decimal number`);
  }
  return Number(raw);
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const spendTotal = parseOptionalNumber(args, "--spend");
  const dayCap = parseOptionalNumber(args, "--day-cap");
  const totalCap = parseOptionalNumber(args, "--total-cap");
  return { spendTotal, dayCap, totalCap };
}

async function run(): Promise<number> {
  let parsed: CliArgs;
  try {
    parsed = parseCliArgs(Bun.argv);
    if (parsed.spendTotal === null && (parsed.dayCap !== null || parsed.totalCap !== null)) {
      console.error("budget:check: --day-cap and --total-cap need --spend");
      return 2;
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let decision: BudgetDecision;
  // On the ledger path the escalation below uses the configured state and
  // log; the override path returns earlier and never writes escalation data.
  let ledgerStatePath: string | undefined;
  let ledgerEscalationLogPath: string | undefined;
  let override = false;
  try {
    const config = await loadBudgetConfig();
    const pricing = await loadPricing();
    const route = await loadRoute();
    ledgerStatePath = config.statePath;
    ledgerEscalationLogPath = config.escalationLogPath;
    if (parsed.spendTotal !== null || parsed.dayCap !== null || parsed.totalCap !== null) {
      override = true;
      const effective = {
        ...config,
        dayCapUsd: parsed.dayCap ?? config.dayCapUsd,
        totalCapUsd: parsed.totalCap ?? config.totalCapUsd,
      };
      const overrideTotal = parsed.spendTotal ?? 0;
      decision = decideAdmission(
        {
          spentTodayUsd: overrideTotal,
          spentTotalUsd: overrideTotal,
          nvidiaRequestsToday: 0,
          unknownWorkItemIds: [],
        },
        effective,
        { route },
      );
    } else {
      const records = await readUsageLedger(config.ledgerPath);
      const summary = summarizeSpend(records, pricing, config.nvidiaProviderId, new Date());
      decision = decideAdmission(summary, config, { route });
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (decision.admit) {
    console.log(
      `admitted: ${decision.reason} (today $${decision.spentTodayUsd.toFixed(2)}, total $${decision.spentTotalUsd.toFixed(2)}, nvidia requests today ${String(decision.nvidiaRequestsToday)})`,
    );
    return 0;
  }
  if (override) {
    const kind = capKindOfReason(decision.reason);
    if (kind === null) {
      console.error(`budget:check: unknown refusal reason "${decision.reason}"`);
      return 2;
    }
    process.stderr.write(`would escalate: ${eventKeyString(kind, new Date())}\n`);
    console.log(
      `refused: ${decision.reason} (today $${decision.spentTodayUsd.toFixed(2)}, total $${decision.spentTotalUsd.toFixed(2)}, nvidia requests today ${String(decision.nvidiaRequestsToday)})`,
    );
    return 3;
  }
  // Both paths assign the escalation paths above; a missing value here
  // means config loading was bypassed.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (ledgerStatePath === undefined || ledgerEscalationLogPath === undefined) {
    console.error("budget:check: missing escalation paths");
    return 2;
  }
  try {
    await maybeEscalate(decision, {
      statePath: ledgerStatePath,
      escalationLogPath: ledgerEscalationLogPath,
      now: new Date(),
    });
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  console.log(
    `refused: ${decision.reason} (today $${decision.spentTodayUsd.toFixed(2)}, total $${decision.spentTotalUsd.toFixed(2)}, nvidia requests today ${String(decision.nvidiaRequestsToday)})`,
  );
  return 3;
}

const code = await run();
process.exit(code);

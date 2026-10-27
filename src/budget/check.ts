// CLI entry point for the budget guard: bun run budget:check. Exit 0 on
// admit, 3 on refuse, 2 on a config or data error. Without flags the guard
// reads config/budget.json, prices from config/providers/ and spend from the
// configured ledger. The --spend / --day-cap / --total-cap flags are a test
// override that injects totals into the same decision function; they do not
// change stored config or the ledger.
import { loadBudgetConfig } from "./config.js";
import { readUsageLedger } from "./ledger.js";
import type { BudgetDecision } from "./decision.js";
import { decideAdmission } from "./decision.js";
import { maybeEscalate } from "./escalation.js";
import { loadPricing } from "./pricing.js";
import { summarizeSpend } from "./cost.js";

interface CliArgs {
  readonly spendTotal: number | null;
  readonly dayCap: number | null;
  readonly totalCap: number | null;
}

function parseOptionalNumber(args: string[], flag: string): number | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const raw = args[index + 1];
  if (raw === undefined) {
    throw new Error(`budget:check: ${flag} needs a value`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`budget:check: ${flag} needs a non-negative number`);
  }
  return value;
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
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let decision: BudgetDecision;
  let statePath: string;
  let escalationLogPath: string;
  try {
    const config = await loadBudgetConfig();
    const pricing = await loadPricing();
    statePath = config.statePath;
    escalationLogPath = config.escalationLogPath;
    if (parsed.spendTotal !== null || parsed.dayCap !== null || parsed.totalCap !== null) {
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
        { route: [config.nvidiaProviderId] },
      );
    } else {
      const records = await readUsageLedger(config.ledgerPath);
      const summary = summarizeSpend(records, pricing, config.nvidiaProviderId, new Date());
      decision = decideAdmission(summary, config, { route: [config.nvidiaProviderId] });
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
  try {
    await maybeEscalate(decision, {
      statePath,
      escalationLogPath,
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

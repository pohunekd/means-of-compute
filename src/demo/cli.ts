import { statInputPath } from "../fs/input.js";
import { readLedger } from "../ledger/read.js";
import { loadDemoNumbersConfig } from "./config.js";
import { buildNumbers, renderNumbers } from "./numbers.js";
import { loadDashboardConfig } from "../dashboard/config.js";
import { loadBudgetConfig } from "../budget/config.js";
import { loadProviderRoute } from "../providers/route.js";
import { providerDescriptorExists } from "../providers/config.js";
import { loadPricingForIds } from "../budget/pricing.js";
import { PROVIDERS_DIR } from "../providers/paths.js";
import { spendEntriesOf } from "../ledger/read.js";

function printError(message: string): void {
  process.stderr.write(`demo:numbers: ${message}\n`);
}

function exitError(message: string, code = 2): never {
  printError(message);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let ledgerPath: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--ledger") {
      if (seen.has("ledger")) {
        exitError("unknown or repeated flag");
      }
      seen.add("ledger");
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        exitError("unknown or repeated flag");
      }
      ledgerPath = next;
      i++;
    } else {
      exitError("unknown or repeated flag");
    }
  }
  if (ledgerPath === undefined) {
    exitError("unknown or repeated flag");
  }

  // Check ledger existence before reading
  const status = await statInputPath("Demo ledger", ledgerPath);
  if (status === "absent") {
    exitError(`ledger ${ledgerPath} is missing`);
  }

  try {
    const ledger = await readLedger("Demo ledger", ledgerPath);
    const demoConfig = await loadDemoNumbersConfig();
    const dashboardConfig = await loadDashboardConfig();
    const budgetConfig = await loadBudgetConfig();
    const route = await loadProviderRoute("config/providers/route.json", providerDescriptorExists);

    const providerIds = new Set<string>([...route, budgetConfig.nvidiaProviderId]);
    for (const entry of spendEntriesOf(ledger)) {
      for (const token of entry.tokens) {
        providerIds.add(token.provider);
      }
    }
    const pricingMap = await loadPricingForIds(PROVIDERS_DIR, [...providerIds]);

    const classes = {
      local: new Set(demoConfig.localProviderIds),
      cloud: new Set(demoConfig.cloudProviderIds),
    };

    const numbers = buildNumbers({
      ledgerPath,
      ledger,
      pricing: pricingMap,
      dashboard: dashboardConfig,
      budget: budgetConfig,
      route,
      classes,
      now: new Date(),
    });

    const output = renderNumbers(numbers);
    process.stdout.write(output);
    process.exit(0);
  } catch (error: unknown) {
    if (error instanceof Error) {
      // Errors from buildNumbers may start with demo:numbers:
      const msg = error.message;
      if (msg.startsWith("demo:numbers:")) {
        exitError(msg.replace(/^demo:numbers:\s*/, ""));
      }
      exitError(msg);
    }
    throw error;
  }
}

await main();

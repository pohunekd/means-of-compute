// CLI entry point for the budget guard: bun run budget:check. With
// --provider <id> it decides for the budget pool that holds the provider
// (the gate always passes it); without it, for every pool, one line each.
// Exit 0 when every evaluated pool admits, 3 when one refuses, 2 on a
// config or data error. Without flags the guard reads config/budget.json,
// prices from config/providers/, the route from config/providers/route.json
// and spend from the configured ledger. A descriptor without a pricing
// block is a load error; --day-cap or --total-cap without --spend exits 2.
// The --spend / --day-cap / --total-cap flags are a test override that
// injects totals and caps into the same decision function for each
// evaluated pool; the override never writes escalation state or the
// escalation log, it only prints `would escalate: <event key>` on stderr.
import { loadBudgetConfig, poolHolds, poolOfProvider, poolsOf, spendBoundsOf } from "./config.js";
import { readInputText, statInputPath } from "../fs/input.js";
import { TOKENS_PER_1M } from "./cost.js";
import { loadLedgerConfig, readLedger, spendEntriesOf } from "../ledger/read.js";
import { decimalToNanoUsd } from "./money.js";
import type { BudgetDecision } from "./decision.js";
import { decideAdmission } from "./decision.js";
import { capKindOfReason, eventKeyString, maybeEscalate } from "./escalation.js";
import { loadPricingForIds } from "./pricing.js";
import { entriesOfProviders, summarizeSpend, type SpendSummary } from "./cost.js";
import { PROVIDERS_DIR, PROVIDER_ROUTE_PATH } from "../providers/paths.js";

interface CliArgs {
  readonly provider: string | null;
  readonly spendTotal: string | null;
  readonly dayCap: string | null;
  readonly totalCap: string | null;
}

async function loadRoute(routePath = PROVIDER_ROUTE_PATH): Promise<string[]> {
  const label = "Budget route";
  if ((await statInputPath(label, routePath)) === "absent") {
    throw new Error(`${label} ${routePath}: file is missing`);
  }
  const text = await readInputText(label, routePath);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} ${routePath}: not valid JSON`, { cause: error });
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as Record<string, unknown>).providers)
  ) {
    throw new Error(`Budget route ${routePath}: needs a string array "providers"`);
  }
  const entries = (raw as { providers: unknown[] }).providers;
  if (entries.some((entry: unknown) => typeof entry !== "string")) {
    throw new Error(`Budget route ${routePath}: needs a string array "providers"`);
  }
  const providers = entries as string[];
  if (providers.length === 0) {
    throw new Error(`Budget route ${routePath}: providers must not be empty`);
  }
  const seen = new Set<string>();
  for (const id of providers) {
    if (seen.has(id)) {
      throw new Error(`Budget route ${routePath}: duplicate provider id "${id}"`);
    }
    seen.add(id);
  }
  return providers;
}

const NUMBER_PATTERN = /^[0-9]+(\.[0-9]+)?$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;

function parseOptionalProvider(args: string[]): string | null {
  const index = args.indexOf("--provider");
  if (index === -1) {
    return null;
  }
  const raw = args[index + 1];
  if (raw === undefined || !PROVIDER_ID_PATTERN.test(raw)) {
    throw new Error("budget:check: --provider needs a provider id");
  }
  return raw;
}

function parseOptionalDecimal(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const raw = args[index + 1];
  if (raw === undefined || !NUMBER_PATTERN.test(raw)) {
    throw new Error(`budget:check: ${flag} needs a non-negative decimal number`);
  }
  return raw;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const spendTotal = parseOptionalDecimal(args, "--spend");
  const dayCap = parseOptionalDecimal(args, "--day-cap");
  const totalCap = parseOptionalDecimal(args, "--total-cap");
  return { provider: parseOptionalProvider(args), spendTotal, dayCap, totalCap };
}

interface EvaluationClock {
  readonly now: Date;
}

const PINNED_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// Single evaluation-time reader for the CLI. MOC_BUDGET_NOW is test-only:
// a fixed ISO-8601 UTC timestamp used to pin "today" in CLI tests. An
// invalid value exits 2; when unset, the CLI uses the clock.
export function readEvaluationTime(env: NodeJS.ProcessEnv = process.env): Date {
  const raw = env.MOC_BUDGET_NOW;
  if (raw === undefined) {
    return new Date();
  }
  const at = Date.parse(raw);
  if (!PINNED_TIME_PATTERN.test(raw) || Number.isNaN(at)) {
    throw new Error("budget:check: MOC_BUDGET_NOW must be an ISO-8601 UTC timestamp");
  }
  const now = new Date(at);
  const canonical = now.toISOString();
  const normalized = raw.includes(".") ? raw : raw.replace("Z", ".000Z");
  if (canonical !== normalized) {
    throw new Error("budget:check: MOC_BUDGET_NOW must be an ISO-8601 UTC timestamp");
  }
  return now;
}

async function run(): Promise<number> {
  let clock: EvaluationClock;
  try {
    clock = { now: readEvaluationTime() };
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (process.env.MOC_BUDGET_NOW !== undefined) {
    process.stderr.write(`evaluation time pinned by MOC_BUDGET_NOW: ${clock.now.toISOString()}\n`);
  }
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
  // One evaluation per pool: the pool of --provider, or every pool (main
  // first) without it.
  let evaluations: { decision: BudgetDecision; summary: SpendSummary | null }[];
  let statePath: string;
  let escalationLogPath: string;
  const override = parsed.spendTotal !== null || parsed.dayCap !== null || parsed.totalCap !== null;
  try {
    const config = await loadBudgetConfig();
    const route = await loadRoute();
    if (!route.includes(config.nvidiaProviderId)) {
      throw new Error(
        `Budget route: nvidiaProviderId "${config.nvidiaProviderId}" is not in the route`,
      );
    }
    statePath = config.statePath;
    escalationLogPath = config.escalationLogPath;
    const pools =
      parsed.provider === null ? poolsOf(config) : [poolOfProvider(config, parsed.provider)];
    // Every pool provider and the asked provider need a descriptor, so an
    // unknown provider exits 2 instead of being admitted.
    const knownIds = [
      ...route,
      config.nvidiaProviderId,
      ...config.pools.flatMap((pool) => pool.providers ?? []),
      ...(parsed.provider === null ? [] : [parsed.provider]),
    ];
    if (override) {
      const overrideTotal = parsed.spendTotal;
      if (overrideTotal === null) {
        throw new Error("budget:check: --spend needs a value");
      }
      // The override never touches the ledger: it prices nothing.
      await loadPricingForIds(PROVIDERS_DIR, knownIds);
      const overrideNano = decimalToNanoUsd(overrideTotal, "spend", "budget:check");
      evaluations = pools.map((pool) => {
        const effective = {
          ...pool,
          dayCapNanoUsd:
            parsed.dayCap === null
              ? pool.dayCapNanoUsd
              : decimalToNanoUsd(parsed.dayCap, "day-cap", "budget:check"),
          totalCapNanoUsd:
            parsed.totalCap === null
              ? pool.totalCapNanoUsd
              : decimalToNanoUsd(parsed.totalCap, "total-cap", "budget:check"),
        };
        const decision = decideAdmission(
          {
            spentTodayNanoUsd: overrideNano,
            spentTotalNanoUsd: overrideNano,
            spentTodayNanoTimes1M: overrideNano * TOKENS_PER_1M,
            spentTotalNanoTimes1M: overrideNano * TOKENS_PER_1M,
            nvidiaRequestsToday: 0,
            unknownWorkItemIds: [],
            boundedWorkItemIds: [],
            boundedTodayWorkItemIds: [],
          },
          config,
          { route, pool: effective },
        );
        return { decision, summary: null };
      });
    } else {
      const { ledgerPath } = await loadLedgerConfig();
      const contents = await readLedger("Budget ledger", ledgerPath);
      const entries = spendEntriesOf(contents);
      const ledgerIds = entries.flatMap((entry) => entry.tokens.map((token) => token.provider));
      const pricing = await loadPricingForIds(PROVIDERS_DIR, [...knownIds, ...ledgerIds]);
      evaluations = pools.map((pool) => {
        const summary = summarizeSpend(
          entriesOfProviders(entries, (id) => poolHolds(config, pool, id)),
          pricing,
          config.nvidiaProviderId,
          clock.now,
          spendBoundsOf(config),
        );
        return { decision: decideAdmission(summary, config, { route, pool }), summary };
      });
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let refusedAny = false;
  for (const { decision, summary } of evaluations) {
    if (!decision.admit) {
      refusedAny = true;
      const kind = capKindOfReason(decision.reason);
      if (kind === null) {
        console.error(`budget:check: unknown refusal reason "${decision.reason}"`);
        return 2;
      }
      if (override) {
        process.stderr.write(
          `would escalate: ${eventKeyString(kind, clock.now, decision.mainPool ? null : decision.pool)}\n`,
        );
      } else {
        try {
          await maybeEscalate(decision, { statePath, escalationLogPath, now: clock.now });
        } catch (error: unknown) {
          console.error(error instanceof Error ? error.message : String(error));
          return 2;
        }
      }
    }
    console.log(decisionLine(decision, summary));
  }
  return refusedAny ? 3 : 0;
}

// One line per pool. The gate reads the reason up to " (today ", so the
// pool id comes last inside the parentheses; NVIDIA requests count only in
// the main pool.
function decisionLine(decision: BudgetDecision, summary: SpendSummary | null): string {
  const verdict = decision.admit ? "admitted" : "refused";
  const nvidia = decision.mainPool
    ? `, nvidia requests today ${String(decision.nvidiaRequestsToday)}`
    : "";
  const bounded =
    summary !== null && summary.boundedWorkItemIds.length > 0
      ? `, bounded items ${String(summary.boundedWorkItemIds.length)}`
      : "";
  return `${verdict}: ${decision.reason} (today $${decision.spentTodayUsd.toFixed(2)}, total $${decision.spentTotalUsd.toFixed(2)}${nvidia}${bounded}, pool ${decision.pool})`;
}

const code = await run();
process.exit(code);

// Dashboard input gathering. Every per-request input arrives as a Sourced
// value: ok, a no-data reason, or an error code. The page shows only the
// code; the message goes to the log. A thrown value that is not an Error is
// rethrown and becomes a 500.
import type { AuditVerdict, WorkItem } from "../../contracts/v1/types.js";
import type { BudgetConfig } from "../budget/config.js";
import { loadPricingForIds, type NanoPricing } from "../budget/pricing.js";
import type { HostObservation, HostStateCollector } from "../hoststate/collector.js";
import { LedgerDataError } from "../ledger/errors.js";
import { readLedger, spendEntriesOf } from "../ledger/read.js";
import type { LedgerContents } from "../ledger/types.js";
import { PROVIDERS_DIR } from "../providers/paths.js";
import { readVerdicts } from "../auditor/store.js";
import { RegistryDataError, readRegistry, type RegistryEntry } from "../dispatcher/registry.js";
import { lstat } from "node:fs/promises";
import { requestIdProblem } from "./sessions.js";
import { workRows } from "./model.js";
import type { Baselines } from "./config.js";

export type InputErrorCode =
  | "ledger-invalid"
  | "ledger-unreadable"
  | "pricing-unavailable"
  | "verdicts-unreadable"
  | "fleet-round-failed"
  | "registry-invalid"
  | "registry-unreadable";

export type InputFailure =
  | { readonly kind: "no-data"; readonly reason: string }
  | { readonly kind: "error"; readonly code: InputErrorCode };

export type Sourced<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: InputFailure };

export interface DashboardInputs {
  readonly now: Date;
  readonly budget: BudgetConfig;
  readonly route: readonly string[];
  readonly baselines: Baselines;
  readonly workRowLimit: number;
  readonly logPath: string;
  readonly ledger: Sourced<LedgerContents>;
  readonly pricing: Sourced<ReadonlyMap<string, NanoPricing>>;
  readonly verdicts: ReadonlyMap<string, Sourced<readonly AuditVerdict[]>>;
  readonly hosts: Sourced<readonly HostObservation[]>;
  readonly workItems: readonly WorkItem[] | null;
  readonly registry: Sourced<readonly RegistryEntry[]>;
}

export interface DashboardSources {
  readonly ledgerPath: string;
  readonly verdictDir: string;
  readonly hostState: HostStateCollector | null;
  readonly registryPath: string;
}

export interface FixedInputs {
  readonly budget: BudgetConfig;
  readonly route: readonly string[];
  readonly baselines: Baselines;
  readonly workRowLimit: number;
  readonly logPath: string;
}

function errorFailure(code: InputErrorCode): InputFailure {
  return { kind: "error", code };
}

function noData(reason: string): InputFailure {
  return { kind: "no-data", reason };
}

async function readLedgerInput(
  ledgerPath: string,
  log: (input: string, code: InputErrorCode, message: string) => void,
): Promise<Sourced<LedgerContents>> {
  try {
    return { ok: true, value: await readLedger("Dashboard ledger", ledgerPath) };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    const code: InputErrorCode =
      error instanceof LedgerDataError ? "ledger-invalid" : "ledger-unreadable";
    log("ledger", code, error.message);
    return { ok: false, failure: errorFailure(code) };
  }
}

async function readPricingInput(
  ledger: Sourced<LedgerContents>,
  route: readonly string[],
  nvidiaProviderId: string,
  log: (input: string, code: InputErrorCode, message: string) => void,
): Promise<Sourced<ReadonlyMap<string, NanoPricing>>> {
  if (!ledger.ok) {
    return { ok: false, failure: ledger.failure };
  }
  const providers = new Set<string>([...route, nvidiaProviderId]);
  for (const entry of spendEntriesOf(ledger.value)) {
    for (const token of entry.tokens) {
      providers.add(token.provider);
    }
  }
  try {
    return { ok: true, value: await loadPricingForIds(PROVIDERS_DIR, [...providers]) };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    log("pricing", "pricing-unavailable", error.message);
    return { ok: false, failure: errorFailure("pricing-unavailable") };
  }
}

async function readHostsInput(
  hostState: HostStateCollector | null,
  log: (input: string, code: InputErrorCode, message: string) => void,
): Promise<Sourced<readonly HostObservation[]>> {
  if (hostState === null) {
    return { ok: false, failure: noData("host state not wired") };
  }
  try {
    return { ok: true, value: await hostState.collect() };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    log("hosts", "fleet-round-failed", error.message);
    return { ok: false, failure: errorFailure("fleet-round-failed") };
  }
}

async function readRegistryInput(
  registryPath: string,
  log: (input: string, code: InputErrorCode, message: string) => void,
): Promise<Sourced<readonly RegistryEntry[]>> {
  let entries: readonly RegistryEntry[];
  try {
    entries = await readRegistry(registryPath);
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    const code: InputErrorCode =
      error instanceof RegistryDataError ? "registry-invalid" : "registry-unreadable";
    log("registry", code, error.message);
    return { ok: false, failure: errorFailure(code) };
  }
  const problem = requestIdProblem(entries);
  if (problem !== null) {
    const message = `Dashboard registry ${registryPath}: ${problem}`;
    log("registry", "registry-invalid", message);
    return { ok: false, failure: errorFailure("registry-invalid") };
  }
  return { ok: true, value: entries };
}

async function readVerdictsForShown(
  verdictDir: string,
  shown: readonly string[],
  log: (input: string, code: InputErrorCode, message: string) => void,
): Promise<ReadonlyMap<string, Sourced<readonly AuditVerdict[]>>> {
  let dirMissing = false;
  try {
    await lstat(verdictDir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      dirMissing = true;
    } else if (error instanceof Error) {
      const verdicts = new Map<string, Sourced<readonly AuditVerdict[]>>();
      for (const id of shown) {
        const message = error.message;
        log("verdicts", "verdicts-unreadable", message);
        verdicts.set(id, { ok: false, failure: errorFailure("verdicts-unreadable") });
      }
      return verdicts;
    } else {
      throw error;
    }
  }
  if (dirMissing) {
    const verdicts = new Map<string, Sourced<readonly AuditVerdict[]>>();
    for (const id of shown) {
      verdicts.set(id, { ok: false, failure: noData("no verdict store") });
    }
    return verdicts;
  }
  const entries = await Promise.all(
    shown.map(async (id): Promise<readonly [string, Sourced<readonly AuditVerdict[]>]> => {
      try {
        const value = await readVerdicts(verdictDir, id);
        return [id, { ok: true, value }];
      } catch (error: unknown) {
        if (!(error instanceof Error)) {
          throw error;
        }
        log("verdicts", "verdicts-unreadable", error.message);
        return [id, { ok: false, failure: errorFailure("verdicts-unreadable") }];
      }
    }),
  );
  return new Map(entries);
}

export async function gatherInputs(
  sources: DashboardSources,
  fixed: FixedInputs,
  now: Date,
  log: (event: { input: string; code: InputErrorCode; message: string }) => void,
): Promise<DashboardInputs> {
  const emit = (input: string, code: InputErrorCode, message: string): void => {
    log({ input, code, message });
  };
  const [ledger, hosts, registry] = await Promise.all([
    readLedgerInput(sources.ledgerPath, emit),
    readHostsInput(sources.hostState, emit),
    readRegistryInput(sources.registryPath, emit),
  ]);
  const pricing = await readPricingInput(ledger, fixed.route, fixed.budget.nvidiaProviderId, emit);
  const partial: Omit<DashboardInputs, "verdicts"> = {
    now,
    budget: fixed.budget,
    route: fixed.route,
    baselines: fixed.baselines,
    workRowLimit: fixed.workRowLimit,
    logPath: fixed.logPath,
    ledger,
    pricing,
    hosts,
    workItems: null,
    registry,
  };
  const { shown } = workRows(partial);
  const verdicts = await readVerdictsForShown(sources.verdictDir, shown, emit);
  return { ...partial, verdicts };
}

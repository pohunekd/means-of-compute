// Dashboard input gathering. Every per-request input arrives as a Sourced
// value: ok, a no-data reason, or an error code. The page shows only the
// code; the message goes to the log. A thrown value that is not an Error is
// rethrown and becomes a 500.
import type { AuditVerdict, WorkItem } from "../../contracts/v1/types.js";
import { InputPathError, statInputPath } from "../fs/input.js";
import { readResults, LoopResultsDataError } from "../loop/results.js";
import type { ResultLine } from "../loop/results.js";
import type { BudgetConfig } from "../budget/config.js";
import { loadPricingForIds, type NanoPricing } from "../budget/pricing.js";
import type { HostObservation, HostStateCollector } from "../hoststate/collector.js";
import { HostStateLogDataError, readRecordedProbes, type RecordedProbe } from "../hoststate/log.js";
import { LedgerDataError } from "../ledger/errors.js";
import { readLedger, spendEntriesOf } from "../ledger/read.js";
import type { LedgerContents } from "../ledger/types.js";
import { PROVIDERS_DIR } from "../providers/paths.js";
import { readVerdicts } from "../auditor/store.js";
import { RegistryDataError, readRegistry, type RegistryEntry } from "../dispatcher/registry.js";
import { WorkStoreDataError, readWorkStore } from "../work/store.js";
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
  | "registry-unreadable"
  | "results-invalid"
  | "results-unreadable"
  | "work-store-invalid"
  | "work-store-unreadable"
  | "host-state-log-invalid"
  | "host-state-log-unreadable";

export type InputFailure =
  | { readonly kind: "no-data"; readonly reason: string }
  | { readonly kind: "error"; readonly code: InputErrorCode };

export type Sourced<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: InputFailure };

// Fleet input: a collector round of this request, or the newest probe per
// alias recorded at or before the page clock (the snapshot has no live I/O).
export type HostView =
  | { readonly kind: "live"; readonly observations: readonly HostObservation[] }
  | { readonly kind: "recorded"; readonly probes: readonly RecordedProbe[] };

export type HostStateSource =
  | { readonly kind: "collector"; readonly collector: HostStateCollector }
  | { readonly kind: "log"; readonly path: string };

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
  readonly hosts: Sourced<HostView>;
  readonly workItems: Sourced<readonly WorkItem[]>;
  readonly registry: Sourced<readonly RegistryEntry[]>;
  readonly results: Sourced<readonly ResultLine[]>;
}

export interface DashboardSources {
  readonly ledgerPath: string;
  readonly verdictDir: string;
  readonly hostState: HostStateSource | null;
  readonly registryPath: string;
  readonly resultsPath: string;
  readonly workStorePath: string;
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
  hostState: HostStateSource | null,
  now: Date,
  log: (input: string, code: InputErrorCode, message: string) => void,
): Promise<Sourced<HostView>> {
  if (hostState === null) {
    return { ok: false, failure: noData("host state not wired") };
  }
  if (hostState.kind === "log") {
    return readRecordedHostsInput(hostState.path, now, log);
  }
  try {
    return { ok: true, value: { kind: "live", observations: await hostState.collector.collect() } };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    log("hosts", "fleet-round-failed", error.message);
    return { ok: false, failure: errorFailure("fleet-round-failed") };
  }
}

async function readRecordedHostsInput(
  path: string,
  now: Date,
  log: (input: string, code: InputErrorCode, message: string) => void,
): Promise<Sourced<HostView>> {
  try {
    const probes = await readRecordedProbes(path, now);
    if (probes === null) {
      return { ok: false, failure: noData("no probe recorded; a snapshot has no live host state") };
    }
    return { ok: true, value: { kind: "recorded", probes } };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    const code: InputErrorCode =
      error instanceof HostStateLogDataError
        ? "host-state-log-invalid"
        : "host-state-log-unreadable";
    log("hosts", code, error.message);
    return { ok: false, failure: errorFailure(code) };
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

async function readResultsInput(
  resultsPath: string,
  log: (input: string, code: InputErrorCode, message: string) => void,
): Promise<Sourced<readonly ResultLine[]>> {
  try {
    return { ok: true, value: await readResults(resultsPath) };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    // readResults wraps path failures (stat, read, not a file) in a
    // LoopResultsDataError whose cause is an InputPathError; only a bad
    // middle line is a data error.
    const code: InputErrorCode =
      error instanceof LoopResultsDataError && !(error.cause instanceof InputPathError)
        ? "results-invalid"
        : "results-unreadable";
    log("results", code, error.message);
    return { ok: false, failure: errorFailure(code) };
  }
}

// readWorkStore reads an absent store as empty; the page shows it as no
// data, not as zero parked tasks.
async function readWorkStoreInput(
  workStorePath: string,
  log: (input: string, code: InputErrorCode, message: string) => void,
): Promise<Sourced<readonly WorkItem[]>> {
  try {
    if ((await statInputPath("Dashboard work store", workStorePath)) === "absent") {
      return { ok: false, failure: noData("work store not wired") };
    }
    return { ok: true, value: (await readWorkStore(workStorePath)).items };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    // readWorkStore wraps stat and read failures in a WorkStoreDataError
    // whose cause is an InputPathError; JSON and shape failures are data errors.
    const code: InputErrorCode =
      error instanceof WorkStoreDataError && !(error.cause instanceof InputPathError)
        ? "work-store-invalid"
        : "work-store-unreadable";
    log("work store", code, error.message);
    return { ok: false, failure: errorFailure(code) };
  }
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
  const [ledger, hosts, registry, results, workItems] = await Promise.all([
    readLedgerInput(sources.ledgerPath, emit),
    readHostsInput(sources.hostState, now, emit),
    readRegistryInput(sources.registryPath, emit),
    readResultsInput(sources.resultsPath, emit),
    readWorkStoreInput(sources.workStorePath, emit),
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
    workItems,
    registry,
    results,
  };
  const { shown } = workRows(partial);
  const verdicts = await readVerdictsForShown(sources.verdictDir, shown, emit);
  return { ...partial, verdicts };
}

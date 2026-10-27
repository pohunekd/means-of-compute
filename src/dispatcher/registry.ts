// Durable dispatcher session registry: one writer (the factory process).
// Reads go through src/fs/input.ts where an absent path with an existing
// parent means empty; writes go through writeFileAtomic in src/fs/write.ts.
// An in-process promise chain serializes writes.
import Ajv from "ajv/dist/2020";
import { readInputText, statInputPath } from "../fs/input.js";
import { writeFileAtomic } from "../fs/write.js";
import type {
  CancelReason,
  ModelSelection,
  PortState,
  PortUsage,
  TerminalState,
} from "./port.js";
import registrySchema from "./registry.schema.json" with { type: "json" };

const ajv = new Ajv({ strict: true });
const validateRegistry = ajv.compile(registrySchema);

export interface RegistryTerminal {
  readonly state: TerminalState;
  readonly observedAt: string;
  readonly seconds: number;
  readonly usage: PortUsage | null;
  readonly usageValid: boolean;
  readonly detail: string;
  readonly ledgerAppended: boolean;
}

export interface RegistryEntry {
  readonly requestId: string;
  readonly workItemId: string;
  readonly sessionId: string;
  readonly hostAlias: string;
  readonly branch: string;
  readonly model: ModelSelection;
  readonly startedAt: string;
  readonly cursor: string | null;
  readonly unreachableCount: number;
  readonly lastSeenState: "starting" | "running";
  readonly lastSeenAt: string;
  readonly cancelReason: CancelReason | null;
  readonly terminal: RegistryTerminal | null;
}

export class RegistryDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryDataError";
  }
}

function registryReason(value: unknown): string {
  validateRegistry(value);
  return JSON.stringify(validateRegistry.errors);
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry["requestId"] !== "string" || (entry["requestId"] as string).length === 0) {
    return false;
  }
  if (typeof entry["sessionId"] !== "string" || (entry["sessionId"] as string).length === 0) {
    return false;
  }
  const terminal = entry["terminal"] as { state?: unknown } | null;
  if (terminal !== null) {
    const state = terminal.state as PortState;
    if (state !== "finished" && state !== "failed" && state !== "lost" && state !== "cancelled") {
      return false;
    }
  }
  return true;
}

function checkUniqueSessions(entries: readonly RegistryEntry[], path: string): void {
  const requestIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const entry of entries) {
    if (requestIds.has(entry.requestId)) {
      throw new RegistryDataError(
        `Dispatcher registry ${path}: duplicate requestId "${entry.requestId}"`,
      );
    }
    requestIds.add(entry.requestId);
    if (sessionIds.has(entry.sessionId)) {
      throw new RegistryDataError(
        `Dispatcher registry ${path}: duplicate sessionId "${entry.sessionId}"`,
      );
    }
    sessionIds.add(entry.sessionId);
  }
}

function parseRegistry(text: string, path: string): RegistryEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new RegistryDataError(`Dispatcher registry ${path}: not valid JSON`);
  }
  if (!validateRegistry(raw)) {
    throw new RegistryDataError(
      `Dispatcher registry ${path}: invalid registry ${registryReason(raw)}`,
    );
  }
  const entries = (raw as { sessions: unknown[] }).sessions;
  const checked: RegistryEntry[] = [];
  for (const entry of entries) {
    if (!isRegistryEntry(entry)) {
      throw new RegistryDataError(
        `Dispatcher registry ${path}: invalid registry entry ${JSON.stringify(entry)}`,
      );
    }
    checked.push(entry);
  }
  checkUniqueSessions(checked, path);
  return checked;
}

export async function readRegistry(path: string): Promise<readonly RegistryEntry[]> {
  if ((await statInputPath("Dispatcher registry", path)) === "absent") {
    return [];
  }
  const text = await readInputText("Dispatcher registry", path);
  if (text === "") {
    return [];
  }
  return parseRegistry(text, path);
}

let writeChain: Promise<void> = Promise.resolve();

export function writeRegistry(path: string, entries: readonly RegistryEntry[]): Promise<void> {
  const task = writeChain.then(async () => {
    checkUniqueSessions(entries, path);
    await writeFileAtomic(
      "Dispatcher registry",
      path,
      JSON.stringify({ sessions: entries }, null, 2).concat("\n"),
    );
  });
  writeChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export function sessionsOf(
  entries: readonly RegistryEntry[],
  workItemId: string,
): readonly RegistryEntry[] {
  return entries.filter((entry) => entry.workItemId === workItemId);
}

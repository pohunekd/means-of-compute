// Durable dispatcher session registry: one writer (the factory process).
// Reads go through src/fs/input.ts where an absent path with an existing
// parent means empty; writes go through writeFileAtomic in src/fs/write.ts.
// An in-process promise chain serializes writes. Entries are provisional
// until the port start settles them; only settled entries carry a session id.
import Ajv from "ajv/dist/2020";
import { readInputText, statInputPath } from "../fs/input.js";
import { writeFileAtomic } from "../fs/write.js";
import type { CancelReason, ModelSelection, PortState, PortUsage, TerminalState } from "./port.js";
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

interface RegistryEntryBase {
  readonly requestId: string;
  readonly workItemId: string;
  readonly repo: string;
  readonly hostAlias: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly resume: boolean;
  readonly model: ModelSelection;
  readonly briefSha256: string;
  readonly startedAt: string;
  readonly cursor: string | null;
  readonly unreachableCount: number;
  readonly lastSeenState: "starting" | "running";
  readonly lastSeenAt: string;
  readonly cancelReason: CancelReason | null;
  readonly terminal: RegistryTerminal | null;
  readonly resolvedAt: string | null;
  // Set once dispatcher.retire removed the session or found it absent; the
  // retire sweep skips a marked entry. Optional so older registries validate.
  readonly retiredAt?: string;
  readonly revision: number;
}

export interface SettledRegistryEntry extends RegistryEntryBase {
  readonly sessionId: string;
  readonly worktree: string;
  readonly baseCommit: string | null;
}

export interface ProvisionalRegistryEntry extends RegistryEntryBase {
  readonly sessionId: null;
  readonly worktree: null;
  readonly baseCommit: null;
}

export type RegistryEntry = SettledRegistryEntry | ProvisionalRegistryEntry;

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
  if (typeof entry["requestId"] !== "string" || entry["requestId"].length === 0) {
    return false;
  }
  const sessionId: unknown = entry["sessionId"];
  if (sessionId !== null && (typeof sessionId !== "string" || sessionId.length === 0)) {
    return false;
  }
  const revision = entry["revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
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
    // Provisional entries carry no session yet, so null ids never collide.
    if (entry.sessionId === null) {
      continue;
    }
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
  return parseRegistry(text, path);
}

let writeChain: Promise<void> = Promise.resolve();

function checkDocument(path: string, entries: readonly RegistryEntry[]): void {
  const document = { sessions: [...entries] };
  if (!validateRegistry(document)) {
    throw new RegistryDataError(
      `Dispatcher registry ${path}: invalid registry ${registryReason(document)}`,
    );
  }
  for (const entry of entries) {
    if (!isRegistryEntry(entry)) {
      throw new RegistryDataError(
        `Dispatcher registry ${path}: invalid registry entry ${JSON.stringify(entry)}`,
      );
    }
  }
  checkUniqueSessions(entries, path);
}

async function persistDocument(path: string, entries: readonly RegistryEntry[]): Promise<void> {
  checkDocument(path, entries);
  await writeFileAtomic(
    "Dispatcher registry",
    path,
    JSON.stringify({ sessions: entries }, null, 2).concat("\n"),
  );
}

export function insertRegistryEntry(path: string, entry: RegistryEntry): Promise<void> {
  const task = writeChain.then(async () => {
    if (entry.revision !== 0) {
      throw new RegistryDataError(
        `Dispatcher registry ${path}: new entry "${entry.requestId}" must have revision 0`,
      );
    }
    const current = await readRegistry(path);
    if (current.some((candidate) => candidate.requestId === entry.requestId)) {
      throw new RegistryDataError(
        `Dispatcher registry ${path}: duplicate requestId "${entry.requestId}"`,
      );
    }
    if (
      entry.sessionId !== null &&
      current.some((candidate) => candidate.sessionId === entry.sessionId)
    ) {
      throw new RegistryDataError(
        `Dispatcher registry ${path}: duplicate sessionId "${entry.sessionId}"`,
      );
    }
    await persistDocument(path, [...current, entry]);
  });
  writeChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export function replaceRegistryEntry(path: string, entry: RegistryEntry): Promise<void> {
  const task = writeChain.then(async () => {
    const current = await readRegistry(path);
    const stored = current.find((candidate) => candidate.requestId === entry.requestId);
    if (stored === undefined) {
      throw new RegistryDataError(
        `Dispatcher registry ${path}: unknown requestId "${entry.requestId}"`,
      );
    }
    // A write built from a stale snapshot fails loudly instead of losing
    // another hold's update.
    if (stored.revision !== entry.revision - 1) {
      throw new RegistryDataError(
        `Dispatcher registry ${path}: stale revision for "${entry.requestId}"`,
      );
    }
    await persistDocument(
      path,
      current.map((candidate) => (candidate.requestId === entry.requestId ? entry : candidate)),
    );
  });
  writeChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export function removeProvisionalEntry(
  path: string,
  requestId: string,
  revision: number,
): Promise<void> {
  const task = writeChain.then(async () => {
    const current = await readRegistry(path);
    const stored = current.find((candidate) => candidate.requestId === requestId);
    if (
      stored === undefined ||
      stored.sessionId !== null ||
      stored.terminal !== null ||
      stored.revision !== revision
    ) {
      throw new RegistryDataError(
        `Dispatcher registry ${path}: no open provisional entry "${requestId}" at revision ${String(revision)}`,
      );
    }
    await persistDocument(
      path,
      current.filter((candidate) => candidate.requestId !== requestId),
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

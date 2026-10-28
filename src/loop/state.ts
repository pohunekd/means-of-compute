// Loop state: the durable journal of the loop runner. Every write takes
// the state lock, reads the file, applies the fold, checks the id shape
// plus rules (b) to (f), and persists with one atomic write. Rule (a)
// membership in the work store is checked by the later recovery slice.
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readInputText, statInputPath } from "../fs/input.js";
import { withFileLock, FileLockError } from "../fs/lock.js";
import { writeFileAtomic } from "../fs/write.js";
import stateSchema from "./state.schema.json" with { type: "json" };

export class LoopStateDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopStateDataError";
  }
}

export class LoopStateBusyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopStateBusyError";
  }
}

export type LoopPhase =
  | "idle"
  | "starting"
  | "running"
  | "publishing"
  | "ci"
  | "auditing"
  | "merging"
  | "awaiting-approval"
  | "finalizing"
  | "final";

export interface LoopStateBody {
  readonly items: Readonly<Record<string, LoopStateItem>>;
  readonly resolvedApprovals: readonly string[];
  readonly mergeHold: unknown;
  readonly lastDigestDay: string | null;
}

export interface LoopState {
  readonly schemaVersion: "v1";
  readonly revision: number;
  readonly items: Readonly<Record<string, LoopStateItem>>;
  readonly resolvedApprovals: readonly string[];
  readonly mergeHold: unknown;
  readonly lastDigestDay: string | null;
}

// The full LoopItem shape is owned by state.schema.json. This alias keeps
// the update fold typed without duplicating the field list.
export type LoopStateItem = Record<string, unknown>;

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const validateState = ajv.compile(stateSchema);

const EMPTY: LoopState = {
  schemaVersion: "v1",
  revision: 0,
  items: {},
  resolvedApprovals: [],
  mergeHold: null,
  lastDigestDay: null,
};

function runningPhases(): ReadonlySet<LoopPhase> {
  return new Set<LoopPhase>(["running", "publishing", "ci", "auditing", "merging"]);
}

export async function readLoopState(path: string): Promise<LoopState> {
  const label = "loop state";
  let status: "absent" | "file";
  try {
    status = await statInputPath(label, path);
  } catch (error: unknown) {
    throw new LoopStateDataError(`${label} ${path}: cannot stat path`, { cause: error });
  }
  if (status === "absent") {
    return { ...EMPTY, items: {} };
  }
  let text: string;
  try {
    text = await readInputText(label, path);
  } catch (error: unknown) {
    throw new LoopStateDataError(`${label} ${path}: cannot read file`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new LoopStateDataError(`${label} ${path}: not valid JSON`, { cause: error });
  }
  return checkLoopState(raw, path);
}

export function checkLoopState(value: unknown, path: string): LoopState {
  const label = `loop state ${path}`;
  if (!validateState(value)) {
    const errors = validateState.errors ?? [];
    const first = errors[0] as { instancePath?: string; keyword?: string } | undefined;
    const where =
      first?.instancePath === "" || first?.instancePath === undefined ? "/" : first.instancePath;
    throw new LoopStateDataError(`${label}: invalid shape at ${where} (${String(first?.keyword)})`);
  }
  const state = value as unknown as LoopState;
  checkItemRules(state, path);
  return {
    schemaVersion: "v1",
    revision: state.revision,
    items: state.items,
    resolvedApprovals: state.resolvedApprovals,
    mergeHold: state.mergeHold,
    lastDigestDay: state.lastDigestDay,
  };
}

function checkItemRules(state: LoopState, path: string): void {
  const label = `loop state ${path}`;
  for (const [id, item] of Object.entries(state.items)) {
    const record = item as Record<string, unknown>;
    const phase = record["phase"] as LoopPhase;
    const start: unknown = record["start"];
    // Rule (b): starting exactly when a start intent is present.
    if ((phase === "starting") !== (start !== null)) {
      throw new LoopStateDataError(
        `${label}: rule (b): item "${id}" has phase "${phase}" with ${start === null ? "no" : "a"} start`,
      );
    }
    // Rule (c): a live session id is present from running through merging.
    if (runningPhases().has(phase) && record["requestId"] === null) {
      throw new LoopStateDataError(
        `${label}: rule (c): item "${id}" has phase "${phase}" without a requestId`,
      );
    }
    // Rule (e): attempt counts start at 1.
    for (const field of ["auditAttempts", "mergeAttempts"] as const) {
      const attempts = record[field] as { headSha: string; count: number } | null;
      if (attempts !== null && !(Number.isInteger(attempts.count) && attempts.count >= 1)) {
        throw new LoopStateDataError(`${label}: rule (e): item "${id}" has ${field} count below 1`);
      }
    }
    // Rule (d): round numbers are strictly increasing.
    const rounds = record["rounds"] as readonly { round: number }[];
    for (let index = 1; index < rounds.length; index += 1) {
      const previous = rounds[index - 1] as { round: number };
      const current = rounds[index] as { round: number };
      if (!(current.round > previous.round)) {
        throw new LoopStateDataError(
          `${label}: rule (d): item "${id}" rounds are not strictly increasing`,
        );
      }
    }
    // Rule (f): a park means the item is idle or final, and blocked parks
    // only land on items whose finalize result is blocked.
    const park = record["park"] as
      | { kind: "stall" | "lost" | "operator" | "blocked" }
      | null;
    const finalize = record["finalize"] as { result: "success" | "blocked" } | null;
    if (park !== null && phase !== "idle" && phase !== "final") {
      throw new LoopStateDataError(
        `${label}: rule (f): item "${id}" has phase "${phase}" with a park`,
      );
    }
    const blockedPark = park !== null && park.kind === "blocked";
    const blockedFinalize = finalize !== null && finalize.result === "blocked";
    if (blockedPark !== blockedFinalize) {
      throw new LoopStateDataError(
        `${label}: rule (f): item "${id}" has park kind "${park === null ? String(park) : park.kind}" with finalize result "${finalize === null ? String(finalize) : finalize.result}"`,
      );
    }
  }
}

export async function updateLoopState<T>(
  path: string,
  fn: (state: LoopState) => Promise<{ readonly next: LoopStateBody | null; readonly value: T }>,
): Promise<T> {
  let result: { readonly next: LoopStateBody | null; readonly value: T };
  try {
    result = await withFileLock("loop state lock", path, async () => {
      const state = await readLoopState(path);
      const r = await fn(state);
      if (r.next === null) {
        return r;
      }
      const next: LoopState = {
        schemaVersion: "v1",
        revision: state.revision + 1,
        items: r.next.items,
        resolvedApprovals: r.next.resolvedApprovals,
        mergeHold: r.next.mergeHold,
        lastDigestDay: r.next.lastDigestDay,
      };
      checkLoopState(next, path);
      await writeFileAtomic("loop state", path, `${JSON.stringify(next)}\n`);
      return r;
    });
  } catch (error: unknown) {
    if (error instanceof FileLockError) {
      if (error.code === "busy") {
        throw new LoopStateBusyError(error.message, { cause: error });
      }
      throw new LoopStateDataError(error.message, { cause: error });
    }
    throw error;
  }
  return result.value;
}

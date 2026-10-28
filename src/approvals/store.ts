// Approvals store: one JSON document holding every approval request.
// Writers take the requests lock, re-read the file, apply the change and
// persist the whole file with one atomic write. recordRequest creates
// pending entries only; decisions live in decide.ts (A9).
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { InputPathError, readInputText, statInputPath } from "../fs/input.js";
import { withFileLock, FileLockError } from "../fs/lock.js";
import { writeFileAtomic } from "../fs/write.js";
import { canonicalJson, sha256Hex } from "../work/canonical.js";
import requestsSchema from "./requests.schema.json" with { type: "json" };

export type ApprovalTool = "approve" | "pause_fleet";

export interface ApproveArgs {
  readonly workItemId: string;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly reason: string;
}

export interface PauseFleetArgs {
  readonly action: "pause" | "resume";
  readonly reason: string;
}

export type ApprovalArgs = ApproveArgs | PauseFleetArgs;

export interface ApprovalDecision {
  readonly seq: number;
  readonly author: string;
  readonly decidedAt: string;
}

export interface ApprovalRequest {
  readonly requestId: string;
  readonly seq: number;
  readonly tool: ApprovalTool;
  readonly args: ApprovalArgs;
  readonly argsSha256: string;
  readonly caller: string;
  readonly requestedAt: string;
  readonly state: "pending" | "approved" | "rejected";
  readonly decision: ApprovalDecision | null;
}

export interface ApprovalsDocument {
  readonly schemaVersion: "v1";
  readonly nextSeq: number;
  readonly requests: readonly ApprovalRequest[];
}

export type RecordOutcome =
  | { readonly kind: "recorded" | "existing"; readonly request: ApprovalRequest }
  | {
      readonly kind: "refused";
      readonly code: "too-many-pending" | "no-change";
      readonly message: string;
    };

export class ApprovalsDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApprovalsDataError";
  }
}

export class ApprovalsBusyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApprovalsBusyError";
  }
}

export class ApprovalsWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApprovalsWriteError";
  }
}

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const validateRequests = ajv.compile(requestsSchema);

const EMPTY_REQUESTS: ApprovalsDocument = { schemaVersion: "v1", nextSeq: 1, requests: [] };

export function requestIdOf(seq: number): string {
  return `req-${String(seq).padStart(6, "0")}`;
}

function shapeErrors(): string {
  const errors = validateRequests.errors ?? [];
  const first = errors[0] as { instancePath?: string; keyword?: string } | undefined;
  const path =
    first?.instancePath === "" || first?.instancePath === undefined ? "/" : first.instancePath;
  return `${path} (${String(first?.keyword)})`;
}

export function checkApprovals(value: unknown, path: string): ApprovalsDocument {
  const label = `approvals store ${path}`;
  if (!validateRequests(value)) {
    throw new ApprovalsDataError(`${label}: invalid shape at ${shapeErrors()}`);
  }
  const doc = value as {
    readonly nextSeq: number;
    readonly requests: readonly ApprovalRequest[];
  };
  const seen = new Set<number>();
  for (const request of doc.requests) {
    if (request.requestId !== requestIdOf(request.seq)) {
      throw new ApprovalsDataError(
        `${label}: request id "${request.requestId}" does not match seq ${String(request.seq)}`,
      );
    }
    if ((request.state === "pending") !== (request.decision === null)) {
      throw new ApprovalsDataError(
        `${label}: request "${request.requestId}" state "${request.state}" disagrees with its decision`,
      );
    }
    const seqs = request.decision === null ? [request.seq] : [request.seq, request.decision.seq];
    for (const seq of seqs) {
      if (seen.has(seq)) {
        throw new ApprovalsDataError(`${label}: duplicate seq ${String(seq)}`);
      }
      seen.add(seq);
      if (seq >= doc.nextSeq) {
        throw new ApprovalsDataError(
          `${label}: seq ${String(seq)} is not below nextSeq ${String(doc.nextSeq)}`,
        );
      }
    }
  }
  return { schemaVersion: "v1", nextSeq: doc.nextSeq, requests: [...doc.requests] };
}

export async function readApprovals(path: string): Promise<ApprovalsDocument> {
  const label = "approvals store";
  let status: "absent" | "file";
  try {
    status = await statInputPath(label, path);
  } catch (error: unknown) {
    throw new ApprovalsDataError(`${label} ${path}: cannot stat path`, { cause: error });
  }
  if (status === "absent") {
    return { ...EMPTY_REQUESTS, requests: [] };
  }
  let text: string;
  try {
    text = await readInputText(label, path);
  } catch (error: unknown) {
    throw new ApprovalsDataError(`${label} ${path}: cannot read file`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new ApprovalsDataError(`${label} ${path}: not valid JSON`, { cause: error });
  }
  return checkApprovals(raw, path);
}

function toWriteError(error: unknown): ApprovalsWriteError {
  if (error instanceof InputPathError) {
    return new ApprovalsWriteError(error.message, { cause: error });
  }
  return new ApprovalsWriteError(
    `approvals store: cannot write file (${String((error as NodeJS.ErrnoException).code)})`,
    { cause: error },
  );
}

export async function recordRequest(
  path: string,
  input: {
    readonly tool: ApprovalTool;
    readonly args: ApprovalArgs;
    readonly caller: string;
    readonly now: () => Date;
    readonly maxPending: number;
  },
): Promise<RecordOutcome> {
  try {
    return await withFileLock("requests lock", path, async () => {
      const doc = await readApprovals(path);
      const argsSha256 = sha256Hex(canonicalJson(input.args));
      const duplicate = doc.requests.find(
        (entry) =>
          entry.state === "pending" && entry.tool === input.tool && entry.argsSha256 === argsSha256,
      );
      if (duplicate !== undefined) {
        return { kind: "existing", request: duplicate };
      }
      if (input.tool === "pause_fleet" && "action" in input.args) {
        const paused = fleetPause(doc).paused;
        if (paused === (input.args.action === "pause")) {
          return {
            kind: "refused",
            code: "no-change",
            message: `fleet is already ${paused ? "paused" : "running"}`,
          };
        }
      }
      const pending = doc.requests.filter((entry) => entry.state === "pending");
      if (pending.length >= input.maxPending) {
        return {
          kind: "refused",
          code: "too-many-pending",
          message: `${String(pending.length)} requests already pending`,
        };
      }
      const request: ApprovalRequest = {
        requestId: requestIdOf(doc.nextSeq),
        seq: doc.nextSeq,
        tool: input.tool,
        args: input.args,
        argsSha256,
        caller: input.caller,
        requestedAt: input.now().toISOString(),
        state: "pending",
        decision: null,
      };
      const next: ApprovalsDocument = {
        schemaVersion: "v1",
        nextSeq: doc.nextSeq + 1,
        requests: [...doc.requests, request],
      };
      checkApprovals(next, path);
      try {
        await writeFileAtomic("approvals store", path, `${JSON.stringify(next)}\n`);
      } catch (error: unknown) {
        throw toWriteError(error);
      }
      return { kind: "recorded", request };
    });
  } catch (error: unknown) {
    if (error instanceof FileLockError) {
      if (error.code === "busy") {
        throw new ApprovalsBusyError(error.message, { cause: error });
      }
      if (error.code === "open-failed") {
        throw new ApprovalsDataError(error.message, { cause: error });
      }
      throw new ApprovalsWriteError(error.message, { cause: error });
    }
    throw error;
  }
}

export function fleetPause(doc: ApprovalsDocument): {
  readonly paused: boolean;
  readonly pausedBy: {
    readonly requestId: string;
    readonly author: string;
    readonly decidedAt: string;
  } | null;
} {
  let latest: ApprovalRequest | null = null;
  for (const request of doc.requests) {
    if (request.tool !== "pause_fleet" || request.state !== "approved") {
      continue;
    }
    const decision = request.decision;
    const current = latest?.decision ?? null;
    if (decision === null) {
      continue;
    }
    if (latest === null || current === null || decision.seq > current.seq) {
      latest = request;
    }
  }
  if (latest === null || latest.decision === null || !("action" in latest.args)) {
    return { paused: false, pausedBy: null };
  }
  if (latest.args.action !== "pause") {
    return { paused: false, pausedBy: null };
  }
  return {
    paused: true,
    pausedBy: {
      requestId: latest.requestId,
      author: latest.decision.author,
      decidedAt: latest.decision.decidedAt,
    },
  };
}

export function pendingRequests(doc: ApprovalsDocument): readonly ApprovalRequest[] {
  return doc.requests
    .filter((entry) => entry.state === "pending")
    .sort((left, right) => left.seq - right.seq);
}

export function approvedMerge(
  doc: ApprovalsDocument,
  workItemId: string,
  pullNumber: number,
  headSha: string,
): ApprovalRequest | null {
  for (const request of doc.requests) {
    if (request.tool !== "approve" || request.state !== "approved") {
      continue;
    }
    if (!("workItemId" in request.args)) {
      continue;
    }
    const args = request.args;
    if (
      args.workItemId === workItemId &&
      args.pullNumber === pullNumber &&
      args.headSha === headSha
    ) {
      return request;
    }
  }
  return null;
}

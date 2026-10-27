// Pure adapter decisions, part 1 (design sections 3.1 and 3.2): the
// metadata binding, the request digest and the session.new parameters.
import { createHash } from "node:crypto";
import type {
  HostCapabilities,
  SessionInfo,
  SessionNewParams,
  SessionNewResult,
} from "@pohunek/sdk";
import type { StartRequest, TerminalState } from "../port.js";
import type { PohunekAdapterConfig } from "./config.js";

export const MOC_METADATA = {
  requestId: "moc.requestId",
  requestDigest: "moc.requestDigest",
  start: "moc.start",
  baseCommit: "moc.baseCommit",
  voidCode: "moc.voidCode",
  voidedRequestId: "moc.voidedRequestId",
  outcome: "moc.outcome",
  outcomeDetail: "moc.outcomeDetail",
} as const;

const DIGEST_VERSION = "moc-request-v1";

function sha256Hex(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

export function requestDigestOf(req: StartRequest): string {
  return sha256Hex(
    JSON.stringify([
      DIGEST_VERSION,
      req.requestId,
      req.workItemId,
      req.repo,
      req.hostAlias,
      req.branch,
      req.baseRef,
      req.resume,
      req.model.providerId,
      req.model.model,
      sha256Hex(req.brief),
    ]),
  );
}

function stripOriginPrefix(baseRef: string): string {
  return baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : baseRef;
}

export function sessionNewParams(
  req: StartRequest,
  cfg: PohunekAdapterConfig,
  digest: string,
): SessionNewParams {
  const params: SessionNewParams = {
    agent: cfg.agentProfile,
    name: req.requestId,
    cols: cfg.cols,
    rows: cfg.rows,
    project: cfg.project,
    branch: req.branch,
    input: req.brief,
    input_ack_timeout_ms: cfg.inputAckTimeoutMs,
    metadata: {
      [MOC_METADATA.requestId]: req.requestId,
      [MOC_METADATA.requestDigest]: digest,
      [MOC_METADATA.start]: "pending",
    },
  };
  if (req.resume) {
    params.branch_source = "remote";
  } else {
    params.base_branch = stripOriginPrefix(req.baseRef);
  }
  return params;
}

export type PreflightName =
  | "worktree_supported"
  | "git_available"
  | "session_wait_turn_supported"
  | "session_new_branch_source_supported"
  | "session_new_input_ack_supported"
  | "supported_agents"
  | "agent_runtime";

export function hostPreflightFailure(
  caps: HostCapabilities,
  cfg: PohunekAdapterConfig,
): PreflightName | null {
  if (caps.worktree_supported !== true) {
    return "worktree_supported";
  }
  if (caps.git_available !== true) {
    return "git_available";
  }
  if (caps.session_wait_turn_supported !== true) {
    return "session_wait_turn_supported";
  }
  if (caps.session_new_branch_source_supported !== true) {
    return "session_new_branch_source_supported";
  }
  if (caps.session_new_input_ack_supported !== true) {
    return "session_new_input_ack_supported";
  }
  if (!caps.supported_agents.includes(cfg.agentProfile)) {
    return "supported_agents";
  }
  const runtimeReady = caps.runtimes.some(
    (runtime) => runtime.agent === cfg.agentProfile && runtime.available,
  );
  if (!runtimeReady) {
    return "agent_runtime";
  }
  return null;
}

export type LookupDecision =
  | { kind: "create" }
  | { kind: "return"; session: SessionInfo }
  | { kind: "void"; session: SessionInfo }
  | { kind: "reject"; code: "request-conflict" | "request-duplicated" };

export function lookupDecision(
  bound: readonly SessionInfo[],
  digest: string,
): LookupDecision {
  if (bound.length >= 2) {
    return { kind: "reject", code: "request-duplicated" };
  }
  const match = bound[0];
  if (match === undefined) {
    return { kind: "create" };
  }
  if (match.metadata?.[MOC_METADATA.requestDigest] !== digest) {
    return { kind: "reject", code: "request-conflict" };
  }
  if (match.metadata?.[MOC_METADATA.start] === "accepted") {
    return { kind: "return", session: match };
  }
  return { kind: "void", session: match };
}

export function acceptanceFailure(req: StartRequest, r: SessionNewResult): string | null {
  if (r.branch !== req.branch) {
    return "branch-mismatch";
  }
  if (typeof r.worktree_path !== "string" || r.worktree_path.length === 0) {
    return "no-worktree";
  }
  if (r.applied_input !== true || r.prompt_delivered !== true) {
    return "prompt-not-acknowledged";
  }
  const kinds = new Set((r.warnings ?? []).map((warning) => warning.kind));
  if (kinds.has("base_branch_fallback")) {
    return "base-branch-fallback";
  }
  if (kinds.has("fetch")) {
    return "fetch-failed";
  }
  if (req.resume) {
    if (r.worktree_source === undefined || r.worktree_source.commit.length === 0) {
      return "branch-source-ignored";
    }
    if (r.worktree_source.ref !== `origin/${req.branch}` || kinds.has("branch_ahead_of_remote")) {
      return "branch-ahead-of-remote";
    }
  }
  return null;
}

export const WAIT_DETAILS = {
  exited: (code: number | undefined): string =>
    code === undefined ? "exited none" : `exited ${String(code)}`,
  sessionFailed: "session failed",
  sessionStopped: "session stopped",
  turnCompleted: "turn completed",
  idleAfterTurn: "idle after turn",
  agentBlocked: "agent blocked",
  sessionMissing: "session missing",
} as const;

export type WaitRunning = { kind: "running"; state: "starting" | "running" };
export type WaitTerminal = {
  kind: "terminal";
  state: TerminalState;
  detail: string;
  mark: boolean;
  stop: boolean;
};
export type WaitDecision = WaitRunning | WaitTerminal;

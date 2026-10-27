// Pure adapter decisions of design sections 3.1, 3.2, 3.3 and 3.6.
import { createHash } from "node:crypto";
import { ClientError } from "@pohunek/sdk";
import type {
  HostCapabilities,
  SessionInfo,
  SessionNewParams,
  SessionNewResult,
  SessionWaitTurnResult,
} from "@pohunek/sdk";
import { PortRejectedError, PortUnreachableError } from "../port.js";
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

type PreflightName =
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
  if (!caps.worktree_supported) {
    return "worktree_supported";
  }
  if (!caps.git_available) {
    return "git_available";
  }
  if (!caps.session_wait_turn_supported) {
    return "session_wait_turn_supported";
  }
  if (!caps.session_new_branch_source_supported) {
    return "session_new_branch_source_supported";
  }
  if (!caps.session_new_input_ack_supported) {
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

export function lookupDecision(bound: readonly SessionInfo[], digest: string): LookupDecision {
  if (bound.length >= 2) {
    return { kind: "reject", code: "request-duplicated" };
  }
  const match = bound[0];
  if (match === undefined) {
    return { kind: "create" };
  }
  const requestDigest = match.metadata?.[MOC_METADATA.requestDigest];
  if (requestDigest === undefined || requestDigest !== digest) {
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

const WAIT_DETAILS = {
  exited: (code: number | undefined): string =>
    code === undefined ? "exited none" : `exited ${String(code)}`,
  sessionFailed: "session failed",
  sessionStopped: "session stopped",
  turnCompleted: "turn completed",
  idleAfterTurn: "idle after turn",
  agentBlocked: "agent blocked",
  sessionMissing: "session missing",
} as const;

type WaitRunning = { kind: "running"; state: "starting" | "running" };
type WaitTerminal = {
  kind: "terminal";
  state: TerminalState;
  detail: string;
  mark: boolean;
  stop: boolean;
};
export type WaitDecision = WaitRunning | WaitTerminal;

const TERMINAL_DETAILS: ReadonlySet<string> = new Set([
  "exited 0",
  "session failed",
  "session stopped",
  "turn completed",
  "agent_blocked",
  "approval_required",
  "idle after turn",
  "agent blocked",
  "runtime lost",
  "runtime conflict",
  "runtime incompatible",
  "session missing",
]);

const EXITED_DETAIL_PATTERN = /^exited (?:none|-?[1-9][0-9]*)$/;

function isStoredTerminalDetail(detail: string): boolean {
  return TERMINAL_DETAILS.has(detail) || EXITED_DETAIL_PATTERN.test(detail);
}

function exitedDetail(code: number | undefined): string {
  if (code === 0) {
    return "exited 0";
  }
  return WAIT_DETAILS.exited(code);
}

export function waitDecision(
  id: string,
  r: SessionWaitTurnResult,
  info: SessionInfo,
): WaitDecision {
  const outcome = info.metadata?.[MOC_METADATA.outcome];
  const outcomeDetail = info.metadata?.[MOC_METADATA.outcomeDetail];
  if (
    (outcome === "finished" || outcome === "failed" || outcome === "lost") &&
    typeof outcomeDetail === "string" &&
    isStoredTerminalDetail(outcomeDetail)
  ) {
    const live = info.state === "starting" || info.state === "running";
    return { kind: "terminal", state: outcome, detail: outcomeDetail, mark: false, stop: live };
  }
  if (info.state === "done" && info.exit_code === 0) {
    return { kind: "terminal", state: "finished", detail: "exited 0", mark: false, stop: false };
  }
  if (info.state === "done") {
    return {
      kind: "terminal",
      state: "failed",
      detail: exitedDetail(info.exit_code),
      mark: false,
      stop: false,
    };
  }
  if (info.state === "failed") {
    return {
      kind: "terminal",
      state: "failed",
      detail: WAIT_DETAILS.sessionFailed,
      mark: false,
      stop: false,
    };
  }
  if (info.state === "stopped") {
    return {
      kind: "terminal",
      state: "cancelled",
      detail: WAIT_DETAILS.sessionStopped,
      mark: false,
      stop: false,
    };
  }
  if (r.reason === "event" && r.event?.session_id === id) {
    if (r.event.kind === "turn_completed") {
      return {
        kind: "terminal",
        state: "finished",
        detail: WAIT_DETAILS.turnCompleted,
        mark: true,
        stop: true,
      };
    }
    if (r.event.kind === "agent_blocked" || r.event.kind === "approval_required") {
      return {
        kind: "terminal",
        state: "failed",
        detail: r.event.kind,
        mark: true,
        stop: true,
      };
    }
  }
  if (
    info.runtime?.state === "lost" ||
    info.runtime?.state === "conflict" ||
    info.runtime?.state === "incompatible"
  ) {
    return {
      kind: "terminal",
      state: "lost",
      detail: `runtime ${info.runtime.state}`,
      mark: true,
      stop: true,
    };
  }
  const progress = r.progress.find((entry) => entry.session_id === id);
  if (
    r.reason === "timeout" &&
    progress?.activity === "idle" &&
    progress.turn_started_at !== undefined
  ) {
    return {
      kind: "terminal",
      state: "finished",
      detail: WAIT_DETAILS.idleAfterTurn,
      mark: true,
      stop: true,
    };
  }
  if (r.reason === "timeout" && progress?.activity === "blocked") {
    return {
      kind: "terminal",
      state: "failed",
      detail: WAIT_DETAILS.agentBlocked,
      mark: true,
      stop: true,
    };
  }
  return { kind: "running", state: info.state === "starting" ? "starting" : "running" };
}

const KEBAB_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/;

function kebabCode(code: string): string {
  if (KEBAB_PATTERN.test(code)) {
    return code.replaceAll("_", "-");
  }
  return "daemon-error";
}

const UNREACHABLE_KINDS: ReadonlySet<string> = new Set([
  "daemonUnreachable",
  "hostUnreachable",
  "remoteDaemonUnavailable",
  "requestTimeout",
  "sessionStopOutcomeUnknown",
  "io",
  "framing",
]);

const REJECTED_KINDS: ReadonlySet<string> = new Set([
  "protocol",
  "remoteProtocol",
  "versionMismatch",
  "daemonProtocolTooOld",
  "versionTranslation",
  "json",
  "inputWaitContract",
]);

export function portErrorOf(
  error: unknown,
  alias: string,
): PortUnreachableError | PortRejectedError | null {
  if (!(error instanceof ClientError)) {
    return null;
  }
  if (UNREACHABLE_KINDS.has(error.kind)) {
    return new PortUnreachableError(`${alias}: ${error.code}`);
  }
  if (REJECTED_KINDS.has(error.kind)) {
    return new PortRejectedError(kebabCode(error.code));
  }
  return null;
}

export function isSessionNotFound(error: unknown): boolean {
  if (!(error instanceof ClientError)) {
    return false;
  }
  if (error.kind !== "protocol" && error.kind !== "remoteProtocol") {
    return false;
  }
  return error.code === "session_not_found";
}

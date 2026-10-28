import type { TokenUsage } from "../../contracts/v1/types.js";

export type PortState = "starting" | "running" | "finished" | "failed" | "lost" | "cancelled";
export type TerminalState = "finished" | "failed" | "lost" | "cancelled";
export const TERMINAL_STATES: readonly TerminalState[] = [
  "finished",
  "failed",
  "lost",
  "cancelled",
];
export type CancelReason = "stall" | "host-left" | "user-returned" | "operator";

export interface ModelSelection {
  readonly providerId: string;
  readonly model: string;
}

export interface StartRequest {
  readonly requestId: string;
  readonly workItemId: string;
  readonly repo: string;
  readonly hostAlias: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly resume: boolean;
  readonly model: ModelSelection;
  readonly brief: string;
}

export interface SessionHandle {
  readonly sessionId: string;
  readonly requestId: string;
  readonly hostAlias: string;
  readonly branch: string;
  readonly worktree: string;
  readonly baseCommit: string | null;
}

export interface PortUsage {
  readonly tokens: readonly TokenUsage[];
}

export type WaitResult =
  | {
      readonly state: "starting" | "running";
      readonly sessionId: string;
      readonly cursor: string | null;
    }
  | {
      readonly state: TerminalState;
      readonly sessionId: string;
      readonly cursor: string | null;
      readonly usage: PortUsage | null;
      readonly detail: string;
    };

export interface DiffResult {
  readonly sessionId: string;
  readonly base: string;
  readonly unifiedDiff: string;
  readonly truncated: boolean;
}

export interface SessionRef {
  readonly sessionId: string;
  readonly hostAlias: string;
}

export interface ReleaseRef {
  readonly requestId: string;
  readonly hostAlias: string;
  readonly sessionId: string | null;
}
export interface ReleaseResult {
  readonly sessionIds: readonly string[];
}
export interface DispatcherPort {
  start(request: StartRequest): Promise<SessionHandle>;
  wait(ref: SessionRef, timeoutMs: number, cursor: string | null): Promise<WaitResult>;
  diff(ref: SessionRef, base: string): Promise<DiffResult>;
  cancel(ref: SessionRef, reason: CancelReason): Promise<WaitResult>;
  release(ref: ReleaseRef): Promise<ReleaseResult>;
  close(): Promise<void>;
}

export class PortUnreachableError extends Error {
  constructor(message?: string) {
    super(message ?? "port unreachable");
    this.name = "PortUnreachableError";
  }
}

export class PortRejectedError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "PortRejectedError";
    this.code = code;
  }
}

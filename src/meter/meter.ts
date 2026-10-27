// Meter facade types: grant errors, log events and the factory-held Meter.
// The startMeter implementation joins once the request handler exists.
import type { PortUsage, SessionRef, TerminalState } from "../dispatcher/port.js";
import type { ProviderDescriptor } from "../providers/types.js";

export interface GrantSpec {
  readonly requestId: string;
  readonly workItemId: string;
  readonly hostAlias: string;
  readonly providerId: string;
  readonly model: string;
}

export type MeterGrantCode =
  | "request-conflict"
  | "grant-closed"
  | "provider-not-routed"
  | "model-mismatch"
  | "unknown-host"
  | "unknown-request"
  | "session-conflict";

export class MeterGrantError extends Error {
  readonly code: MeterGrantCode;
  constructor(code: MeterGrantCode, message: string) {
    super(message);
    this.name = "MeterGrantError";
    this.code = code;
  }
}

export class MeterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeterUnavailableError";
  }
}

export interface MeterLogEvent {
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly requestId?: string;
  readonly callId?: string;
  readonly hostAlias?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly status?: number;
  readonly code?: string;
  readonly outcome?: string;
  readonly billed?: boolean;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly ms?: number;
  readonly bytesIn?: number;
  readonly bytesOut?: number;
  readonly count?: number;
}

export interface MeterDeps {
  readonly config: import("./config.js").MeterConfig;
  readonly env: import("./config.js").MeterEnv;
  readonly providers: Readonly<Record<string, ProviderDescriptor>>;
  readonly now: () => Date;
  readonly log: (event: MeterLogEvent) => void;
}

export interface Meter {
  readonly port: number;
  tokenFor(requestId: string): string;
  openGrant(spec: GrantSpec): Promise<void>;
  bindGrant(requestId: string, sessionId: string): Promise<void>;
  settle(sessionId: string, state: TerminalState): Promise<PortUsage | null>;
  close(): Promise<void>;
}

export type { SessionRef };

export interface HostStateLimits {
  readonly pluginTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface PluginIdentity {
  readonly packageId: string;
  readonly version: string;
  readonly digest: string;
}

export interface HostStateReply {
  readonly identity: PluginIdentity;
  readonly stdout: string;
}

export type HostStateFailure =
  | "host-unreachable"
  | "request-timeout"
  | "daemon-unsupported"
  | "daemon-rejected"
  | "plugin-missing"
  | "plugin-disabled"
  | "plugin-busy"
  | "plugin-failed"
  | "plugin-timeout"
  | "output-too-large"
  | "output-invalid";

export const HOST_STATE_FAILURES: readonly HostStateFailure[] = [
  "host-unreachable",
  "request-timeout",
  "daemon-unsupported",
  "daemon-rejected",
  "plugin-missing",
  "plugin-disabled",
  "plugin-busy",
  "plugin-failed",
  "plugin-timeout",
  "output-too-large",
  "output-invalid",
];

const codePattern = /^[a-z0-9_.-]{1,64}$/;

export class HostStateError extends Error {
  readonly failure: HostStateFailure;
  readonly code: string | null;
  constructor(failure: HostStateFailure, code: string | null) {
    const safeCode = code !== null && codePattern.test(code) ? code : null;
    super(safeCode === null ? failure : `${failure} (${safeCode})`);
    this.name = "HostStateError";
    this.failure = failure;
    this.code = safeCode;
  }
}

export interface HostStatePort {
  hosts(): readonly string[];
  read(hostAlias: string, packageId: string, limits: HostStateLimits): Promise<HostStateReply>;
  close(): Promise<void>;
}

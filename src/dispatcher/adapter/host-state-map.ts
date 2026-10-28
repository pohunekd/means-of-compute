// Error mapping for host-state reads: SDK errors become HostStateError,
// reply results become HostStateReply. Rows are checked in order; the first
// match wins. Only instanceof, kind, code and details are read.
import { ClientError } from "@pohunek/sdk";
import type { CommandRunResult } from "@pohunek/sdk";
import {
  HostStateError,
  type HostStateFailure,
  type HostStateReply,
} from "../../hoststate/port.js";
import { PortUnreachableError } from "../port.js";

function pluginFailedForDetails(details: unknown): string {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return "command_failed";
  }
  const exit = (details as Record<string, unknown>)["process_exit"];
  if (typeof exit !== "object" || exit === null || Array.isArray(exit)) {
    return "command_failed";
  }
  const record = exit as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === "exit_code") {
    const code = record["exit_code"];
    if (typeof code === "number" && Number.isInteger(code) && code > 0) {
      return `exit-${String(code)}`;
    }
    return "command_failed";
  }
  if (keys.length === 1 && keys[0] === "signal") {
    const signal = record["signal"];
    if (typeof signal === "number" && Number.isInteger(signal) && signal > 0) {
      return `signal-${String(signal)}`;
    }
    return "command_failed";
  }
  return "command_failed";
}

function protocolCodeFailure(
  code: string,
  details: unknown,
): { failure: HostStateFailure; code: string } | null {
  switch (code) {
    case "command_unsupported":
      return { failure: "daemon-unsupported", code };
    case "command_package_not_installed":
    case "command_not_selected":
    case "command_not_declared":
      return { failure: "plugin-missing", code };
    case "command_package_disabled":
      return { failure: "plugin-disabled", code };
    case "command_busy":
      return { failure: "plugin-busy", code };
    case "command_failed":
      return { failure: "plugin-failed", code: pluginFailedForDetails(details) };
    case "command_unavailable":
      return { failure: "daemon-rejected", code };
    case "command_timed_out":
      return { failure: "plugin-timeout", code };
    case "command_output_too_large":
      return { failure: "output-too-large", code };
    case "command_output_not_utf8":
      return { failure: "output-invalid", code };
    case "command_not_exposed":
      return { failure: "daemon-rejected", code };
    default:
      return { failure: "daemon-rejected", code };
  }
}

export function hostStateErrorOf(error: unknown): HostStateError | null {
  if (error instanceof PortUnreachableError) {
    return new HostStateError("host-unreachable", null);
  }
  if (!(error instanceof ClientError)) {
    return null;
  }
  switch (error.kind) {
    case "daemonUnreachable":
    case "hostUnreachable":
    case "remoteDaemonUnavailable":
    case "io":
    case "framing":
      return new HostStateError("host-unreachable", error.code);
    case "requestTimeout":
      return new HostStateError("request-timeout", error.code);
    case "commandUnsupported":
    case "daemonProtocolTooOld":
      return new HostStateError("daemon-unsupported", error.code);
    case "versionMismatch":
    case "versionTranslation":
    case "json":
      return new HostStateError("daemon-rejected", error.code);
    case "protocol":
    case "remoteProtocol": {
      const mapped = protocolCodeFailure(error.code, error.details);
      if (mapped === null) {
        return null;
      }
      return new HostStateError(mapped.failure, mapped.code);
    }
    default:
      return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function hostStateReplyOf(result: unknown): HostStateReply {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new HostStateError("daemon-rejected", "reply-incomplete");
  }
  const record = result as Record<string, unknown>;
  const pkg = record["package"];
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    throw new HostStateError("daemon-rejected", "reply-incomplete");
  }
  const pkgRecord = pkg as Record<string, unknown>;
  const packageId = pkgRecord["id"];
  const version = pkgRecord["version"];
  const digest = record["digest"];
  const stdout = record["output"];
  if (
    !isNonEmptyString(packageId) ||
    !isNonEmptyString(version) ||
    !isNonEmptyString(digest) ||
    typeof stdout !== "string"
  ) {
    throw new HostStateError("daemon-rejected", "reply-incomplete");
  }
  const reply: CommandRunResult = result as CommandRunResult;
  return {
    identity: { packageId: reply.package.id, version: reply.package.version, digest: reply.digest },
    stdout: reply.output,
  };
}

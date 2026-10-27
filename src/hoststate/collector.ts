import { createHash } from "node:crypto";
import { contractErrors, isHostCapacity } from "../../contracts/v1/validate.js";
import type { HostCapacity } from "../../contracts/v1/types.js";
import type { HostStateConfig } from "./config.js";
import {
  HostStateError,
  type HostStateFailure,
  type HostStateLimits,
  type HostStatePort,
  type HostStateReply,
  type PluginIdentity,
} from "./port.js";

export type UnavailableCause =
  | HostStateFailure
  | "package-mismatch"
  | "version-not-accepted"
  | "not-json"
  | "contract-invalid"
  | "alias-mismatch"
  | "stale"
  | "future-timestamp";

export type HostObservation =
  | {
      readonly kind: "reported";
      readonly hostAlias: string;
      readonly observedAt: string;
      readonly plugin: PluginIdentity;
      readonly capacity: HostCapacity;
    }
  | {
      readonly kind: "unavailable";
      readonly hostAlias: string;
      readonly observedAt: string;
      readonly cause: UnavailableCause;
      readonly detail: string;
    };

export interface HostStateLogEvent {
  readonly event: "host-state";
  readonly hostAlias: string;
  readonly kind: "reported" | "unavailable";
  readonly cause: UnavailableCause | null;
  readonly detail: string | null;
  readonly packageVersion: string | null;
  readonly packageDigest: string | null;
  readonly durationMs: number;
  readonly stdoutBytes: number | null;
  readonly stdoutSha256: string | null;
}

export interface CollectorDeps {
  readonly port: HostStatePort;
  readonly config: HostStateConfig;
  readonly now: () => Date;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly log: (event: HostStateLogEvent) => void;
}

export interface HostStateCollector {
  collect(): Promise<readonly HostObservation[]>;
}

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function firstErrorDetail(errors: unknown): string {
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { instancePath?: unknown; keyword?: unknown };
    const path =
      typeof first.instancePath === "string" && first.instancePath !== ""
        ? first.instancePath
        : "/";
    const keyword = typeof first.keyword === "string" ? first.keyword : "invalid";
    return `${path} ${keyword}`;
  }
  return "/ invalid";
}

function parseSingleDocument(stdout: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  // JSON.parse accepts exactly one document: trailing content such as
  // "{}\n{}" throws, which is the multi-document case the design names.
  try {
    return { ok: true, value: JSON.parse(stdout) as unknown };
  } catch {
    return { ok: false };
  }
}

function unavailable(
  hostAlias: string,
  observedAt: string,
  cause: UnavailableCause,
  detail: string,
): HostObservation {
  return { kind: "unavailable", hostAlias, observedAt, cause, detail };
}

// Pure. Collector rule steps 2 to 8 for one reply.
export function observe(
  hostAlias: string,
  reply: HostStateReply,
  config: HostStateConfig,
  now: Date,
): HostObservation {
  const observedAt = now.toISOString();
  const collector = config.collector;
  if (reply.identity.packageId !== config.package.id) {
    return unavailable(hostAlias, observedAt, "package-mismatch", "package id differs");
  }
  const stdoutBytes = Buffer.byteLength(reply.stdout, "utf8");
  if (stdoutBytes > collector.maxOutputBytes) {
    return unavailable(hostAlias, observedAt, "output-too-large", `${String(stdoutBytes)} bytes`);
  }
  if (!collector.acceptedVersions.includes(reply.identity.version)) {
    const detail = versionPattern.test(reply.identity.version)
      ? `version ${reply.identity.version}`
      : "version unparseable";
    return unavailable(hostAlias, observedAt, "version-not-accepted", detail);
  }
  const parsed = parseSingleDocument(reply.stdout);
  if (!parsed.ok) {
    return unavailable(hostAlias, observedAt, "not-json", "stdout is not one JSON document");
  }
  if (!isHostCapacity(parsed.value)) {
    return unavailable(
      hostAlias,
      observedAt,
      "contract-invalid",
      firstErrorDetail(contractErrors("host-capacity", parsed.value)),
    );
  }
  if (parsed.value.memory.freeMb > parsed.value.memory.totalMb) {
    return unavailable(
      hostAlias,
      observedAt,
      "contract-invalid",
      "memory.freeMb above memory.totalMb",
    );
  }
  if (parsed.value.hostAlias !== hostAlias) {
    return unavailable(
      hostAlias,
      observedAt,
      "alias-mismatch",
      `reported ${parsed.value.hostAlias}`,
    );
  }
  const guardMs = collector.pluginTimeoutMs + 2 * collector.transportMarginMs;
  const atMs = now.getTime();
  const stampMs = Date.parse(parsed.value.timestamp);
  if (atMs - stampMs > guardMs + collector.maxClockSkewMs) {
    return unavailable(hostAlias, observedAt, "stale", `age ${String(atMs - stampMs)} ms`);
  }
  if (stampMs - atMs > collector.maxClockSkewMs) {
    return unavailable(
      hostAlias,
      observedAt,
      "future-timestamp",
      `ahead ${String(stampMs - atMs)} ms`,
    );
  }
  return {
    kind: "reported",
    hostAlias,
    observedAt,
    plugin: reply.identity,
    capacity: parsed.value,
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function logObservation(
  deps: Pick<CollectorDeps, "log" | "now">,
  hostAlias: string,
  observation: HostObservation,
  startedAtMs: number,
  stdout: string | null,
): void {
  const durationMs = deps.now().getTime() - startedAtMs;
  const stdoutBytes = stdout === null ? null : Buffer.byteLength(stdout, "utf8");
  const stdoutSha256 = stdout === null ? null : sha256Hex(stdout);
  if (observation.kind === "reported") {
    deps.log({
      event: "host-state",
      hostAlias,
      kind: "reported",
      cause: null,
      detail: null,
      packageVersion: observation.plugin.version,
      packageDigest: observation.plugin.digest,
      durationMs,
      stdoutBytes,
      stdoutSha256,
    });
    return;
  }
  deps.log({
    event: "host-state",
    hostAlias,
    kind: "unavailable",
    cause: observation.cause,
    detail: observation.detail,
    packageVersion: null,
    packageDigest: null,
    durationMs,
    stdoutBytes,
    stdoutSha256,
  });
}

async function collectOne(
  deps: CollectorDeps,
  hostAlias: string,
  limits: HostStateLimits,
  guardMs: number,
): Promise<HostObservation> {
  const startedAtMs = deps.now().getTime();
  const controller = new AbortController();
  const timeout = deps.sleep(guardMs, controller.signal).then(() => "guard" as const);
  timeout.catch(() => {});
  const reply = deps.port
    .read(hostAlias, deps.config.package.id, limits)
    .then(
      (value) => ({ kind: "reply" as const, value }),
      (error: unknown) => ({ kind: "thrown" as const, error }),
    );
  reply.catch(() => {});
  const winner = await Promise.race([reply, timeout]);
  controller.abort();
  if (winner === "guard") {
    const observation = unavailable(
      hostAlias,
      deps.now().toISOString(),
      "request-timeout",
      `no reply within ${String(guardMs)} ms`,
    );
    logObservation(deps, hostAlias, observation, startedAtMs, null);
    return observation;
  }
  if (winner.kind === "thrown") {
    if (winner.error instanceof HostStateError) {
      const detail =
        winner.error.code === null
          ? winner.error.failure
          : `${winner.error.failure} (${winner.error.code})`;
      const observation = unavailable(
        hostAlias,
        deps.now().toISOString(),
        winner.error.failure,
        detail,
      );
      logObservation(deps, hostAlias, observation, startedAtMs, null);
      return observation;
    }
    throw winner.error;
  }
  const observation = observe(hostAlias, winner.value, deps.config, deps.now());
  const stamped: HostObservation = { ...observation, observedAt: deps.now().toISOString() };
  logObservation(deps, hostAlias, stamped, startedAtMs, winner.value.stdout);
  return stamped;
}

export function createCollector(deps: CollectorDeps): HostStateCollector {
  const collector = deps.config.collector;
  const limits: HostStateLimits = {
    pluginTimeoutMs: collector.pluginTimeoutMs,
    requestTimeoutMs: collector.pluginTimeoutMs + collector.transportMarginMs,
    maxOutputBytes: collector.maxOutputBytes,
  };
  const guardMs = collector.pluginTimeoutMs + 2 * collector.transportMarginMs;
  let inFlight: Promise<readonly HostObservation[]> | null = null;

  async function round(): Promise<readonly HostObservation[]> {
    const aliases = deps.port.hosts();
    const seen = new Set<string>();
    for (const alias of aliases) {
      if (seen.has(alias)) {
        throw new Error(`Duplicate host alias ${alias}`);
      }
      seen.add(alias);
    }
    return Promise.all(aliases.map((alias) => collectOne(deps, alias, limits, guardMs)));
  }

  function collect(): Promise<readonly HostObservation[]> {
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = round().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { collect };
}

export type { HostStateFailure };

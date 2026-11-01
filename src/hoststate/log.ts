// Recorded host-state probes: reads the host-state events the loop appends
// to loop-ports.jsonl and keeps, per alias, the newest probe at or before a
// time. Only ts, hostAlias, kind and cause are read; detail, package and
// stdout fields stay in the log. Lines of other sources are skipped.
import { readInputText, statInputPath } from "../fs/input.js";
import { HOST_STATE_FAILURES } from "./port.js";
import { COLLECTOR_ONLY_CAUSES, type UnavailableCause } from "./collector.js";

export class HostStateLogDataError extends Error {}

export interface RecordedProbe {
  readonly hostAlias: string;
  readonly at: string;
  readonly kind: "reported" | "unavailable";
  readonly cause: UnavailableCause | null;
}

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// The loop stamps every line with Date.prototype.toISOString().
const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CAUSES: ReadonlySet<string> = new Set<string>([
  ...HOST_STATE_FAILURES,
  ...COLLECTOR_ONLY_CAUSES,
]);

// Problems name the field, never its value: a bad alias may be a host name.
function probeOf(line: Record<string, unknown>, where: string): RecordedProbe {
  const { ts, hostAlias, kind, cause } = line;
  if (typeof ts !== "string" || !TS_PATTERN.test(ts) || !Number.isFinite(Date.parse(ts))) {
    throw new HostStateLogDataError(`${where}: invalid ts`);
  }
  if (typeof hostAlias !== "string" || !ALIAS_PATTERN.test(hostAlias)) {
    throw new HostStateLogDataError(`${where}: invalid hostAlias`);
  }
  if (kind === "reported" && cause === null) {
    return { hostAlias, at: ts, kind, cause: null };
  }
  if (kind === "unavailable" && typeof cause === "string" && CAUSES.has(cause)) {
    return { hostAlias, at: ts, kind, cause: cause as UnavailableCause };
  }
  throw new HostStateLogDataError(`${where}: invalid kind or cause`);
}

// Null for an absent log whose parent exists; the caller words it. Path
// failures throw InputPathError, bad lines HostStateLogDataError. A
// non-empty last segment is the torn tail of an append in flight, ignored.
export async function readRecordedProbes(
  path: string,
  asOf: Date,
): Promise<readonly RecordedProbe[] | null> {
  const label = "host-state log";
  if ((await statInputPath(label, path)) === "absent") {
    return null;
  }
  const text = await readInputText(label, path);
  const body = text.split("\n").slice(0, -1);
  const limit = asOf.getTime();
  const newest = new Map<string, RecordedProbe>();
  body.forEach((segment, index) => {
    const where = `${label} ${path}: line ${String(index + 1)}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment) as unknown;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        throw new HostStateLogDataError(`${where}: not JSON`, { cause: error });
      }
      throw error;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HostStateLogDataError(`${where}: not a JSON object`);
    }
    const line = parsed as Record<string, unknown>;
    if (line.source !== "host-state") {
      return;
    }
    const probe = probeOf(line, where);
    if (Date.parse(probe.at) > limit) {
      return;
    }
    const seen = newest.get(probe.hostAlias);
    if (seen === undefined || probe.at >= seen.at) {
      newest.set(probe.hostAlias, probe);
    }
  });
  return [...newest.values()].sort((a, b) =>
    a.hostAlias < b.hostAlias ? -1 : a.hostAlias > b.hostAlias ? 1 : 0,
  );
}

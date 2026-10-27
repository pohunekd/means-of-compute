// Meter usage-log store: replay predicates of design section 4.3 and the
// guarded single-writer append chain of section 5.
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import type { TerminalState } from "../dispatcher/port.js";
import { requireInputDir, statInputPath } from "../fs/input.js";
import type { MeterLogEvent } from "./meter.js";
import schema from "./usage-log.schema.json" with { type: "json" };

export interface GrantOpenRecord {
  readonly kind: "grant-open";
  readonly at: string;
  readonly requestId: string;
  readonly workItemId: string;
  readonly hostAlias: string;
  readonly providerId: string;
  readonly model: string;
}

export interface GrantBindRecord {
  readonly kind: "grant-bind";
  readonly at: string;
  readonly requestId: string;
  readonly sessionId: string;
}

export interface GrantCloseRecord {
  readonly kind: "grant-close";
  readonly at: string;
  readonly requestId: string;
  readonly state: TerminalState;
}

export interface CallStartRecord {
  readonly kind: "call-start";
  readonly at: string;
  readonly callId: string;
  readonly requestId: string;
  readonly providerId: string;
  readonly model: string;
  readonly stream: boolean;
}

export type CallOutcome =
  | "ok"
  | "no-usage"
  | "first-byte-timeout"
  | "idle-timeout"
  | "total-timeout"
  | "upstream-broken"
  | "upstream-error"
  | "upstream-status"
  | "upstream-unreachable"
  | "closed-abort";

export interface CallEndRecord {
  readonly kind: "call-end";
  readonly at: string;
  readonly callId: string;
  readonly requestId: string;
  readonly outcome: CallOutcome;
  readonly billed: boolean;
  readonly status: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly clientGone: boolean;
  readonly ms: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

export type UsageLogRecord =
  GrantOpenRecord | GrantBindRecord | GrantCloseRecord | CallStartRecord | CallEndRecord;

export interface GrantState {
  readonly open: GrantOpenRecord;
  lastOpenAt: string;
  sessionId: string | null;
  closed: boolean;
}

export interface UsageIndex {
  readonly grants: ReadonlyMap<string, GrantState>;
  readonly requestBySession: ReadonlyMap<string, string>;
  readonly starts: ReadonlyMap<string, CallStartRecord>;
  readonly startOrder: readonly string[];
  readonly ends: ReadonlyMap<string, CallEndRecord>;
}

export class MeterLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeterLogError";
  }
}

export type GuardFailure = "grant-closed" | "session-concurrency" | "meter-unavailable";

export interface UsageAppender {
  appendGuarded(
    record: UsageLogRecord,
    guard: (index: UsageIndex) => GuardFailure | null,
  ): Promise<GuardFailure | null>;
  appendUnguarded(record: UsageLogRecord): Promise<void>;
  readonly failed: boolean;
  close(): Promise<void>;
}

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const validateRecord = ajv.compile(schema as object);

// Billed outcomes mirror section 3.7: upstream-status and
// upstream-unreachable are the only unbilled ends.
export function billedForOutcome(outcome: CallOutcome): boolean {
  return outcome !== "upstream-status" && outcome !== "upstream-unreachable";
}

interface MutableIndex {
  readonly grants: Map<string, GrantState>;
  readonly requestBySession: Map<string, string>;
  readonly starts: Map<string, CallStartRecord>;
  readonly startOrder: string[];
  readonly ends: Map<string, CallEndRecord>;
}

function emptyMutableIndex(): MutableIndex {
  return {
    grants: new Map(),
    requestBySession: new Map(),
    starts: new Map(),
    startOrder: [],
    ends: new Map(),
  };
}

function toUsageIndex(mutable: MutableIndex): UsageIndex {
  return {
    grants: mutable.grants,
    requestBySession: mutable.requestBySession,
    starts: mutable.starts,
    startOrder: mutable.startOrder,
    ends: mutable.ends,
  };
}

function fail(path: string, line: number, detail: string): never {
  throw new MeterLogError(`${path}:${String(line)}: ${detail}`);
}

function checkAt(path: string, line: number, at: string): void {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== at) {
    fail(path, line, "invalid at timestamp");
  }
}

function applyRecord(
  mutable: MutableIndex,
  record: UsageLogRecord,
  path: string,
  line: number,
): void {
  checkAt(path, line, record.at);
  switch (record.kind) {
    case "grant-open": {
      const existing = mutable.grants.get(record.requestId);
      if (existing === undefined) {
        mutable.grants.set(record.requestId, {
          open: record,
          lastOpenAt: record.at,
          sessionId: null,
          closed: false,
        });
      } else {
        const first = existing.open;
        if (
          first.workItemId !== record.workItemId ||
          first.hostAlias !== record.hostAlias ||
          first.providerId !== record.providerId ||
          first.model !== record.model
        ) {
          fail(path, line, "grant-open conflicts with an earlier grant-open");
        }
        existing.lastOpenAt = record.at;
      }
      break;
    }
    case "grant-bind": {
      const grant = mutable.grants.get(record.requestId);
      if (grant === undefined) {
        fail(path, line, "grant-bind without an earlier grant-open");
      }
      if (grant.sessionId === record.sessionId) {
        fail(path, line, "duplicate grant-bind");
      }
      if (grant.sessionId !== null) {
        fail(path, line, "grant already bound to another session");
      }
      const other = mutable.requestBySession.get(record.sessionId);
      if (other !== undefined && other !== record.requestId) {
        fail(path, line, "session already bound to another grant");
      }
      grant.sessionId = record.sessionId;
      mutable.requestBySession.set(record.sessionId, record.requestId);
      break;
    }
    case "grant-close": {
      const grant = mutable.grants.get(record.requestId);
      if (grant === undefined) {
        fail(path, line, "grant-close without an earlier grant-open");
      }
      if (grant.closed) {
        fail(path, line, "duplicate grant-close");
      }
      grant.closed = true;
      break;
    }
    case "call-start": {
      const grant = mutable.grants.get(record.requestId);
      if (grant === undefined) {
        fail(path, line, "call-start without an earlier grant-open");
      }
      if (grant.closed) {
        fail(path, line, "call-start after grant-close");
      }
      if (mutable.starts.has(record.callId)) {
        fail(path, line, "duplicate callId");
      }
      if (record.providerId !== grant.open.providerId || record.model !== grant.open.model) {
        fail(path, line, "call-start provider or model differs from the grant");
      }
      mutable.starts.set(record.callId, record);
      mutable.startOrder.push(record.callId);
      break;
    }
    case "call-end": {
      const start = mutable.starts.get(record.callId);
      if (start === undefined || start.requestId !== record.requestId) {
        fail(path, line, "call-end without a matching call-start");
      }
      if (mutable.ends.has(record.callId)) {
        fail(path, line, "duplicate call-end");
      }
      if (billedForOutcome(record.outcome) !== record.billed) {
        fail(path, line, "call-end billed flag does not match its outcome");
      }
      mutable.ends.set(record.callId, record);
      break;
    }
  }
}

function readTornTail(text: string): { readonly body: string; readonly dropped: number } {
  if (text === "" || text.endsWith("\n")) {
    return { body: text, dropped: 0 };
  }
  const cut = text.lastIndexOf("\n") + 1;
  return { body: text.slice(0, cut), dropped: text.length - cut };
}

async function readLogBody(
  path: string,
  mode: "repair" | "read-only",
  log: (e: MeterLogEvent) => void,
): Promise<string> {
  await requireInputDir("Meter usage log", dirname(path));
  if ((await statInputPath("Meter usage log", path)) === "absent") {
    return "";
  }
  const file = Bun.file(path);
  const text = await file.text();
  const { body, dropped } = readTornTail(text);
  if (dropped > 0) {
    if (mode === "repair") {
      const handle = await open(path, "r+");
      try {
        await handle.truncate(body.length);
        await handle.sync();
      } finally {
        await handle.close();
      }
      log({ level: "warn", event: "usage-log-torn-tail", count: dropped });
    }
  }
  return body;
}

export async function replayUsageLog(
  path: string,
  mode: "repair" | "read-only",
  log: (e: MeterLogEvent) => void,
): Promise<UsageIndex> {
  const body = await readLogBody(path, mode, log);
  const mutable = emptyMutableIndex();
  if (body === "") {
    return toUsageIndex(mutable);
  }
  const lines = body.split("\n");
  // The trailing newline leaves an empty final element; torn tails were cut above.
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i] as string;
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      fail(path, lineNo, "line is not valid JSON");
    }
    if (!validateRecord(parsed)) {
      fail(path, lineNo, "line does not match the usage-log schema");
    }
    applyRecord(mutable, parsed as UsageLogRecord, path, lineNo);
  }
  return toUsageIndex(mutable);
}

export async function openUsageAppender(
  path: string,
  index: UsageIndex,
  log: (e: MeterLogEvent) => void,
): Promise<UsageAppender> {
  await requireInputDir("Meter usage log", dirname(path));
  const mutable = index as MutableIndex;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "a", 0o600);
  } catch (error: unknown) {
    throw new MeterLogError(
      `Meter usage log ${path}: cannot open log (${String((error as NodeJS.ErrnoException).code)})`,
    );
  }
  let failed = false;
  let chain: Promise<void> = Promise.resolve();

  function failLatch(error: unknown): void {
    failed = true;
    const detail = error instanceof Error ? error.name : String(error);
    log({ level: "error", event: "usage-log-failed", outcome: detail });
  }

  function writeLine(record: UsageLogRecord): Promise<void> {
    const step = chain.then(async () => {
      if (failed) {
        throw new MeterLogError(`Meter usage log ${path}: writer failed`);
      }
      try {
        await handle.write(`${JSON.stringify(record)}\n`);
        await handle.datasync();
        applyRecord(mutable, record, path, 0);
      } catch (error: unknown) {
        failLatch(error);
        throw new MeterLogError(`Meter usage log ${path}: append failed`);
      }
    });
    // A caller awaiting one step must not observe another step's rejection.
    chain = step.catch(() => {});
    return step;
  }

  return {
    async appendGuarded(
      record: UsageLogRecord,
      guard: (index: UsageIndex) => GuardFailure | null,
    ): Promise<GuardFailure | null> {
      let verdict: GuardFailure | null = null;
      const step = chain.then(async () => {
        if (failed) {
          verdict = "meter-unavailable";
          return;
        }
        verdict = guard(index);
        if (verdict !== null) {
          return;
        }
        try {
          await handle.write(`${JSON.stringify(record)}\n`);
          await handle.datasync();
          applyRecord(mutable, record, path, 0);
        } catch (error: unknown) {
          failLatch(error);
          verdict = "meter-unavailable";
          throw new MeterLogError(`Meter usage log ${path}: append failed`);
        }
      });
      chain = step.catch(() => {});
      await step.catch(() => {});
      return verdict;
    },
    async appendUnguarded(record: UsageLogRecord): Promise<void> {
      await writeLine(record);
    },
    get failed(): boolean {
      return failed;
    },
    async close(): Promise<void> {
      await chain;
      await handle.close();
    },
  };
}

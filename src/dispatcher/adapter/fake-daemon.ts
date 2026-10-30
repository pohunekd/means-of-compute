// In-memory fake daemon (design section 6.1): builds real SDK Clients
// over the Transport seam, so protocol framing, the version probe and error
// decoding run real SDK code. Nothing in src/ imports this file.
import {
  Client,
  ClientError,
  type AgentActivity,
  type CommandRunResult,
  type ControlChannel,
  type ErrorDetails,
  type HostCapabilities,
  type SessionDiffResult,
  type SessionInfo,
  type SessionNewParams,
  type SessionNewResult,
  type SessionRuntime,
  type SessionState,
  type SessionWaitTurnResult,
  type Transport,
} from "@pohunek/sdk";
import { PortRejectedError } from "../port.js";
import type { HostConnector } from "./connection.js";

interface SessionPatch {
  readonly state?: SessionState;
  readonly exit_code?: number;
  readonly runtime?: SessionRuntime;
  readonly activity?: AgentActivity;
  readonly turn_started_at?: string;
  readonly metadata?: Record<string, string>;
}

type FakeFailure =
  | { readonly error: ClientError; readonly apply: boolean }
  | { readonly errCode: string; readonly apply: boolean };

export type FakeCommandOutcome =
  { readonly ok: CommandRunResult } | { readonly errCode: string; readonly details?: ErrorDetails };

export interface FakeDaemon {
  readonly connector: HostConnector;
  setCapabilities(alias: string, caps: Partial<HostCapabilities>): void;
  onNew(alias: string, reply: (params: SessionNewParams) => Partial<SessionNewResult>): void;
  setSession(alias: string, id: string, patch: SessionPatch): void;
  queueWaitTurn(alias: string, result: SessionWaitTurnResult): void;
  setDiff(alias: string, id: string, result: SessionDiffResult): void;
  setCommand(alias: string, outcome: FakeCommandOutcome): void;
  failNext(alias: string, method: string, failure: FakeFailure): void;
  pauseNext(alias: string, method: string): Promise<{ release(): void }>;
  setUnreachable(alias: string, on: boolean): void;
  sessions(alias: string): readonly SessionInfo[];
  calls(alias: string): readonly { readonly method: string; readonly params: unknown }[];
}

interface WireRequest {
  readonly v: unknown;
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
}

interface PauseGate {
  notified: () => void;
  wait: Promise<void>;
  release: () => void;
}

interface AliasState {
  caps: HostCapabilities;
  sessions: Map<string, SessionInfo>;
  seq: number;
  cursor: number;
  newOverride: ((params: SessionNewParams) => Partial<SessionNewResult>) | null;
  waitQueue: SessionWaitTurnResult[];
  diffs: Map<string, SessionDiffResult>;
  commandOutcomes: Map<string, FakeCommandOutcome>;
  failures: Map<string, FakeFailure>;
  pauses: Map<string, PauseGate[]>;
  unreachable: boolean;
  calls: { readonly method: string; readonly params: unknown }[];
}

const DAEMON_VERSION = "0.37.0-fake";

const FAKE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const AGENT_ACTIVITIES: ReadonlySet<unknown> = new Set(["working", "idle", "blocked"]);

function isAgentActivity(value: unknown): value is AgentActivity {
  return AGENT_ACTIVITIES.has(value);
}

function defaultCaps(profile: string): HostCapabilities {
  return {
    daemon_version: DAEMON_VERSION,
    protocol_version: 4,
    supported_agents: [profile],
    runtimes: [{ agent: profile, available: true }],
    git_available: true,
    worktree_supported: true,
    terminal_read_supported: true,
    output_read_supported: true,
    session_wait_supported: true,
    session_wait_turn_supported: true,
    session_new_branch_source_supported: true,
    session_new_input_ack_supported: true,
  };
}

function errLine(id: string, code: string, details?: ErrorDetails): string {
  return JSON.stringify({
    v: 4,
    id,
    err: {
      class: "daemon",
      code,
      msg: `fake daemon refused: ${code}`,
      ...(details === undefined ? {} : { details }),
    },
  });
}

function okLine(id: string, result: unknown): string {
  return JSON.stringify({ v: 4, id, ok: result });
}

class FakeChannel implements ControlChannel {
  private readonly queue: string[] = [];
  private readonly wakeups: (() => void)[] = [];
  private closed = false;
  private readonly iterable: AsyncIterable<string>;

  constructor(private readonly handle: (line: string) => Promise<string | ClientError>) {
    this.iterable = {
      [Symbol.asyncIterator]: (): AsyncIterator<string> => this.drain(),
    };
  }

  async send(line: string): Promise<void> {
    const outcome = await this.handle(line);
    if (outcome instanceof ClientError) {
      throw outcome;
    }
    this.enqueue(outcome);
  }

  get lines(): AsyncIterable<string> {
    return this.iterable;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const wake of this.wakeups.splice(0)) {
      wake();
    }
    await Promise.resolve();
  }

  private enqueue(line: string): void {
    this.queue.push(line);
    for (const wake of this.wakeups.splice(0)) {
      wake();
    }
  }

  private async take(): Promise<string | undefined> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        return next;
      }
      if (this.closed) {
        return undefined;
      }
      await new Promise<void>((resolve) => {
        this.wakeups.push(resolve);
      });
    }
  }

  private async *drain(): AsyncGenerator<string> {
    for (;;) {
      const next = await this.take();
      if (next === undefined) {
        return;
      }
      yield next;
    }
  }
}

function listMatches(info: SessionInfo, filters: readonly unknown[]): boolean {
  for (const filter of filters) {
    if (typeof filter !== "object" || filter === null) {
      return false;
    }
    const entry = filter as { key?: unknown; value?: unknown };
    if (entry.key === "metadata_eq") {
      const value = entry.value as { key?: unknown; value?: unknown };
      if (info.metadata?.[String(value.key)] !== String(value.value)) {
        return false;
      }
    } else if (entry.key === "metadata_has") {
      const value = entry.value as { key?: unknown };
      if (!(String(value.key) in (info.metadata ?? {}))) {
        return false;
      }
    } else if (entry.key === "id") {
      if (info.id !== String(entry.value)) {
        return false;
      }
    } else if (entry.key === "state") {
      if (info.state !== String(entry.value)) {
        return false;
      }
    } else if (entry.key === "agent") {
      if (info.agent !== String(entry.value)) {
        return false;
      }
    }
  }
  return true;
}

export function createFakeDaemon(aliases: readonly string[], profile: string): FakeDaemon {
  const states = new Map<string, AliasState>();
  for (const alias of aliases) {
    states.set(alias, {
      caps: defaultCaps(profile),
      sessions: new Map(),
      seq: 0,
      cursor: 0,
      newOverride: null,
      waitQueue: [],
      diffs: new Map(),
      commandOutcomes: new Map(),
      failures: new Map(),
      pauses: new Map(),
      unreachable: false,
      calls: [],
    });
  }

  function stateOf(alias: string): AliasState {
    const state = states.get(alias);
    if (state === undefined) {
      throw new Error(`fake daemon has no alias "${alias}"`);
    }
    return state;
  }

  function createSession(state: AliasState, alias: string, params: SessionNewParams): SessionInfo {
    state.seq += 1;
    const id = `fake-${String(state.seq)}`;
    return {
      id,
      capabilities: { resume: true, fork: true },
      agent: params.agent,
      agent_base: params.agent,
      cwd: `/fake/${alias}/${String(state.seq)}`,
      pid: 1000 + state.seq,
      cols: params.cols,
      rows: params.rows,
      state: "running",
      state_source: "process",
      branch: params.branch,
      worktree_path: `/fake/${alias}/${String(state.seq)}`,
      warnings: [],
      metadata: { ...(params.metadata ?? {}) },
      created_at: "2026-10-27T00:00:00Z",
      updated_at: "2026-10-27T00:00:00Z",
    };
  }

  function waitProgress(
    state: AliasState,
    sessionIds: readonly unknown[],
  ): SessionWaitTurnResult["progress"] {
    return sessionIds.map((sessionId) => {
      const id = typeof sessionId === "string" ? sessionId : "";
      const info = state.sessions.get(id);
      return {
        session_id: id,
        state: info?.state ?? "running",
        output_advanced: false,
      };
    });
  }

  async function answer(
    state: AliasState,
    alias: string,
    request: WireRequest,
  ): Promise<string | ClientError> {
    await Promise.resolve();
    const params = request.params as Record<string, unknown>;
    switch (request.method) {
      case "daemon.health": {
        return okLine(request.id, {
          status: "ok",
          daemon_version: DAEMON_VERSION,
          protocol_version: 4,
        });
      }
      case "host.inspect": {
        return okLine(request.id, state.caps);
      }
      case "session.new": {
        const created = createSession(state, alias, params as unknown as SessionNewParams);
        const typed = params as unknown as SessionNewParams;
        const base: SessionNewResult = {
          ...created,
          ...(typeof typed.input === "string"
            ? { applied_input: true, prompt_delivered: true }
            : {}),
          ...(typed.branch_source === "remote"
            ? { worktree_source: { ref: `origin/${String(typed.branch)}`, commit: FAKE_COMMIT } }
            : {}),
        };
        const reply: SessionNewResult = { ...base, ...state.newOverride?.(typed) };
        const stored: SessionInfo = { ...created };
        if (reply.branch !== undefined) {
          stored.branch = reply.branch;
        }
        if (reply.worktree_path !== undefined) {
          stored.worktree_path = reply.worktree_path;
        }
        if (reply.worktree_source !== undefined) {
          (stored as Record<string, unknown>)["worktree_source"] = reply.worktree_source;
        }
        if (reply.applied_input !== undefined) {
          (stored as Record<string, unknown>)["applied_input"] = reply.applied_input;
        }
        if (reply.prompt_delivered !== undefined) {
          (stored as Record<string, unknown>)["prompt_delivered"] = reply.prompt_delivered;
        }
        if (reply.warnings !== undefined) {
          stored.warnings = reply.warnings;
        }
        if (reply.metadata !== undefined) {
          stored.metadata = reply.metadata;
        }
        state.sessions.set(stored.id, stored);
        return okLine(request.id, reply);
      }
      case "session.list": {
        const filters = (params["filters"] as readonly unknown[] | undefined) ?? [];
        const result = [...state.sessions.values()].filter((info) => listMatches(info, filters));
        return okLine(request.id, result);
      }
      case "session.inspect": {
        const params = String(request.params);
        const info = state.sessions.get(params);
        if (info === undefined) {
          return errLine(request.id, "session_not_found");
        }
        return okLine(request.id, info);
      }
      case "session.set_metadata": {
        const target = params["session_id"] as string;
        const info = state.sessions.get(target);
        if (info === undefined) {
          return errLine(request.id, "session_not_found");
        }
        const patch = params["metadata"] as Record<string, string | null>;
        const nextMetadata: Record<string, string> = {};
        for (const [keptKey, keptValue] of Object.entries(info.metadata ?? {})) {
          if (patch[keptKey] !== null) {
            nextMetadata[keptKey] = keptValue;
          }
        }
        for (const [key, value] of Object.entries(patch)) {
          if (value !== null) {
            nextMetadata[key] = value;
          }
        }
        const updated: SessionInfo = { ...info, metadata: nextMetadata };
        state.sessions.set(target, updated);
        return okLine(request.id, { session: updated });
      }
      case "session.remove_accepting_unconfirmed": {
        const target = String(request.params);
        if (!state.sessions.has(target)) {
          return errLine(request.id, "session_not_found");
        }
        state.sessions.delete(target);
        return okLine(request.id, {
          removed: true,
          stopped: false,
          worktrees_removed: 1,
          worktrees_failed: 0,
        });
      }
      case "session.stop": {
        const info = state.sessions.get(String(request.params));
        if (info === undefined) {
          return errLine(request.id, "session_not_found");
        }
        if (info.state === "starting" || info.state === "running") {
          state.sessions.set(info.id, { ...info, state: "stopped" });
          return okLine(request.id, { stopped: true });
        }
        return okLine(request.id, { stopped: false });
      }
      case "session.wait_turn": {
        const wanted = (params["session_ids"] as readonly unknown[] | undefined) ?? [];
        const missing = wanted.filter((id) => !state.sessions.has(String(id)));
        if (missing.length > 0) {
          return errLine(request.id, "session_not_found");
        }
        const queued = state.waitQueue.shift();
        if (queued !== undefined) {
          return okLine(request.id, queued);
        }
        state.cursor += 1;
        const progressIds = (params["session_ids"] as readonly unknown[] | undefined) ?? [];
        const progress = waitProgress(state, progressIds).map((entry) => {
          const info = state.sessions.get(entry.session_id) as Record<string, unknown> | undefined;
          const activity = info?.["activity"];
          const startedAt = info?.["turn_started_at"];
          return {
            ...entry,
            ...(isAgentActivity(activity) ? { activity } : {}),
            ...(typeof startedAt === "string" ? { turn_started_at: startedAt } : {}),
          };
        });
        return okLine(request.id, {
          reason: "timeout",
          cursor: `cursor-${String(state.cursor)}`,
          progress,
        } satisfies SessionWaitTurnResult);
      }
      case "session.diff": {
        const target = params["session_id"] as string;
        if (!state.sessions.has(target)) {
          return errLine(request.id, "session_not_found");
        }
        const stored = state.diffs.get(target);
        if (stored !== undefined) {
          return okLine(request.id, stored);
        }
        return okLine(request.id, {
          diff: "",
          base:
            typeof params["base"] === "string" && params["base"].length > 0
              ? params["base"]
              : "origin/main",
          truncated: false,
        } satisfies SessionDiffResult);
      }
      case "command.run": {
        const outcome = state.commandOutcomes.get(alias);
        if (outcome !== undefined) {
          if ("ok" in outcome) {
            return okLine(request.id, outcome.ok);
          }
          return errLine(request.id, outcome.errCode, outcome.details);
        }
        return errLine(request.id, "fake_unscripted");
      }
      default: {
        return errLine(request.id, "fake_unscripted");
      }
    }
  }

  async function handle(alias: string, line: string): Promise<string | ClientError> {
    const state = stateOf(alias);
    const request = JSON.parse(line) as WireRequest;
    if (request.method !== "daemon.health") {
      state.calls.push({ method: request.method, params: request.params });
    }
    const gates = state.pauses.get(request.method);
    if (gates !== undefined && gates.length > 0) {
      const gate = gates.shift();
      gate?.notified();
      await gate?.wait;
    }
    const failure = state.failures.get(request.method);
    if (failure !== undefined) {
      state.failures.delete(request.method);
      if ("error" in failure) {
        if (failure.apply) {
          await answer(state, alias, request);
        }
        return failure.error;
      }
      if (failure.apply) {
        await answer(state, alias, request);
      }
      return errLine(request.id, failure.errCode);
    }
    return answer(state, alias, request);
  }

  function transportFor(alias: string): Transport {
    return {
      control(): Promise<ControlChannel> {
        const state = stateOf(alias);
        if (state.unreachable) {
          throw fakeErrors.hostUnreachable(alias);
        }
        return Promise.resolve(new FakeChannel((line) => handle(alias, line)));
      },
      raw(): Promise<never> {
        throw new Error("fake daemon has no raw transport");
      },
    };
  }

  const clients = new Map<string, Client>();
  let closed = false;

  const connector: HostConnector = {
    aliases(): readonly string[] {
      return [...states.keys()];
    },
    async client(alias: string): Promise<Client> {
      if (closed) {
        throw new PortRejectedError("connector-closed");
      }
      const state = states.get(alias);
      if (state === undefined) {
        throw new PortRejectedError("unknown-host-alias");
      }
      if (state.unreachable) {
        throw fakeErrors.hostUnreachable(alias);
      }
      const cached = clients.get(alias);
      if (cached !== undefined) {
        return cached;
      }
      const created = await Client.connectTransport(transportFor(alias), {}, alias);
      clients.set(alias, created);
      return created;
    },
    async drop(alias: string): Promise<void> {
      const cached = clients.get(alias);
      if (cached === undefined) {
        return;
      }
      clients.delete(alias);
      await cached.close();
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      const cached = [...clients.values()];
      clients.clear();
      for (const client of cached) {
        await client.close();
      }
    },
  };

  return {
    connector,
    setCapabilities(alias: string, caps: Partial<HostCapabilities>): void {
      const state = stateOf(alias);
      state.caps = { ...state.caps, ...caps };
    },
    onNew(alias: string, reply: (params: SessionNewParams) => Partial<SessionNewResult>): void {
      stateOf(alias).newOverride = reply;
    },
    setSession(alias: string, id: string, patch: SessionPatch): void {
      const state = stateOf(alias);
      const info = state.sessions.get(id);
      if (info === undefined) {
        throw new Error(`fake daemon ${alias} has no session "${id}"`);
      }
      state.sessions.set(id, {
        ...info,
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.exit_code !== undefined ? { exit_code: patch.exit_code } : {}),
        ...(patch.runtime !== undefined ? { runtime: patch.runtime } : {}),
        ...(patch.activity !== undefined ? { activity: patch.activity } : {}),
        ...(patch.turn_started_at !== undefined ? { turn_started_at: patch.turn_started_at } : {}),
        ...(patch.metadata !== undefined
          ? { metadata: { ...(info.metadata ?? {}), ...patch.metadata } }
          : {}),
      });
    },
    queueWaitTurn(alias: string, result: SessionWaitTurnResult): void {
      stateOf(alias).waitQueue.push(result);
    },
    setDiff(alias: string, id: string, result: SessionDiffResult): void {
      stateOf(alias).diffs.set(id, result);
    },
    setCommand(alias: string, outcome: FakeCommandOutcome): void {
      stateOf(alias).commandOutcomes.set(alias, outcome);
    },
    failNext(alias: string, method: string, failure: FakeFailure): void {
      stateOf(alias).failures.set(method, failure);
    },
    pauseNext(alias: string, method: string): Promise<{ release(): void }> {
      const state = stateOf(alias);
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const arrived = new Promise<{ release(): void }>((resolve) => {
        const list = state.pauses.get(method) ?? [];
        list.push({
          notified: () => {
            resolve({
              release: () => {
                release();
              },
            });
          },
          wait,
          release: () => {
            release();
          },
        });
        state.pauses.set(method, list);
      });
      return arrived;
    },
    setUnreachable(alias: string, on: boolean): void {
      stateOf(alias).unreachable = on;
    },
    sessions(alias: string): readonly SessionInfo[] {
      return [...stateOf(alias).sessions.values()];
    },
    calls(alias: string): readonly { readonly method: string; readonly params: unknown }[] {
      return [...stateOf(alias).calls];
    },
  };
}

export const fakeErrors = {
  hostUnreachable(route: string): ClientError {
    return ClientError.hostUnreachable(route, new Error(`fake overlay to ${route} is down`));
  },
  requestTimeout(alias: string): ClientError {
    return ClientError.requestTimeout(alias, 5);
  },
  stopOutcomeUnknown(alias: string): ClientError {
    return ClientError.lifecycleOutcomeUnknown("stop", alias, 5);
  },
  versionMismatch(): ClientError {
    return ClientError.versionMismatch({ minimum: 3, maximum: 3 }, 4);
  },
  resumeOutcomeUnknown(alias: string): ClientError {
    return ClientError.lifecycleOutcomeUnknown("resume", alias, 5);
  },
};

// Driver park slice: stall and lost parking, operator holds, the
// escalate helper, blocked labelling, and the ledger finalize step.
import type { WorkItem } from "../../contracts/v1/types.js";
import { LedgerDataError, LedgerRefusal } from "../ledger/errors.js";
import { InputPathError } from "../fs/input.js";
import { finalizeUsage } from "../ledger/store.js";
import { GitHubError, type GitHubPort } from "./github.js";
import type { StallDecision } from "./policy.js";
import { updateLoopState } from "./state.js";
import type { Escalation, LoopItem } from "./types.js";
import type { CoreContext } from "./rounds.js";
import { reconcile } from "./project.js";

export interface ParkContext extends CoreContext {
  readonly github: GitHubPort;
  readonly factoryLogin: string;
  readonly ledgerPath: string;
  readonly escalationLabel: string;
  readonly readyLabel: string;
  readonly blockedLabel: string;
  readonly maxRetries: number;
}

export type ParkProgress = "done" | "pending";

const OPERATOR_CODE_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

// The marker line every escalation body starts with.
export function escalationMarker(key: string): string {
  return `<!-- moc:escalation:${key} -->`;
}

interface EscalationLookup {
  readonly key: string;
  readonly target: Escalation["target"];
  readonly body: string;
  readonly marker: string;
}

function escalationBody(item: WorkItem, li: LoopItem): string {
  const rounds = li.rounds.filter((record) => record.retry === li.retry);
  const summary =
    rounds.length === 0
      ? "none"
      : rounds.map((record) => `${String(record.round)}:${record.outcome}`).join(", ");
  let text = `Escalation for work item ${item.id}, retry ${String(li.retry)}: ${li.park?.reason ?? ""}.\n`;
  text += `Rounds: ${summary}`;
  if (li.pull !== null) {
    text += `\nPull request: #${String(li.pull.number)}`;
  }
  return text;
}

async function lookupPosted(
  ctx: ParkContext,
  item: WorkItem,
  lookup: EscalationLookup,
): Promise<number | null> {
  const target = lookup.target;
  if ("issue" in target) {
    const rows = await ctx.github.commentFirstLines(item.repo, target.issue);
    const found = rows.find((row) => row.login === ctx.factoryLogin && row.first === lookup.marker);
    return found === undefined ? null : target.issue;
  }
  const rows = await ctx.github.factoryIssues(item.repo, ctx.escalationLabel);
  const found = rows.find((row) => row.first === lookup.marker);
  return found === undefined ? null : found.number;
}

async function postEscalation(
  ctx: ParkContext,
  item: WorkItem,
  lookup: EscalationLookup,
): Promise<number> {
  const target = lookup.target;
  if ("issue" in target) {
    await ctx.github.postComment(item.repo, target.issue, lookup.body);
    return target.issue;
  }
  return ctx.github.createIssue(item.repo, `Escalation (${item.id})`, lookup.body, [
    ctx.escalationLabel,
  ]);
}

// One escalation per park key: adopt the factory marker when GitHub
// already carries it, otherwise post the fixed template body once.
export async function escalate(
  ctx: ParkContext,
  item: WorkItem,
  key: string,
  body: string,
): Promise<ParkProgress> {
  const lookup = await updateLoopState(ctx.statePath, (state) => {
    const li = state.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    const held = li.escalations.find((entry) => entry.key === key);
    if (held !== undefined && held.posted !== null) {
      return Promise.resolve({ next: null, value: null });
    }
    const marker = escalationMarker(key);
    const target: Escalation["target"] =
      item.issue === null ? { newIssue: true } : { issue: item.issue };
    const text = `${marker}\n${body}`;
    if (held !== undefined) {
      return Promise.resolve({
        next: null,
        value: { key, target, body: text, marker } satisfies EscalationLookup,
      });
    }
    const entry: Escalation = { key, retry: li.retry, target, posted: null };
    return Promise.resolve({
      next: {
        ...state,
        items: { ...state.items, [item.id]: { ...li, escalations: [...li.escalations, entry] } },
      },
      value: { key, target, body: text, marker } satisfies EscalationLookup,
    });
  });
  if (lookup === null) {
    return "done";
  }
  let posted: number;
  try {
    const found = await lookupPosted(ctx, item, lookup);
    posted = found ?? (await postEscalation(ctx, item, lookup));
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      ctx.log.log({
        event: "github-error",
        workItemId: item.id,
        code: error.kind,
        detail: error.step,
      });
      return "pending";
    }
    throw error;
  }
  await updateLoopState(ctx.statePath, (state) => {
    const li = state.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    const escalations = li.escalations.map((entry) =>
      entry.key === lookup.key ? { ...entry, posted } : entry,
    );
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [item.id]: { ...li, escalations } } },
      value: undefined,
    });
  });
  ctx.log.log({ event: "escalation", workItemId: item.id, code: key });
  return "done";
}

// Runs the ledger finalize once, then marks it done on the next tick
// retry; the work store projection never rolls back.
export async function finalizeItem(ctx: ParkContext, item: WorkItem): Promise<ParkProgress> {
  const input = await updateLoopState(ctx.statePath, (state) => {
    const li = state.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    if (li.finalize === null || li.finalize.done) {
      return Promise.resolve({ next: null, value: null });
    }
    return Promise.resolve({
      next: null,
      value: { result: li.finalize.result, retries: li.retry, human: li.humanInterventions },
    });
  });
  if (input === null) {
    return "done";
  }
  try {
    await finalizeUsage(ctx.ledgerPath, {
      workItemId: item.id,
      result: input.result,
      retries: input.retries,
      humanInterventions: input.human,
    });
  } catch (error: unknown) {
    if (error instanceof LedgerRefusal) {
      ctx.log.log({ event: "ledger-finalize-refused", workItemId: item.id, detail: error.message });
      return "pending";
    }
    if (
      error instanceof LedgerDataError ||
      error instanceof InputPathError ||
      error instanceof Error
    ) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.log.log({ event: "ledger-finalize-error", workItemId: item.id, detail });
      return "pending";
    }
    throw error;
  }
  await updateLoopState(ctx.statePath, (state) => {
    const li = state.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    if (li.finalize === null) {
      return Promise.resolve({ next: null, value: undefined });
    }
    return Promise.resolve({
      next: {
        ...state,
        items: { ...state.items, [item.id]: { ...li, finalize: { ...li.finalize, done: true } } },
      },
      value: undefined,
    });
  });
  return "done";
}

// T10: park after a lost close, and unpark on the next tick. Only the
// park field moves here; host exclusion belongs to slice 5c.
export async function parkLost(ctx: ParkContext, item: WorkItem): Promise<void> {
  const li = await updateLoopState(ctx.statePath, (state) => {
    const current = state.items[item.id] as unknown as LoopItem | undefined;
    if (current === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    const next = {
      ...current,
      park: { kind: "lost" as const, reason: "session lost", code: null },
    };
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [item.id]: next } },
      value: next,
    });
  });
  ctx.log.log({ event: "parked", workItemId: item.id, code: "lost" });
  await reconcile(ctx.storePath, item.id, li, ctx);
}

export async function unparkLost(ctx: ParkContext, item: WorkItem): Promise<void> {
  const result = await updateLoopState(ctx.statePath, (state) => {
    const current = state.items[item.id] as unknown as LoopItem | undefined;
    if (current === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    if (current.park === null || current.park.kind !== "lost") {
      return Promise.resolve({ next: null, value: null });
    }
    const next = { ...current, park: null };
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [item.id]: next } },
      value: next,
    });
  });
  if (result === null) {
    return;
  }
  ctx.log.log({ event: "unparked", workItemId: item.id });
  await reconcile(ctx.storePath, item.id, result, ctx);
}

// T12: the operator hold never retries on its own; a human unparks it.
export async function parkOperator(
  ctx: ParkContext,
  item: WorkItem,
  code: string,
): Promise<ParkProgress> {
  if (!OPERATOR_CODE_PATTERN.test(code)) {
    throw new Error(`invalid operator code ${JSON.stringify(code)}`);
  }
  const li = await updateLoopState(ctx.statePath, (state) => {
    const current = state.items[item.id] as unknown as LoopItem | undefined;
    if (current === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    const next = {
      ...current,
      park: { kind: "operator", reason: `operator: ${code}`, code },
      phase: "idle",
      start: null,
      session: null,
      requestId: null,
    };
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [item.id]: next } },
      value: next as LoopItem,
    });
  });
  ctx.log.log({ event: "parked", workItemId: item.id, code });
  await reconcile(ctx.storePath, item.id, li, ctx);
  return escalate(ctx, item, `op:${item.id}:${code}`, escalationBody(item, li));
}

// T9: stall parking after closeRound returned a park decision.
export async function parkStall(
  ctx: ParkContext,
  item: WorkItem,
  decision: Extract<StallDecision, { kind: "park" }>,
): Promise<ParkProgress> {
  const li = await updateLoopState(ctx.statePath, (state) => {
    const current = state.items[item.id] as unknown as LoopItem | undefined;
    if (current === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    const next = {
      ...current,
      park: { kind: "stall", reason: decision.statusReason, code: null },
    };
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [item.id]: next } },
      value: next as LoopItem,
    });
  });
  ctx.log.log({ event: "parked", workItemId: item.id, code: "stall" });
  await reconcile(ctx.storePath, item.id, li, ctx);
  return advancePark(ctx, item);
}

async function advanceStall(ctx: ParkContext, item: WorkItem, li: LoopItem): Promise<ParkProgress> {
  const key = `stall:${item.id}:${String(li.retry)}`;
  const escalated = await escalate(ctx, item, key, escalationBody(item, li));
  if (escalated === "pending") {
    return "pending";
  }
  const fresh = await updateLoopState(ctx.statePath, (state) => {
    const current = state.items[item.id] as unknown as LoopItem | undefined;
    if (current === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    return Promise.resolve({ next: null, value: current });
  });
  if (fresh.retry < ctx.maxRetries) {
    const next = await updateLoopState(ctx.statePath, (state) => {
      const current = state.items[item.id] as unknown as LoopItem | undefined;
      if (current === undefined) {
        throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
      }
      const moved = { ...current, retry: current.retry + 1, park: null };
      return Promise.resolve({
        next: { ...state, items: { ...state.items, [item.id]: moved } },
        value: moved,
      });
    });
    ctx.log.log({ event: "unparked", workItemId: item.id });
    await reconcile(ctx.storePath, item.id, next, ctx);
    return "done";
  }
  const blocked = await updateLoopState(ctx.statePath, (state) => {
    const current = state.items[item.id] as unknown as LoopItem | undefined;
    if (current === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    const moved = {
      ...current,
      park: {
        kind: "blocked",
        reason: `blocked: ${String(ctx.maxRetries)} retries used`,
        code: null,
      },
      finalize: { result: "blocked", done: false },
      phase: "final",
    };
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [item.id]: moved } },
      value: moved as LoopItem,
    });
  });
  ctx.log.log({ event: "blocked", workItemId: item.id, code: "retries" });
  await reconcile(ctx.storePath, item.id, blocked, ctx);
  return advanceBlocked(ctx, item);
}

async function advanceBlocked(ctx: ParkContext, item: WorkItem): Promise<ParkProgress> {
  const finalized = await finalizeItem(ctx, item);
  if (finalized === "pending") {
    return "pending";
  }
  if (item.issue === null) {
    return "done";
  }
  const journal = await updateLoopState(ctx.statePath, (state) => {
    const li = state.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    const key = `labels:${item.id}`;
    const held = li.escalations.find((entry) => entry.key === key);
    if (held !== undefined && held.posted !== null) {
      return Promise.resolve({ next: null, value: null });
    }
    if (held !== undefined) {
      return Promise.resolve({ next: null, value: key });
    }
    const issue = item.issue;
    if (issue === null) {
      return Promise.resolve({ next: null, value: null });
    }
    const entry: Escalation = { key, retry: li.retry, target: { issue }, posted: null };
    return Promise.resolve({
      next: {
        ...state,
        items: { ...state.items, [item.id]: { ...li, escalations: [...li.escalations, entry] } },
      },
      value: key,
    });
  });
  if (journal === null) {
    return "done";
  }
  try {
    await ctx.github.editIssueLabels(item.repo, item.issue, [ctx.blockedLabel], [ctx.readyLabel]);
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      ctx.log.log({
        event: "github-error",
        workItemId: item.id,
        code: error.kind,
        detail: error.step,
      });
      return "pending";
    }
    throw error;
  }
  await updateLoopState(ctx.statePath, (state) => {
    const li = state.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    const escalations = li.escalations.map((entry) =>
      entry.key === journal && item.issue !== null ? { ...entry, posted: item.issue } : entry,
    );
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [item.id]: { ...li, escalations } } },
      value: undefined,
    });
  });
  return "done";
}

// Inspects the loop item fresh and runs the first unfinished step,
// then the next, until it is done or a step stays pending.
export async function advancePark(ctx: ParkContext, item: WorkItem): Promise<ParkProgress> {
  const li = await updateLoopState(ctx.statePath, (state) => {
    const current = state.items[item.id] as unknown as LoopItem | undefined;
    if (current === undefined) {
      throw new Error(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    return Promise.resolve({ next: null, value: current });
  });
  if (li.park !== null && li.park.kind === "stall") {
    return advanceStall(ctx, item, li);
  }
  if (li.park !== null && li.park.kind === "blocked") {
    return advanceBlocked(ctx, item);
  }
  if (li.park !== null && li.park.kind === "operator") {
    return escalate(ctx, item, `op:${item.id}:${li.park.code ?? ""}`, escalationBody(item, li));
  }
  if (li.park !== null && li.park.kind === "lost") {
    return "done";
  }
  if (li.finalize !== null && !li.finalize.done) {
    return finalizeItem(ctx, item);
  }
  return "done";
}

// Sensitive tools: approve and pause_fleet record a pending approval
// request for out-of-band confirmation. Neither tool executes anything;
// decisions are taken only by the approvals CLI (A9).
import Ajv from "ajv/dist/2020";
import { loadApprovalsConfig, type ApprovalsConfig } from "../approvals/config.js";
import {
  ApprovalsBusyError,
  ApprovalsDataError,
  ApprovalsWriteError,
  recordRequest,
  type ApprovalArgs,
  type ApprovalTool,
  type RecordOutcome,
} from "../approvals/store.js";
import { loadWorkConfig } from "../work/config.js";
import { readWorkStore } from "../work/store.js";
import type { ToolContext, ToolDefinition, ToolOutcome, ToolPayload } from "./protocol.js";
import type { ToolPaths } from "./tools.js";

function refusedPayload(code: string, message: string): ToolPayload {
  return { ok: false, error: { code, message, retryable: false } };
}

function okPayload(kind: "recorded" | "existing", requestId: string): ToolPayload {
  return { ok: true, requestId, state: "pending", outcome: kind };
}

function errorPayload(
  code: string,
  message: string,
  retryable: boolean,
  detail: Record<string, unknown>,
): ToolPayload {
  return { ok: false, error: { code, message, retryable, ...detail } };
}

function unavailablePayload(source: string): ToolPayload {
  return errorPayload("source-unreadable", `${source} unreadable`, false, { source });
}

function outcomePayload(outcome: RecordOutcome): ToolPayload {
  if (outcome.kind === "refused") {
    return refusedPayload(outcome.code, outcome.message);
  }
  return okPayload(outcome.kind, outcome.request.requestId);
}

function outcomeSummary(outcome: RecordOutcome): Record<string, unknown> | null {
  if (outcome.kind !== "recorded" && outcome.kind !== "existing") {
    return null;
  }
  return { requestId: outcome.request.requestId, outcome: outcome.kind };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ajv = new Ajv({ strict: true });

const APPROVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["workItemId", "pullNumber", "headSha", "reason"],
  properties: {
    workItemId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
    pullNumber: { type: "integer", minimum: 1 },
    headSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    reason: { type: "string", minLength: 1 },
  },
} as const;

const PAUSE_FLEET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason"],
  properties: {
    action: { enum: ["pause", "resume"] },
    reason: { type: "string", minLength: 1 },
  },
} as const;

const APPROVE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["workItemId", "pullNumber", "headSha", "reason"],
  properties: {
    workItemId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
    pullNumber: { type: "integer", minimum: 1 },
    headSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    reason: { type: "string", minLength: 1 },
  },
};

const PAUSE_FLEET_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason"],
  properties: {
    action: { enum: ["pause", "resume"] },
    reason: { type: "string", minLength: 1 },
  },
};

const approveValidate = ajv.compile(APPROVE_SCHEMA);
const pauseFleetValidate = ajv.compile(PAUSE_FLEET_SCHEMA);

function firstError(
  errors: readonly { instancePath?: string; keyword?: string }[] | null | undefined,
): { readonly path: string; readonly keyword: string } {
  const first = errors?.[0];
  const path =
    first?.instancePath === "" || first?.instancePath === undefined ? "/" : first.instancePath;
  return { path, keyword: String(first?.keyword) };
}

function validateApprove(
  args: unknown,
): { readonly path: string; readonly keyword: string } | null {
  if (approveValidate(args)) {
    return null;
  }
  return firstError(approveValidate.errors);
}

function validatePauseFleet(
  args: unknown,
): { readonly path: string; readonly keyword: string } | null {
  if (pauseFleetValidate(args)) {
    return null;
  }
  return firstError(pauseFleetValidate.errors);
}

async function checkReason(
  paths: ToolPaths,
  args: { readonly reason: string },
): Promise<
  | { readonly approvals: ApprovalsConfig }
  | { readonly payload: ToolPayload; readonly detail: string | null }
> {
  let approvals;
  try {
    approvals = await loadApprovalsConfig(paths.approvalsConfigPath);
  } catch (error: unknown) {
    return { payload: unavailablePayload("requests"), detail: errorDetail(error) };
  }
  // Counting code points matches JSON Schema maxLength (AM4-1); a
  // grapheme split would need Intl.Segmenter instead of the spread.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  if ([...args.reason].length > approvals.maxReasonChars) {
    return {
      payload: errorPayload(
        "invalid-arguments",
        "invalid arguments at /reason (maxLength)",
        false,
        { path: "/reason", keyword: "maxLength" },
      ),
      detail: null,
    };
  }
  return { approvals };
}

async function record(
  tool: ApprovalTool,
  approvals: ApprovalsConfig,
  ctx: ToolContext,
  args: ApprovalArgs,
): Promise<ToolOutcome> {
  let outcome: RecordOutcome;
  try {
    outcome = await recordRequest(approvals.requestsPath, {
      tool,
      args,
      caller: ctx.caller,
      now: ctx.now,
      maxPending: approvals.maxPendingRequests,
    });
  } catch (error: unknown) {
    if (error instanceof ApprovalsBusyError) {
      return {
        payload: errorPayload("store-busy", "requests store busy, retry", true, {
          store: "requests",
        }),
        summary: null,
        detail: null,
      };
    }
    if (error instanceof ApprovalsDataError) {
      return {
        payload: unavailablePayload("requests"),
        summary: null,
        detail: errorDetail(error),
      };
    }
    if (error instanceof ApprovalsWriteError) {
      return {
        payload: errorPayload("store-write-failed", "requests store write failed", false, {}),
        summary: null,
        detail: errorDetail(error),
      };
    }
    throw error;
  }
  return { payload: outcomePayload(outcome), summary: outcomeSummary(outcome), detail: null };
}

async function runApprove(args: unknown, ctx: ToolContext, paths: ToolPaths): Promise<ToolOutcome> {
  const typed = args as { readonly reason: string };
  const checked = await checkReason(paths, typed);
  if ("payload" in checked) {
    return { payload: checked.payload, summary: null, detail: checked.detail };
  }
  const submitted = args as {
    readonly workItemId: string;
    readonly pullNumber: number;
    readonly headSha: string;
    readonly reason: string;
  };
  let store;
  try {
    const workConfig = await loadWorkConfig(paths.workConfigPath);
    store = await readWorkStore(workConfig.storePath);
  } catch (error: unknown) {
    return { payload: unavailablePayload("work-store"), summary: null, detail: errorDetail(error) };
  }
  const item = store.items.find((entry) => entry.id === submitted.workItemId);
  if (item === undefined) {
    return {
      payload: refusedPayload("unknown-work-item", `unknown work item ${submitted.workItemId}`),
      summary: null,
      detail: null,
    };
  }
  if (item.status !== "review") {
    return {
      payload: refusedPayload(
        "not-in-review",
        `item ${submitted.workItemId} is ${item.status}, not review`,
      ),
      summary: null,
      detail: null,
    };
  }
  if (item.pullNumber !== submitted.pullNumber) {
    const pull = item.pullNumber === null ? "null" : String(item.pullNumber);
    return {
      payload: refusedPayload("pull-mismatch", `item ${submitted.workItemId} has pull ${pull}`),
      summary: null,
      detail: null,
    };
  }
  return record("approve", checked.approvals, ctx, { ...submitted });
}

async function runPauseFleet(
  args: unknown,
  ctx: ToolContext,
  paths: ToolPaths,
): Promise<ToolOutcome> {
  const typed = args as { readonly reason: string };
  const checked = await checkReason(paths, typed);
  if ("payload" in checked) {
    return { payload: checked.payload, summary: null, detail: checked.detail };
  }
  const submitted = args as { readonly action: "pause" | "resume"; readonly reason: string };
  return record("pause_fleet", checked.approvals, ctx, { ...submitted });
}

export function createApproveTool(paths: ToolPaths): ToolDefinition {
  return {
    name: "approve",
    title: "Approve merge",
    toolClass: "sensitive",
    description:
      "[sensitive: records a request a human must confirm out of band; never executes] Requests a human approval to merge one pull request at one head.",
    inputSchema: APPROVE_INPUT_SCHEMA,
    validate: validateApprove,
    run: (args, ctx) => runApprove(args, ctx, paths),
  };
}

export function createPauseFleetTool(paths: ToolPaths): ToolDefinition {
  return {
    name: "pause_fleet",
    title: "Pause fleet",
    toolClass: "sensitive",
    description:
      "[sensitive: records a request a human must confirm out of band; never executes] Requests a human pause or resume of new starts.",
    inputSchema: PAUSE_FLEET_INPUT_SCHEMA,
    validate: validatePauseFleet,
    run: (args, ctx) => runPauseFleet(args, ctx, paths),
  };
}

// Read tools beyond fleet_status: list_work (R2) and audit_results (R3).
// Both read the work store; audit_results also reads the verdict dir at
// loadAuditorConfig(path).verdictDir and rechecks counts with recount.
import Ajv from "ajv/dist/2020";
import { loadAuditorConfig } from "../auditor/config.js";
import { readVerdicts } from "../auditor/store.js";
import { recount } from "../auditor/verdict.js";
import type { WorkItem } from "../../contracts/v1/types.js";
import { loadWorkConfig } from "../work/config.js";
import { readWorkStore } from "../work/store.js";
import type { ToolContext, ToolDefinition, ToolOutcome, ToolPayload } from "./protocol.js";
import type { ToolPaths } from "./tools.js";

function okPayload(fields: Record<string, unknown>): ToolPayload {
  return { ok: true, ...fields };
}

function unavailablePayload(source: string): ToolPayload {
  return {
    ok: false,
    error: { code: "source-unreadable", message: `${source} unreadable`, retryable: false, source },
  };
}

const ajv = new Ajv({ strict: true });

const LIST_WORK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: ["queued", "running", "review", "parked", "blocked", "done"] },
    },
  },
} as const;

const AUDIT_RESULTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["workItemId"],
  properties: {
    workItemId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
  },
} as const;

const listWorkValidate = ajv.compile(LIST_WORK_SCHEMA);
const auditResultsValidate = ajv.compile(AUDIT_RESULTS_SCHEMA);

function firstError(
  errors: readonly { instancePath?: string; keyword?: string }[] | null | undefined,
): { readonly path: string; readonly keyword: string } {
  const first = errors?.[0];
  const path =
    first?.instancePath === "" || first?.instancePath === undefined ? "/" : first.instancePath;
  return { path, keyword: String(first?.keyword) };
}

function validateListWork(
  args: unknown,
): { readonly path: string; readonly keyword: string } | null {
  if (listWorkValidate(args)) {
    return null;
  }
  return firstError(listWorkValidate.errors);
}

function validateAuditResults(
  args: unknown,
): { readonly path: string; readonly keyword: string } | null {
  if (auditResultsValidate(args)) {
    return null;
  }
  return firstError(auditResultsValidate.errors);
}

function toListRow(item: WorkItem): Record<string, unknown> {
  let done = 0;
  for (const entry of item.dod) {
    if (entry.done) {
      done += 1;
    }
  }
  return {
    id: item.id,
    repo: item.repo,
    title: item.title,
    issue: item.issue,
    status: item.status,
    statusReason: item.statusReason,
    assignedHostAlias: item.assignedHostAlias,
    branch: item.branch,
    pullNumber: item.pullNumber,
    dependencies: [...item.dependencies],
    dod: { done, total: item.dod.length },
    retryCount: item.retryCount,
    stallRounds: item.stallRounds,
    modelRouting: item.modelRouting,
  };
}

async function runListWork(
  args: unknown,
  _ctx: ToolContext,
  paths: ToolPaths,
): Promise<ToolOutcome> {
  const wanted = new Set((args as { status: readonly string[] }).status);
  let store;
  try {
    const workConfig = await loadWorkConfig(paths.workConfigPath);
    store = await readWorkStore(workConfig.storePath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { payload: unavailablePayload("work-store"), summary: null, detail };
  }
  const items = store.items.filter((item) => wanted.has(item.status)).map(toListRow);
  return {
    payload: okPayload({ revision: store.revision, items }),
    summary: { count: items.length },
    detail: null,
  };
}

async function runAuditResults(
  args: unknown,
  _ctx: ToolContext,
  paths: ToolPaths,
): Promise<ToolOutcome> {
  const workItemId = (args as { workItemId: string }).workItemId;
  let store;
  try {
    const workConfig = await loadWorkConfig(paths.workConfigPath);
    store = await readWorkStore(workConfig.storePath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { payload: unavailablePayload("work-store"), summary: null, detail };
  }
  if (!store.items.some((item) => item.id === workItemId)) {
    return {
      payload: {
        ok: false,
        error: {
          code: "unknown-work-item",
          message: `unknown work item ${workItemId}`,
          retryable: false,
        },
      },
      summary: null,
      detail: null,
    };
  }
  let verdicts;
  try {
    const auditorConfig = await loadAuditorConfig(paths.auditorConfigPath);
    verdicts = await readVerdicts(auditorConfig.verdictDir, workItemId);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { payload: unavailablePayload("verdicts"), summary: null, detail };
  }
  const rows = [];
  for (const verdict of verdicts) {
    const counts = recount(verdict.findings);
    if (
      counts.high !== verdict.counts.high ||
      counts.medium !== verdict.counts.medium ||
      counts.low !== verdict.counts.low
    ) {
      return {
        payload: {
          ok: false,
          error: {
            code: "verdict-invalid",
            message: `verdict ${verdict.headSha} counts disagree with its findings`,
            retryable: false,
            headSha: verdict.headSha,
          },
        },
        summary: null,
        detail: null,
      };
    }
    rows.push({
      headSha: verdict.headSha,
      pullNumber: verdict.pullNumber,
      repo: verdict.repo,
      auditorModel: verdict.auditorModel,
      authorModels: [...verdict.authorModels],
      counts: { ...verdict.counts },
      findings: verdict.findings,
    });
  }
  return {
    payload: okPayload({ workItemId, verdicts: rows }),
    summary: { workItemId, verdicts: rows.length },
    detail: null,
  };
}

export function createListWorkTool(paths: ToolPaths): ToolDefinition {
  return {
    name: "list_work",
    title: "List work",
    toolClass: "read",
    description: "[read] Lists work items filtered by status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { enum: ["queued", "running", "review", "parked", "blocked", "done"] },
        },
      },
    },
    validate: validateListWork,
    run: (args, ctx) => runListWork(args, ctx, paths),
  };
}

export function createAuditResultsTool(paths: ToolPaths): ToolDefinition {
  return {
    name: "audit_results",
    title: "Audit results",
    toolClass: "read",
    description: "[read] Returns stored audit verdicts for a work item.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workItemId"],
      properties: {
        workItemId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
      },
    },
    validate: validateAuditResults,
    run: (args, ctx) => runAuditResults(args, ctx, paths),
  };
}

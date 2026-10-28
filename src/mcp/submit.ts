// submit_work tool (S1, S2 step 0, error map): validates the args
// envelope, loads the work config and factory specs, runs the pure
// predicates, then folds steps 7-12 through updateWorkStore.
import Ajv from "ajv/dist/2020";
import type { WorkItem } from "../../contracts/v1/types.js";
import workItemSchema from "../../contracts/v1/work-item.schema.json" with { type: "json" };
import { loadWorkConfig } from "../work/config.js";
import { loadFactorySpecs } from "../work/specs.js";
import {
  WorkStoreBusyError,
  WorkStoreDataError,
  WorkStoreWriteError,
  updateWorkStore,
} from "../work/store.js";
import { applySubmission, checkItems } from "../work/submit.js";
import type { ToolContext, ToolDefinition, ToolOutcome, ToolPayload } from "./protocol.js";
import type { ToolPaths } from "./tools.js";

const schemaRecord = workItemSchema as unknown as Record<string, unknown>;
const WORK_ITEM_SHAPE: Record<string, unknown> = { ...schemaRecord };
delete WORK_ITEM_SHAPE["$id"];
delete WORK_ITEM_SHAPE["$schema"];

const ajv = new Ajv({ strict: true });

const VALIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", minItems: 1 } },
} as const;

const validate = ajv.compile(VALIDATE_SCHEMA);

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", minItems: 1, items: WORK_ITEM_SHAPE } },
};

function validateSubmit(args: unknown): { readonly path: string; readonly keyword: string } | null {
  if (validate(args)) {
    return null;
  }
  const first = validate.errors?.[0];
  const path =
    first?.instancePath === "" || first?.instancePath === undefined ? "/" : first.instancePath;
  return { path, keyword: String(first?.keyword) };
}

function okPayload(fields: Record<string, unknown>): ToolPayload {
  return { ok: true, ...fields };
}

function refusedPayload(refusal: {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}): ToolPayload {
  return {
    ok: false,
    error: { code: refusal.code, message: refusal.message, retryable: false, ...refusal.details },
  };
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

function summaryFor(
  code: string,
  details: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (code === "dag-cycle" || code === "unknown-dependency") {
    return { edge: details["edge"] };
  }
  if ("index" in details) {
    return { index: details["index"] };
  }
  if ("ids" in details) {
    return { ids: details["ids"] };
  }
  return null;
}

async function runSubmitWork(
  args: unknown,
  ctx: ToolContext,
  paths: ToolPaths,
): Promise<ToolOutcome> {
  let workConfig;
  try {
    workConfig = await loadWorkConfig(paths.workConfigPath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { payload: unavailablePayload("work-store"), summary: null, detail };
  }
  let specs;
  try {
    specs = await loadFactorySpecs(workConfig.factorySpecsPath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { payload: unavailablePayload("factory-specs"), summary: null, detail };
  }
  const items = (args as { items: readonly unknown[] }).items;
  if (items.length > workConfig.maxItemsPerSubmit) {
    return {
      payload: errorPayload("invalid-arguments", "invalid arguments at /items (maxItems)", false, {
        path: "/items",
        keyword: "maxItems",
      }),
      summary: null,
      detail: null,
    };
  }
  const repos = new Set(specs.map((entry) => entry.repo));
  const pure = checkItems(items, workConfig.maxItemBytes, workConfig.models, repos);
  if (pure !== null) {
    return {
      payload: refusedPayload(pure),
      summary: summaryFor(pure.code, pure.details),
      detail: null,
    };
  }
  const workItems = items as readonly WorkItem[];
  const maxStoreItems = workConfig.maxStoreItems;
  const storePath = workConfig.storePath;
  const caller = ctx.caller;
  const submittedAt = ctx.now().toISOString();
  try {
    const result = await updateWorkStore(storePath, (store) =>
      Promise.resolve(applySubmission(store, workItems, caller, submittedAt, maxStoreItems)),
    );
    if (result.kind === "refused") {
      return {
        payload: refusedPayload(result.refusal),
        summary: summaryFor(result.refusal.code, result.refusal.details),
        detail: null,
      };
    }
    return {
      payload: okPayload({
        submissionId: result.submissionId,
        itemIds: [...result.itemIds],
        replayed: result.replayed,
      }),
      summary: {
        submissionId: result.submissionId,
        itemIds: [...result.itemIds],
        replayed: result.replayed,
      },
      detail: null,
    };
  } catch (error: unknown) {
    if (error instanceof WorkStoreBusyError) {
      return {
        payload: errorPayload("store-busy", "work store busy, retry", true, { store: "work" }),
        summary: null,
        detail: null,
      };
    }
    if (error instanceof WorkStoreDataError) {
      return { payload: unavailablePayload("work-store"), summary: null, detail: error.message };
    }
    if (error instanceof WorkStoreWriteError) {
      return {
        payload: errorPayload("store-write-failed", "work store write failed", false, {}),
        summary: null,
        detail: error.message,
      };
    }
    throw error;
  }
}

export function createSubmitWorkTool(paths: ToolPaths): ToolDefinition {
  return {
    name: "submit_work",
    title: "Submit work",
    toolClass: "write",
    description:
      "[write] Queues a DAG of WorkItems after validation; at most maxItemsPerSubmit items (config/work.json).",
    inputSchema: INPUT_SCHEMA,
    validate: validateSubmit,
    run: (args, ctx) => runSubmitWork(args, ctx, paths),
  };
}

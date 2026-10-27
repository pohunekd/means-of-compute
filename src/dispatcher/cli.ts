// CLI entry point for dispatch: bun run dispatch:start --dry-run --item
// <file> --decision <file> --provider <id> --model <model> --ledger <path>
// --brief-file <path>. Dry-run prints the StartRequest as JSON (with the
// brief replaced by its sha256 and byte count) and exits 0 without calling
// the gate or the port and without writing anything. Any other use
// exits 2: the factory process owns real starts.
import { createHash } from "node:crypto";
import {
  contractErrors,
  isPlacementDecision,
  isWorkItem,
  type SchemaName,
} from "../../contracts/v1/validate.js";
import type { PlacementDecision, WorkItem } from "../../contracts/v1/types.js";
import { readInputText, statInputPath } from "../fs/input.js";
import { readLedger } from "../ledger/read.js";
import { loadDispatcherConfig } from "./config.js";
import { deriveStartRequest } from "./dispatcher.js";
import type { ModelSelection } from "./port.js";

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const raw = args[index + 1];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`dispatch: ${flag} needs a value`);
  }
  return raw;
}

interface ContractIssue {
  readonly instancePath?: unknown;
  readonly message?: unknown;
  readonly params?: unknown;
}

function contractPointer(schemaName: SchemaName, value: unknown): string {
  const errors = contractErrors(schemaName, value) as readonly ContractIssue[] | null;
  const first = errors?.[0];
  const pointer =
    typeof first?.instancePath === "string" && first.instancePath.length > 0
      ? first.instancePath
      : "/";
  const params =
    typeof first?.params === "object" && first.params !== null
      ? (first.params as Record<string, unknown>)
      : null;
  const missing = params?.["missingProperty"];
  const additional = params?.["additionalProperty"];
  const detail =
    typeof missing === "string"
      ? `missing property "${missing}"`
      : typeof additional === "string"
        ? `unexpected property "${additional}"`
        : typeof first?.message === "string"
          ? first.message
          : null;
  return detail === null ? pointer : `${pointer}: ${detail}`;
}

async function readJsonFile(label: string, path: string): Promise<unknown> {
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} ${path}: not valid JSON`);
  }
}

function readWorkItem(path: string, value: unknown): WorkItem {
  if (!isWorkItem(value)) {
    throw new Error(
      `Dispatch item ${path}: invalid work item at ${contractPointer("work-item", value)}`,
    );
  }
  if (value.status !== "queued") {
    throw new Error(
      `Dispatch item ${path}: work item status must be "queued", got "${value.status}"`,
    );
  }
  return value;
}

function readDecision(path: string, value: unknown): PlacementDecision {
  if (!isPlacementDecision(value)) {
    throw new Error(
      `Dispatch decision ${path}: invalid placement decision at ${contractPointer("placement-decision", value)}`,
    );
  }
  return value;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

async function readProviderDescriptor(providerId: string, model: string): Promise<void> {
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(`dispatch: invalid provider id "${providerId}"`);
  }
  const path = `config/providers/${providerId}.json`;
  if ((await statInputPath("Provider descriptor", path)) === "absent") {
    throw new Error(`Provider descriptor ${path}: file is missing`);
  }
  const text = await readInputText("Provider descriptor", path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Provider descriptor ${path}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Provider descriptor ${path}: must be a JSON object`);
  }
  if ((raw as Record<string, unknown>)["model"] !== model) {
    throw new Error(`Provider descriptor ${path}: model differs from --model`);
  }
}

function briefSummary(brief: string): { briefSha256: string; briefBytes: number } {
  return {
    briefSha256: createHash("sha256").update(brief, "utf8").digest("hex"),
    briefBytes: Buffer.byteLength(brief, "utf8"),
  };
}

async function runDryRun(): Promise<number> {
  try {
    const args = Bun.argv.slice(2);
    const itemPath = flagValue(args, "--item");
    const decisionPath = flagValue(args, "--decision");
    const providerId = flagValue(args, "--provider");
    const modelName = flagValue(args, "--model");
    const ledgerPath = flagValue(args, "--ledger");
    const briefPath = flagValue(args, "--brief-file");
    if (
      itemPath === null ||
      decisionPath === null ||
      providerId === null ||
      modelName === null ||
      ledgerPath === null ||
      briefPath === null
    ) {
      console.error(
        "dispatch: --item, --decision, --provider, --model, --ledger and --brief-file are all required",
      );
      return 2;
    }
    const config = await loadDispatcherConfig();
    const item = readWorkItem(itemPath, await readJsonFile("Dispatch item", itemPath));
    const decision = readDecision(
      decisionPath,
      await readJsonFile("Dispatch decision", decisionPath),
    );
    if (decision.workItemId !== item.id) {
      throw new Error("dispatch: decision workItemId does not match item id");
    }
    if (decision.chosenHostAlias === null) {
      throw new Error("dispatch: decision has no chosen host");
    }
    if (item.status !== "queued") {
      throw new Error(`dispatch: work item status must be "queued", got "${item.status}"`);
    }
    await readProviderDescriptor(providerId, modelName);
    const brief = await readInputText("Dispatch brief", briefPath);
    if (brief.trim().length === 0) {
      throw new Error("dispatch: brief must not be blank");
    }
    const model: ModelSelection = { providerId, model: modelName };
    const contents = await readLedger("Dispatch ledger", ledgerPath);
    const request = deriveStartRequest(item, decision, model, brief, config, contents);
    console.log(JSON.stringify({ ...request, brief: briefSummary(request.brief) }, null, 2));
    return 0;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function run(): Promise<number> {
  const args = Bun.argv.slice(2);
  if (args[0] !== "start") {
    console.error("dispatch: only the start command is supported");
    return 2;
  }
  if (args.includes("--dry-run")) {
    return runDryRun();
  }
  console.error("dispatch: only --dry-run is supported from the CLI");
  return 2;
}

const code = await run();
process.exit(code);

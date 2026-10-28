// Typed loader for config/coordinator.json. Every key is required and no
// extra key is allowed; the first failure names the dotted key. The provider
// descriptor is read raw so the key value is never loaded into memory.
import { basename, isAbsolute, join, resolve } from "node:path";
import { loadBudgetGateConfig } from "../budget/gate.js";
import { InputPathError, readInputText, statInputPath } from "../fs/input.js";
import { loadMcpConfig, type McpConfig } from "../mcp/config.js";
import { PROVIDERS_DIR } from "../providers/paths.js";
import { loadProviderSchema } from "../providers/schema.js";
import { sha256Hex } from "../work/canonical.js";
import { COORDINATOR_CALLER, LAUNCHER_CALLER } from "./calls.js";
import { loadSkill, type SkillText } from "./prompt.js";

export const COORD_CONFIG_PATH = "config/coordinator.json";
export const COORD_PROVIDER_ID = "meta-api";
export const COORD_MODEL = "muse-spark-1.3-contributor";

export type ReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type ApprovalMode = "untrusted" | "on-request" | "never";

export class CoordConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoordConfigError";
  }
}

export interface CoordPlanConfig {
  readonly reasoningEffort: ReasoningEffort;
  readonly maxModelSteps: number;
  readonly maxSubmitAttempts: number;
  readonly timeoutMs: number;
}

export interface CoordReactConfig {
  readonly reasoningEffort: ReasoningEffort;
  readonly maxModelSteps: number;
  readonly maxSubmitPerEntry: number;
  readonly maxEntries: number;
  readonly timeoutMs: number;
}

export interface CoordWatchConfig {
  readonly pollMs: number;
  readonly deadlineMs: number;
  readonly maxReactSessions: number;
  readonly maxFailedSessions: number;
  readonly maxPollErrors: number;
  readonly maxFollowupsPerRun: number;
  readonly pauseRequestBlockedItems: number;
}

export interface CoordSeedConfig {
  readonly stateDir: string;
  readonly storeSeedPath: string | null;
}

export interface CoordConfig {
  readonly museCommand: readonly string[];
  readonly providerId: typeof COORD_PROVIDER_ID;
  readonly model: typeof COORD_MODEL;
  readonly contributorMode: "on";
  readonly approvalMode: ApprovalMode;
  readonly envPassthrough: readonly string[];
  readonly mcpConfigPath: string;
  readonly budgetGateConfigPath: string;
  readonly skillDir: string;
  readonly runsDir: string;
  readonly maxRunsPerDay: number;
  readonly maxOutcomeChars: number;
  readonly maxToolOutputBytes: number;
  readonly killGraceMs: number;
  readonly exportTimeoutMs: number;
  readonly plan: CoordPlanConfig;
  readonly react: CoordReactConfig;
  readonly watch: CoordWatchConfig;
  readonly seed: CoordSeedConfig | null;
}

export interface LoadedCoordConfig {
  readonly config: CoordConfig;
  readonly configSha256: string;
  readonly apiKeyEnv: string;
  readonly mcp: McpConfig;
  readonly skill: SkillText;
}

const TOP_LEVEL_KEYS = [
  "museCommand",
  "providerId",
  "model",
  "contributorMode",
  "approvalMode",
  "envPassthrough",
  "mcpConfigPath",
  "budgetGateConfigPath",
  "skillDir",
  "runsDir",
  "maxRunsPerDay",
  "maxOutcomeChars",
  "maxToolOutputBytes",
  "killGraceMs",
  "exportTimeoutMs",
  "plan",
  "react",
  "watch",
  "seed",
] as const;

const EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

const APPROVALS: readonly ApprovalMode[] = ["untrusted", "on-request", "never"];

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const RELATIVE_SEED_PATTERN = /^logs\/coord-[a-z0-9-]+$/;
const SEED_DIR_PATTERN = /^coord-[a-z0-9-]+$/;

function missing(path: string, key: string): CoordConfigError {
  return new CoordConfigError(`Coordinator config ${path}: missing required key "${key}"`);
}

function invalid(path: string, key: string): CoordConfigError {
  return new CoordConfigError(`Coordinator config ${path}: invalid required key "${key}"`);
}

function unexpected(path: string, key: string): CoordConfigError {
  return new CoordConfigError(`Coordinator config ${path}: unexpected key "${key}"`);
}

function qualified(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

function wrapped(path: string, key: string, error: unknown): CoordConfigError {
  const detail = error instanceof Error ? error.message : String(error);
  return new CoordConfigError(
    `Coordinator config ${path}: invalid required key "${key}" (${detail})`,
    { cause: error },
  );
}

function asRecord(value: unknown, path: string, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(path, key);
  }
  return value as Record<string, unknown>;
}

function checkKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  prefix: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw unexpected(path, qualified(prefix, key));
    }
  }
  for (const key of allowed) {
    if (!(key in record)) {
      throw missing(path, qualified(prefix, key));
    }
  }
}

function requiredString(
  record: Record<string, unknown>,
  path: string,
  prefix: string,
  key: string,
): string {
  const name = qualified(prefix, key);
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(path, name);
  }
  return value;
}

function requiredInteger(
  record: Record<string, unknown>,
  path: string,
  prefix: string,
  key: string,
  min: number,
  max: number,
): number {
  const name = qualified(prefix, key);
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(path, name);
  }
  return value;
}

function requiredReasoningEffort(
  record: Record<string, unknown>,
  path: string,
  prefix: string,
): ReasoningEffort {
  const name = qualified(prefix, "reasoningEffort");
  const value = record["reasoningEffort"];
  if (typeof value !== "string" || !(EFFORTS as readonly string[]).includes(value)) {
    throw invalid(path, name);
  }
  return value as ReasoningEffort;
}

function requiredStringList(
  record: Record<string, unknown>,
  path: string,
  prefix: string,
  key: string,
  minItems: number,
): string[] {
  const name = qualified(prefix, key);
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.length < minItems ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw invalid(path, name);
  }
  return [...(value as string[])];
}

// The descriptor is parsed without its loader so no secret value is read.
// Only the pinned id, model and a variable name for the key survive.
async function readDescriptorApiKeyEnv(path: string): Promise<string> {
  const file = join(PROVIDERS_DIR, "meta-api.json");
  const label = "Provider descriptor";
  let text: string;
  try {
    if ((await statInputPath(label, file)) === "absent") {
      throw new CoordConfigError(`${label} ${file}: file is missing`);
    }
    text = await readInputText(label, file);
  } catch (error: unknown) {
    throw wrapped(path, "providerId", error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw wrapped(path, "providerId", new Error(`${label} ${file}: not valid JSON`));
  }
  let errors: string | null;
  try {
    errors = (await loadProviderSchema()).descriptorErrors(raw);
  } catch (error: unknown) {
    throw wrapped(path, "providerId", error);
  }
  if (errors !== null) {
    throw wrapped(path, "providerId", new Error(`${label} ${file}: ${errors}`));
  }
  const descriptor = raw as Record<string, unknown>;
  if (descriptor["id"] !== COORD_PROVIDER_ID) {
    throw wrapped(path, "providerId", new Error(`${label} ${file}: id is not meta-api`));
  }
  if (descriptor["model"] !== COORD_MODEL) {
    throw wrapped(
      path,
      "providerId",
      new Error(`${label} ${file}: model is not muse-spark-1.3-contributor`),
    );
  }
  const apiKeyEnv = descriptor["apiKeyEnv"];
  if (typeof apiKeyEnv !== "string" || !ENV_NAME_PATTERN.test(apiKeyEnv)) {
    throw wrapped(
      path,
      "providerId",
      new Error(`${label} ${file}: apiKeyEnv is not a variable name`),
    );
  }
  return apiKeyEnv;
}

function requiredEnvPassthrough(
  record: Record<string, unknown>,
  path: string,
  apiKeyEnv: string,
): readonly string[] {
  const names = requiredStringList(record, path, "", "envPassthrough", 1);
  const seen = new Set<string>();
  for (const name of names) {
    if (
      !ENV_NAME_PATTERN.test(name) ||
      seen.has(name) ||
      name === "HOME" ||
      name.startsWith("XDG_") ||
      name === apiKeyEnv
    ) {
      throw invalid(path, "envPassthrough");
    }
    seen.add(name);
  }
  return names;
}

function parsePlan(value: unknown, path: string): CoordPlanConfig {
  const record = asRecord(value, path, "plan");
  checkKeys(
    record,
    ["reasoningEffort", "maxModelSteps", "maxSubmitAttempts", "timeoutMs"],
    path,
    "plan",
  );
  return {
    reasoningEffort: requiredReasoningEffort(record, path, "plan"),
    maxModelSteps: requiredInteger(record, path, "plan", "maxModelSteps", 1, 200),
    maxSubmitAttempts: requiredInteger(record, path, "plan", "maxSubmitAttempts", 1, 10),
    timeoutMs: requiredInteger(record, path, "plan", "timeoutMs", 60000, 7200000),
  };
}

function parseReact(value: unknown, path: string): CoordReactConfig {
  const record = asRecord(value, path, "react");
  checkKeys(
    record,
    ["reasoningEffort", "maxModelSteps", "maxSubmitPerEntry", "maxEntries", "timeoutMs"],
    path,
    "react",
  );
  return {
    reasoningEffort: requiredReasoningEffort(record, path, "react"),
    maxModelSteps: requiredInteger(record, path, "react", "maxModelSteps", 1, 200),
    maxSubmitPerEntry: requiredInteger(record, path, "react", "maxSubmitPerEntry", 1, 5),
    maxEntries: requiredInteger(record, path, "react", "maxEntries", 1, 10),
    timeoutMs: requiredInteger(record, path, "react", "timeoutMs", 60000, 7200000),
  };
}

function parseWatch(value: unknown, path: string): CoordWatchConfig {
  const record = asRecord(value, path, "watch");
  checkKeys(
    record,
    [
      "pollMs",
      "deadlineMs",
      "maxReactSessions",
      "maxFailedSessions",
      "maxPollErrors",
      "maxFollowupsPerRun",
      "pauseRequestBlockedItems",
    ],
    path,
    "watch",
  );
  return {
    pollMs: requiredInteger(record, path, "watch", "pollMs", 1000, 3600000),
    deadlineMs: requiredInteger(record, path, "watch", "deadlineMs", 1000, 172800000),
    maxReactSessions: requiredInteger(record, path, "watch", "maxReactSessions", 1, 100),
    maxFailedSessions: requiredInteger(record, path, "watch", "maxFailedSessions", 1, 10),
    maxPollErrors: requiredInteger(record, path, "watch", "maxPollErrors", 1, 100),
    maxFollowupsPerRun: requiredInteger(record, path, "watch", "maxFollowupsPerRun", 0, 50),
    pauseRequestBlockedItems: requiredInteger(
      record,
      path,
      "watch",
      "pauseRequestBlockedItems",
      1,
      50,
    ),
  };
}

function requiredStateDir(record: Record<string, unknown>, path: string): string {
  const value = record["stateDir"];
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(path, "seed.stateDir");
  }
  if (isAbsolute(value)) {
    if (resolve(value) !== value || !SEED_DIR_PATTERN.test(basename(value))) {
      throw invalid(path, "seed.stateDir");
    }
    return value;
  }
  if (!RELATIVE_SEED_PATTERN.test(value)) {
    throw invalid(path, "seed.stateDir");
  }
  return value;
}

function parseSeed(value: unknown, path: string): CoordSeedConfig | null {
  if (value === null) {
    return null;
  }
  const record = asRecord(value, path, "seed");
  checkKeys(record, ["stateDir", "storeSeedPath"], path, "seed");
  const stateDir = requiredStateDir(record, path);
  const storeSeedPath = record["storeSeedPath"];
  if (storeSeedPath !== null && (typeof storeSeedPath !== "string" || storeSeedPath.length === 0)) {
    throw invalid(path, "seed.storeSeedPath");
  }
  return { stateDir, storeSeedPath };
}

export async function loadCoordConfig(path: string): Promise<LoadedCoordConfig> {
  const label = "Coordinator config";
  let text: string;
  try {
    if ((await statInputPath(label, path)) === "absent") {
      throw new CoordConfigError(`${label} ${path}: file is missing`);
    }
    text = await readInputText(label, path);
  } catch (error: unknown) {
    if (error instanceof CoordConfigError) {
      throw error;
    }
    if (error instanceof InputPathError) {
      throw new CoordConfigError(error.message, { cause: error });
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new CoordConfigError(`${label} ${path}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CoordConfigError(`${label} ${path}: must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  checkKeys(record, TOP_LEVEL_KEYS, path, "");
  const museCommand = requiredStringList(record, path, "", "museCommand", 1);
  if (record["providerId"] !== COORD_PROVIDER_ID) {
    throw invalid(path, "providerId");
  }
  const apiKeyEnv = await readDescriptorApiKeyEnv(path);
  if (record["model"] !== COORD_MODEL) {
    throw invalid(path, "model");
  }
  if (record["contributorMode"] !== "on") {
    throw invalid(path, "contributorMode");
  }
  const approvalMode = record["approvalMode"];
  if (
    typeof approvalMode !== "string" ||
    !(APPROVALS as readonly string[]).includes(approvalMode)
  ) {
    throw invalid(path, "approvalMode");
  }
  const envPassthrough = requiredEnvPassthrough(record, path, apiKeyEnv);
  const mcpConfigPath = requiredString(record, path, "", "mcpConfigPath");
  let mcp: McpConfig;
  try {
    mcp = await loadMcpConfig(mcpConfigPath);
  } catch (error: unknown) {
    throw wrapped(path, "mcpConfigPath", error);
  }
  if (!mcp.callers.includes(COORDINATOR_CALLER) || !mcp.callers.includes(LAUNCHER_CALLER)) {
    throw new CoordConfigError(
      `${label} ${path}: invalid required key "mcpConfigPath" (callers must include coordinator and mcp-call)`,
    );
  }
  const budgetGateConfigPath = requiredString(record, path, "", "budgetGateConfigPath");
  try {
    await loadBudgetGateConfig(budgetGateConfigPath);
  } catch (error: unknown) {
    throw wrapped(path, "budgetGateConfigPath", error);
  }
  const skillDir = requiredString(record, path, "", "skillDir");
  let skill: SkillText;
  try {
    skill = await loadSkill(skillDir);
  } catch (error: unknown) {
    throw wrapped(path, "skillDir", error);
  }
  const runsDir = requiredString(record, path, "", "runsDir");
  const config: CoordConfig = {
    museCommand,
    providerId: COORD_PROVIDER_ID,
    model: COORD_MODEL,
    contributorMode: "on",
    approvalMode: approvalMode as ApprovalMode,
    envPassthrough,
    mcpConfigPath,
    budgetGateConfigPath,
    skillDir,
    runsDir,
    maxRunsPerDay: requiredInteger(record, path, "", "maxRunsPerDay", 1, 50),
    maxOutcomeChars: requiredInteger(record, path, "", "maxOutcomeChars", 100, 50000),
    maxToolOutputBytes: requiredInteger(record, path, "", "maxToolOutputBytes", 1024, 1048576),
    killGraceMs: requiredInteger(record, path, "", "killGraceMs", 0, 60000),
    exportTimeoutMs: requiredInteger(record, path, "", "exportTimeoutMs", 1000, 600000),
    plan: parsePlan(record["plan"], path),
    react: parseReact(record["react"], path),
    watch: parseWatch(record["watch"], path),
    seed: parseSeed(record["seed"], path),
  };
  return { config, configSha256: sha256Hex(text), apiKeyEnv, mcp, skill };
}

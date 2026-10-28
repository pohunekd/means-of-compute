// Typed loader for config/loop.json and config/loop-demo.json. Every key is
// required and no extra key is allowed: a missing file or key fails naming
// the key. In stub mode the paths the factory writes must stay inside the stub sandbox; the stub section is required in stub mode and forbidden in production.
import { join, resolve } from "node:path";
import { readInputText, statInputPath } from "../fs/input.js";
import { PROVIDERS_DIR } from "../providers/paths.js";
import { loadWorkConfig } from "../work/config.js";
import { loadFactorySpecs } from "../work/specs.js";

export type LoopMode = "production" | "stub";

export class LoopConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopConfigError";
  }
}

export interface LoopStallConfig {
  readonly maxStagnantRounds: number;
  readonly maxRetries: number;
}

export interface LoopRoutingConfig {
  readonly models: Readonly<Record<string, string>>;
  readonly fallback: Readonly<Record<string, string>>;
  readonly fallbackAfterFailures: number;
  readonly window: number;
  readonly minSamples: number;
  readonly minSuccessRate: number;
}

export interface LoopIntakeConfig {
  readonly enabled: boolean;
  readonly optInLabel: string;
  readonly readyLabel: string;
  readonly blockedLabel: string;
  readonly pollMs: number;
  readonly defaultModel: string;
  readonly maxGoalChars: number;
}

export interface LoopGithubConfig {
  readonly tokenEnv: string;
  readonly configDir: string;
  readonly factoryLogin: string | null;
  readonly timeoutMs: number;
  readonly ciPollMs: number;
  readonly ciTimeoutMs: number;
  readonly mergeRetries: number;
  readonly trustedAssociations: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly mergeMethod: "merge";
  readonly intake: LoopIntakeConfig;
  readonly followupLabels: readonly string[];
  readonly escalationLabel: string;
}

export interface LoopRepoConfig {
  readonly repo: string;
  readonly checkoutDir: string;
  readonly idPrefix: string;
}

export interface LoopTrialMergeConfig {
  readonly scratchDir: string;
  readonly steps: readonly (readonly string[])[];
  readonly timeoutMs: number;
}

export interface LoopStubConfig {
  readonly sandboxDir: string;
  readonly demoRepoDir: string;
  readonly observationsPath: string;
  readonly recordingsPath: string;
}

export interface LoopConfig {
  readonly statePath: string;
  readonly logPath: string;
  readonly resultsPath: string;
  readonly workConfigPath: string;
  readonly dispatcherConfigPath: string;
  readonly auditorConfigPath: string;
  readonly ledgerConfigPath: string;
  readonly budgetGateConfigPath: string;
  readonly placementConfigPath: string;
  readonly approvalsConfigPath: string;
  readonly meterConfigPath: string;
  readonly adapterConfigPath: string | null;
  readonly dashboardConfigPath: string | null;
  readonly tickMs: number;
  readonly maxActiveItems: number;
  readonly shutdownGraceMs: number;
  readonly sessionTimeoutMs: number;
  readonly unreachableRetryMs: number;
  readonly budgetBackoffMs: number;
  readonly maxStartRejections: number;
  readonly maxBriefBytes: number;
  readonly stall: LoopStallConfig;
  readonly routing: LoopRoutingConfig;
  readonly github: LoopGithubConfig;
  readonly repos: readonly LoopRepoConfig[];
  readonly trialMerge: LoopTrialMergeConfig;
  readonly audit: { readonly retries: number };
  readonly digest: { readonly dir: string; readonly onExit: boolean };
  readonly stub: LoopStubConfig | null;
}

const TOKEN_ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
// Values GitHub reports for author_association on issues and comments.
const GITHUB_ASSOCIATIONS = new Set([
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN",
  "MEMBER",
  "NONE",
  "OWNER",
]);

function missing(path: string, key: string): LoopConfigError {
  return new LoopConfigError(`Loop config ${path}: missing required key "${key}"`);
}

function invalid(path: string, key: string): LoopConfigError {
  return new LoopConfigError(`Loop config ${path}: invalid required key "${key}"`);
}

function unexpected(path: string, key: string): LoopConfigError {
  return new LoopConfigError(`Loop config ${path}: unexpected key "${key}"`);
}

function qualified(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
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

function requiredNumber(
  record: Record<string, unknown>,
  path: string,
  prefix: string,
  key: string,
  min: number,
  max: number,
): number {
  const name = qualified(prefix, key);
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(path, name);
  }
  return value;
}

function requiredBoolean(
  record: Record<string, unknown>,
  path: string,
  prefix: string,
  key: string,
): boolean {
  const name = qualified(prefix, key);
  const value = record[key];
  if (typeof value !== "boolean") {
    throw invalid(path, name);
  }
  return value;
}

function optionalAdapterPath(
  record: Record<string, unknown>,
  path: string,
  prefix: string,
  key: string,
): string | null {
  const name = qualified(prefix, key);
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(path, name);
  }
  return value;
}

function parseStall(value: unknown, path: string): LoopStallConfig {
  const record = asRecord(value, path, "stall");
  checkKeys(record, ["maxStagnantRounds", "maxRetries"], path, "stall");
  return {
    maxStagnantRounds: requiredInteger(record, path, "stall", "maxStagnantRounds", 1, 10),
    maxRetries: requiredInteger(record, path, "stall", "maxRetries", 0, 10),
  };
}

async function parseRouting(value: unknown, path: string): Promise<LoopRoutingConfig> {
  const record = asRecord(value, path, "routing");
  checkKeys(
    record,
    ["models", "fallback", "fallbackAfterFailures", "window", "minSamples", "minSuccessRate"],
    path,
    "routing",
  );
  const modelsRaw = asRecord(record["models"], path, "routing.models");
  const models: Record<string, string> = {};
  for (const [model, provider] of Object.entries(modelsRaw)) {
    if (model.length === 0 || typeof provider !== "string" || provider.length === 0) {
      throw invalid(path, "routing.models");
    }
    try {
      const status = await statInputPath("Loop config", join(PROVIDERS_DIR, `${provider}.json`));
      if (status !== "file") {
        throw invalid(path, "routing.models");
      }
    } catch (error: unknown) {
      throw new LoopConfigError(
        `Loop config ${path}: invalid required key "routing.models" (provider "${provider}")`,
        { cause: error },
      );
    }
    models[model] = provider;
  }
  if (Object.keys(models).length === 0) {
    throw invalid(path, "routing.models");
  }
  const fallbackRaw = asRecord(record["fallback"], path, "routing.fallback");
  const fallback: Record<string, string> = {};
  for (const [from, to] of Object.entries(fallbackRaw)) {
    if (typeof to !== "string" || !(from in models) || !(to in models)) {
      throw invalid(path, "routing.fallback");
    }
    fallback[from] = to;
  }
  const window = requiredInteger(record, path, "routing", "window", 1, 1000);
  const minSamples = requiredInteger(record, path, "routing", "minSamples", 1, 1000);
  if (minSamples > window) {
    throw invalid(path, "routing.minSamples");
  }
  return {
    models,
    fallback,
    fallbackAfterFailures: requiredInteger(record, path, "routing", "fallbackAfterFailures", 1, 10),
    window,
    minSamples,
    minSuccessRate: requiredNumber(record, path, "routing", "minSuccessRate", 0, 1),
  };
}

function parseStringList(
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

function parseIntake(
  value: unknown,
  path: string,
  workModels: readonly string[],
): LoopIntakeConfig {
  const record = asRecord(value, path, "github.intake");
  checkKeys(
    record,
    [
      "enabled",
      "optInLabel",
      "readyLabel",
      "blockedLabel",
      "pollMs",
      "defaultModel",
      "maxGoalChars",
    ],
    path,
    "github.intake",
  );
  const defaultModel = requiredString(record, path, "github.intake", "defaultModel");
  if (!workModels.includes(defaultModel)) {
    throw invalid(path, "github.intake.defaultModel");
  }
  return {
    enabled: requiredBoolean(record, path, "github.intake", "enabled"),
    optInLabel: requiredString(record, path, "github.intake", "optInLabel"),
    readyLabel: requiredString(record, path, "github.intake", "readyLabel"),
    blockedLabel: requiredString(record, path, "github.intake", "blockedLabel"),
    pollMs: requiredInteger(record, path, "github.intake", "pollMs", 10000, 86400000),
    defaultModel,
    maxGoalChars: requiredInteger(record, path, "github.intake", "maxGoalChars", 100, 100000),
  };
}

function parseGithub(
  value: unknown,
  path: string,
  workModels: readonly string[],
): LoopGithubConfig {
  const record = asRecord(value, path, "github");
  checkKeys(
    record,
    [
      "tokenEnv",
      "configDir",
      "factoryLogin",
      "timeoutMs",
      "ciPollMs",
      "ciTimeoutMs",
      "mergeRetries",
      "trustedAssociations",
      "requiredChecks",
      "mergeMethod",
      "intake",
      "followupLabels",
      "escalationLabel",
    ],
    path,
    "github",
  );
  const tokenEnv = requiredString(record, path, "github", "tokenEnv");
  if (!TOKEN_ENV_PATTERN.test(tokenEnv)) {
    throw invalid(path, "github.tokenEnv");
  }
  const factoryLoginValue = record["factoryLogin"];
  if (
    factoryLoginValue !== null &&
    (typeof factoryLoginValue !== "string" || !GITHUB_LOGIN_PATTERN.test(factoryLoginValue))
  ) {
    throw invalid(path, "github.factoryLogin");
  }
  const trustedAssociations = parseStringList(record, path, "github", "trustedAssociations", 1);
  if (!trustedAssociations.every((entry) => GITHUB_ASSOCIATIONS.has(entry))) {
    throw invalid(path, "github.trustedAssociations");
  }
  const requiredChecks = parseStringList(record, path, "github", "requiredChecks", 1);
  if (new Set(requiredChecks).size !== requiredChecks.length) {
    throw invalid(path, "github.requiredChecks");
  }
  if (record["mergeMethod"] !== "merge") {
    throw invalid(path, "github.mergeMethod");
  }
  const intake = parseIntake(record["intake"], path, workModels);
  const followupLabels = parseStringList(record, path, "github", "followupLabels", 0);
  if (followupLabels.includes(intake.optInLabel)) {
    throw invalid(path, "github.followupLabels");
  }
  const escalationLabel = requiredString(record, path, "github", "escalationLabel");
  if (escalationLabel === intake.optInLabel) {
    throw invalid(path, "github.escalationLabel");
  }
  return {
    tokenEnv,
    configDir: requiredString(record, path, "github", "configDir"),
    factoryLogin: factoryLoginValue,
    timeoutMs: requiredInteger(record, path, "github", "timeoutMs", 1000, 600000),
    ciPollMs: requiredInteger(record, path, "github", "ciPollMs", 100, 600000),
    ciTimeoutMs: requiredInteger(record, path, "github", "ciTimeoutMs", 1000, 86400000),
    mergeRetries: requiredInteger(record, path, "github", "mergeRetries", 0, 10),
    trustedAssociations,
    requiredChecks,
    mergeMethod: "merge",
    intake,
    followupLabels,
    escalationLabel,
  };
}

function parseRepos(value: unknown, path: string, specRepos: readonly string[]): LoopRepoConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(path, "repos");
  }
  const repos: LoopRepoConfig[] = [];
  const prefixes = new Set<string>();
  const seen = new Set<string>();
  value.forEach((entry: unknown, index: number) => {
    const name = `repos[${String(index)}]`;
    const record = asRecord(entry, path, name);
    checkKeys(record, ["repo", "checkoutDir", "idPrefix"], path, name);
    const repo = requiredString(record, path, name, "repo");
    if (!REPO_PATTERN.test(repo)) {
      throw invalid(path, `${name}.repo`);
    }
    const idPrefix = requiredString(record, path, name, "idPrefix");
    if (!ID_PREFIX_PATTERN.test(idPrefix)) {
      throw invalid(path, `${name}.idPrefix`);
    }
    if (prefixes.has(idPrefix)) {
      throw invalid(path, `${name}.idPrefix`);
    }
    prefixes.add(idPrefix);
    if (seen.has(repo)) {
      throw invalid(path, `${name}.repo`);
    }
    seen.add(repo);
    repos.push({ repo, checkoutDir: requiredString(record, path, name, "checkoutDir"), idPrefix });
  });
  if (specRepos.length !== seen.size || !specRepos.every((repo) => seen.has(repo))) {
    throw invalid(path, "repos");
  }
  return repos;
}

function parseTrialMerge(value: unknown, path: string): LoopTrialMergeConfig {
  const record = asRecord(value, path, "trialMerge");
  checkKeys(record, ["scratchDir", "steps", "timeoutMs"], path, "trialMerge");
  const stepsValue = record["steps"];
  if (!Array.isArray(stepsValue) || stepsValue.length === 0) {
    throw invalid(path, "trialMerge.steps");
  }
  const steps: string[][] = [];
  stepsValue.forEach((step: unknown, index: number) => {
    const name = `trialMerge.steps[${String(index)}]`;
    if (
      !Array.isArray(step) ||
      step.length === 0 ||
      !step.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      throw invalid(path, name);
    }
    steps.push([...(step as string[])]);
  });
  return {
    scratchDir: requiredString(record, path, "trialMerge", "scratchDir"),
    steps,
    timeoutMs: requiredInteger(record, path, "trialMerge", "timeoutMs", 1000, 3600000),
  };
}

function parseAudit(value: unknown, path: string): { readonly retries: number } {
  const record = asRecord(value, path, "audit");
  checkKeys(record, ["retries"], path, "audit");
  return { retries: requiredInteger(record, path, "audit", "retries", 0, 10) };
}

function parseDigest(
  value: unknown,
  path: string,
): { readonly dir: string; readonly onExit: boolean } {
  const record = asRecord(value, path, "digest");
  checkKeys(record, ["dir", "onExit"], path, "digest");
  return {
    dir: requiredString(record, path, "digest", "dir"),
    onExit: requiredBoolean(record, path, "digest", "onExit"),
  };
}

function parseStub(value: unknown, path: string, mode: LoopMode): LoopStubConfig | null {
  if (value === undefined) {
    if (mode === "stub") {
      throw missing(path, "stub");
    }
    return null;
  }
  if (mode === "production") {
    throw new LoopConfigError(`Loop config ${path}: unexpected key "stub"`);
  }
  const record = asRecord(value, path, "stub");
  checkKeys(
    record,
    ["sandboxDir", "demoRepoDir", "observationsPath", "recordingsPath"],
    path,
    "stub",
  );
  return {
    sandboxDir: requiredString(record, path, "stub", "sandboxDir"),
    demoRepoDir: requiredString(record, path, "stub", "demoRepoDir"),
    observationsPath: requiredString(record, path, "stub", "observationsPath"),
    recordingsPath: requiredString(record, path, "stub", "recordingsPath"),
  };
}

function insideSandbox(sandboxDir: string, target: string): boolean {
  const root = resolve(sandboxDir);
  const resolved = resolve(target);
  return resolved === root || resolved.startsWith(`${root}/`);
}

function checkStubContainment(
  entries: ReadonlyArray<readonly [string, string | null]>,
  sandboxDir: string,
  path: string,
): void {
  for (const [key, value] of entries) {
    if (value === null) {
      continue;
    }
    if (!insideSandbox(sandboxDir, value)) {
      throw new LoopConfigError(`Loop config ${path}: stub path outside the sandbox: ${key}`);
    }
  }
}

const TOP_LEVEL_KEYS = [
  "statePath",
  "logPath",
  "resultsPath",
  "workConfigPath",
  "dispatcherConfigPath",
  "auditorConfigPath",
  "ledgerConfigPath",
  "budgetGateConfigPath",
  "placementConfigPath",
  "approvalsConfigPath",
  "meterConfigPath",
  "adapterConfigPath",
  "dashboardConfigPath",
  "tickMs",
  "maxActiveItems",
  "shutdownGraceMs",
  "sessionTimeoutMs",
  "unreachableRetryMs",
  "budgetBackoffMs",
  "maxStartRejections",
  "maxBriefBytes",
  "stall",
  "routing",
  "github",
  "repos",
  "trialMerge",
  "audit",
  "digest",
  "stub",
] as const;

export async function loadLoopConfig(path: string, mode: LoopMode): Promise<LoopConfig> {
  const label = "Loop config";
  try {
    if ((await statInputPath(label, path)) === "absent") {
      throw new LoopConfigError(`${label} ${path}: file is missing`);
    }
  } catch (error: unknown) {
    if (error instanceof LoopConfigError) {
      throw error;
    }
    throw new LoopConfigError(`${label} ${path}: cannot stat path`, { cause: error });
  }
  let text: string;
  try {
    text = await readInputText(label, path);
  } catch (error: unknown) {
    throw new LoopConfigError(`${label} ${path}: cannot read file`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new LoopConfigError(`Loop config ${path}: not valid JSON`);
  }
  const record = asRecord(raw, path, "");
  for (const key of Object.keys(record)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      throw unexpected(path, key);
    }
  }
  const stubKey = "stub" as const;
  for (const key of TOP_LEVEL_KEYS) {
    if (key === stubKey) {
      continue;
    }
    if (!(key in record)) {
      throw missing(path, key);
    }
  }
  const workConfigPath = requiredString(record, path, "", "workConfigPath");
  let workModels: readonly string[];
  let specRepos: readonly string[];
  try {
    const work = await loadWorkConfig(workConfigPath);
    workModels = work.models;
    specRepos = (await loadFactorySpecs(work.factorySpecsPath)).map((spec) => spec.repo);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LoopConfigError(
      `Loop config ${path}: invalid required key "workConfigPath" (${detail})`,
      { cause: error },
    );
  }
  const stub = parseStub(record["stub"], path, mode);
  const adapterConfigPath = optionalAdapterPath(record, path, "", "adapterConfigPath");
  const dashboardConfigPath = optionalAdapterPath(record, path, "", "dashboardConfigPath");
  if (mode === "production") {
    if (adapterConfigPath === null) {
      throw invalid(path, "adapterConfigPath");
    }
    if (dashboardConfigPath === null) {
      throw invalid(path, "dashboardConfigPath");
    }
  }
  if (mode === "stub" && (adapterConfigPath !== null || dashboardConfigPath !== null)) {
    throw new LoopConfigError(
      `Loop config ${path}: stub mode requires null adapter and dashboard paths`,
    );
  }
  const github = parseGithub(record["github"], path, workModels);
  const repos = parseRepos(record["repos"], path, specRepos);
  const config: LoopConfig = {
    statePath: requiredString(record, path, "", "statePath"),
    logPath: requiredString(record, path, "", "logPath"),
    resultsPath: requiredString(record, path, "", "resultsPath"),
    workConfigPath,
    dispatcherConfigPath: requiredString(record, path, "", "dispatcherConfigPath"),
    auditorConfigPath: requiredString(record, path, "", "auditorConfigPath"),
    ledgerConfigPath: requiredString(record, path, "", "ledgerConfigPath"),
    budgetGateConfigPath: requiredString(record, path, "", "budgetGateConfigPath"),
    placementConfigPath: requiredString(record, path, "", "placementConfigPath"),
    approvalsConfigPath: requiredString(record, path, "", "approvalsConfigPath"),
    meterConfigPath: requiredString(record, path, "", "meterConfigPath"),
    adapterConfigPath,
    dashboardConfigPath,
    tickMs: requiredInteger(record, path, "", "tickMs", 50, 600000),
    maxActiveItems: requiredInteger(record, path, "", "maxActiveItems", 1, 64),
    shutdownGraceMs: requiredInteger(record, path, "", "shutdownGraceMs", 0, 600000),
    sessionTimeoutMs: requiredInteger(record, path, "", "sessionTimeoutMs", 60000, 86400000),
    unreachableRetryMs: requiredInteger(record, path, "", "unreachableRetryMs", 0, 600000),
    budgetBackoffMs: requiredInteger(record, path, "", "budgetBackoffMs", 1000, 86400000),
    maxStartRejections: requiredInteger(record, path, "", "maxStartRejections", 1, 20),
    maxBriefBytes: requiredInteger(record, path, "", "maxBriefBytes", 1024, 1048576),
    stall: parseStall(record["stall"], path),
    routing: await parseRouting(record["routing"], path),
    github,
    repos,
    trialMerge: parseTrialMerge(record["trialMerge"], path),
    audit: parseAudit(record["audit"], path),
    digest: parseDigest(record["digest"], path),
    stub,
  };
  if (mode === "stub" && stub !== null) {
    const entries: Array<readonly [string, string | null]> = [
      ["statePath", config.statePath],
      ["logPath", config.logPath],
      ["resultsPath", config.resultsPath],
      ["github.configDir", config.github.configDir],
      ["digest.dir", config.digest.dir],
      ["trialMerge.scratchDir", config.trialMerge.scratchDir],
    ];
    config.repos.forEach((repo, index) => {
      entries.push([`repos[${String(index)}].checkoutDir`, repo.checkoutDir]);
    });
    checkStubContainment(entries, stub.sandboxDir, path);
  }
  return config;
}

// Typed loader for config/auditor.json. Every key is required, no extra
// key is allowed. Each auditor's providerId names a descriptor file whose
// JSON model equals the auditor model. Any failure is a startup error
// (exit 2 at the CLI).
import { readInputText, statInputPath } from "../fs/input.js";
import { PROVIDERS_DIR } from "../providers/paths.js";

export interface AuditorEntry {
  readonly providerId: string;
  readonly model: string;
}

export interface AuditorConfig {
  readonly auditors: readonly AuditorEntry[];
  readonly verdictDir: string;
  readonly maxDiffBytes: number;
  readonly maxFindings: number;
  readonly maxFieldChars: number;
}

export const AUDITOR_CONFIG_PATH = "config/auditor.json";
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ALLOWED_KEYS = new Set([
  "auditors",
  "verdictDir",
  "maxDiffBytes",
  "maxFindings",
  "maxFieldChars",
]);

export function checkAuditorConfig(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "must be a JSON object";
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      return `unexpected key "${key}"`;
    }
  }
  for (const key of ALLOWED_KEYS) {
    if (!(key in record)) {
      return `missing required key "${key}"`;
    }
  }
  return null;
}

async function providerModelOf(providerId: string): Promise<unknown> {
  const path = `${PROVIDERS_DIR}/${providerId}.json`;
  if ((await statInputPath("Auditor config", path)) === "absent") {
    throw new Error(`Auditor config ${AUDITOR_CONFIG_PATH}: missing provider file ${path}`);
  }
  const text = await readInputText("Auditor config", path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Auditor config ${AUDITOR_CONFIG_PATH}: provider file ${path} is not valid JSON`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `Auditor config ${AUDITOR_CONFIG_PATH}: provider file ${path} is not an object`,
    );
  }
  return (raw as Record<string, unknown>)["model"];
}

export async function loadAuditorConfig(
  path: string = AUDITOR_CONFIG_PATH,
): Promise<AuditorConfig> {
  const label = "Auditor config";
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} ${path}: not valid JSON`);
  }
  const structural = checkAuditorConfig(raw);
  if (structural !== null) {
    throw new Error(`${label} ${path}: ${structural}`);
  }
  const record = raw as Record<string, unknown>;

  const auditorsRaw = record["auditors"];
  if (!Array.isArray(auditorsRaw) || auditorsRaw.length === 0) {
    throw new Error(`${label} ${path}: "auditors" must be a non-empty array`);
  }
  const auditors: AuditorEntry[] = [];
  const models = new Set<string>();
  for (let index = 0; index < auditorsRaw.length; index += 1) {
    const entry = auditorsRaw[index] as unknown;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${label} ${path}: auditors[${String(index)}] must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 2 ||
      typeof candidate["providerId"] !== "string" ||
      typeof candidate["model"] !== "string"
    ) {
      throw new Error(
        `${label} ${path}: auditors[${String(index)}] needs exactly providerId and model strings`,
      );
    }
    const { providerId, model } = candidate as unknown as { providerId: string; model: string };
    if (!MODEL_PATTERN.test(model) || model.includes(":")) {
      throw new Error(`${label} ${path}: auditors[${String(index)}].model is invalid`);
    }
    if (models.has(model)) {
      throw new Error(`${label} ${path}: duplicate auditor model "${model}"`);
    }
    models.add(model);
    const descriptorModel = await providerModelOf(providerId);
    if (descriptorModel !== model) {
      throw new Error(
        `${label} ${path}: auditors[${String(index)}].model does not match ${PROVIDERS_DIR}/${providerId}.json`,
      );
    }
    auditors.push({ providerId, model });
  }

  const verdictDir = record["verdictDir"];
  if (typeof verdictDir !== "string" || verdictDir.length === 0) {
    throw new Error(`${label} ${path}: "verdictDir" must be a non-empty string`);
  }
  const limits: Record<string, [unknown, number, number]> = {
    maxDiffBytes: [record["maxDiffBytes"], 1, 10000000],
    maxFindings: [record["maxFindings"], 1, 500],
    maxFieldChars: [record["maxFieldChars"], 1, 20000],
  };
  for (const [key, [value, low, high]] of Object.entries(limits)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
      throw new Error(
        `${label} ${path}: "${key}" must be an integer in ${String(low)}..${String(high)}`,
      );
    }
  }
  return {
    auditors,
    verdictDir,
    maxDiffBytes: record["maxDiffBytes"] as number,
    maxFindings: record["maxFindings"] as number,
    maxFieldChars: record["maxFieldChars"] as number,
  };
}

// Typed loader for config/placement.json. The three scoring weights are
// validated at load: each is a finite number from 0 to 1, the weights sum to
// 1 within 1e-9, and no other keys are allowed. A missing or unreadable file,
// invalid JSON, or a failed validation is a startup error (exit 2 at the CLI).
import { readInputText, statInputPath } from "../fs/input.js";

export interface PlacementWeights {
  readonly cpu: number;
  readonly memory: number;
  readonly gpu: number;
}

const DEFAULT_CONFIG_PATH = "config/placement.json";
const ALLOWED_KEYS = new Set(["cpu", "memory", "gpu"]);

export async function loadPlacementWeights(
  path: string = DEFAULT_CONFIG_PATH,
): Promise<PlacementWeights> {
  const label = "Placement config";
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Placement config ${path}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Placement config ${path}: must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  const weightsRaw = record["weights"];
  if (typeof weightsRaw !== "object" || weightsRaw === null) {
    throw new Error(`Placement config ${path}: missing or invalid required field "weights"`);
  }
  const weightsRecord = weightsRaw as Record<string, unknown>;
  for (const key of Object.keys(weightsRecord)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Placement config ${path}: unexpected weights key "${key}"`);
    }
  }
  const weights: PlacementWeights = {
    cpu: requiredWeight(weightsRecord, "cpu", path),
    memory: requiredWeight(weightsRecord, "memory", path),
    gpu: requiredWeight(weightsRecord, "gpu", path),
  };
  const sum = weights.cpu + weights.memory + weights.gpu;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`Placement config ${path}: weights must sum to 1, got ${String(sum)}`);
  }
  return weights;
}

function requiredWeight(record: Record<string, unknown>, field: string, path: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `Placement config ${path}: missing or invalid required field "weights.${field}"`,
    );
  }
  return value;
}

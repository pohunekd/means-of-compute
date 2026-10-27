// Typed loader for config/placement.json. The three scoring weights are
// validated at load: each is a finite number from 0 to 1, the weights sum to
// 1 within 1e-9, and no other weights keys are allowed. batteryFloorPercent
// is an integer from 0 to 100, minInputIdleSeconds an integer of at least 0.
// Only the top-level keys "weights", "batteryFloorPercent" and
// "minInputIdleSeconds" are allowed. A missing or unreadable file,
// invalid JSON, or a failed validation is a startup error (exit 2 at the CLI).
import { readInputText, statInputPath } from "../fs/input.js";

export interface PlacementConfig {
  readonly weights: PlacementWeights;
  readonly batteryFloorPercent: number;
  readonly minInputIdleSeconds: number;
}

export interface PlacementWeights {
  readonly cpu: number;
  readonly memory: number;
  readonly gpu: number;
}

const DEFAULT_CONFIG_PATH = "config/placement.json";
const ALLOWED_TOP_LEVEL_KEYS = new Set(["weights", "batteryFloorPercent", "minInputIdleSeconds"]);
const ALLOWED_KEYS = new Set(["cpu", "memory", "gpu"]);

export async function loadPlacementConfig(
  path: string = DEFAULT_CONFIG_PATH,
): Promise<PlacementConfig> {
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
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`Placement config ${path}: unexpected key "${key}"`);
    }
  }
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
  const floorRaw = record["batteryFloorPercent"];
  if (
    typeof floorRaw !== "number" ||
    !Number.isInteger(floorRaw) ||
    floorRaw < 0 ||
    floorRaw > 100
  ) {
    throw new Error(
      `Placement config ${path}: missing or invalid required field "batteryFloorPercent"`,
    );
  }
  const idleSecondsRaw = record["minInputIdleSeconds"];
  if (
    typeof idleSecondsRaw !== "number" ||
    !Number.isInteger(idleSecondsRaw) ||
    idleSecondsRaw < 0
  ) {
    throw new Error(
      `Placement config ${path}: missing or invalid required field "minInputIdleSeconds"`,
    );
  }
  return { weights, batteryFloorPercent: floorRaw, minInputIdleSeconds: idleSecondsRaw };
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

// Typed loader for the operator-owned factory-specs file: a JSON array
// with at least one entry, each entry passing isFactorySpec, repo unique.
// A missing file or a failed entry names the cause.
import type { FactorySpec } from "../../contracts/v1/types.js";
import { isFactorySpec } from "../../contracts/v1/validate.js";
import { readInputText, statInputPath } from "../fs/input.js";

export async function loadFactorySpecs(path: string): Promise<readonly FactorySpec[]> {
  const label = "Factory specs";
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
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${label} ${path}: must be a non-empty array`);
  }
  const specs: FactorySpec[] = [];
  const repos = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (!isFactorySpec(entry)) {
      throw new Error(
        `${label} ${path}: entry ${String(index)} is not a valid FactorySpec`,
      );
    }
    if (repos.has(entry.repo)) {
      throw new Error(`${label} ${path}: duplicate repo "${entry.repo}"`);
    }
    repos.add(entry.repo);
    specs.push(entry);
  }
  return specs;
}

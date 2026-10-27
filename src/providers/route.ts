// Validated loader for config/providers/route.json. The route file holds
// exactly one key, "providers": a non-empty list of known provider ids
// without duplicates.
import { readInputText, statInputPath } from "../fs/input.js";

export async function loadProviderRoute(
  path: string,
  isKnownId: (id: string) => Promise<boolean>,
): Promise<readonly string[]> {
  const label = "Provider route";
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} ${path}: not valid JSON`, { cause: error });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} ${path}: needs exactly the key "providers"`);
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "providers") {
    throw new Error(`${label} ${path}: needs exactly the key "providers"`);
  }
  const entries = (raw as { providers: unknown }).providers;
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} ${path}: needs a string array "providers"`);
  }
  const ids = entries as string[];
  if (ids.length === 0) {
    throw new Error(`${label} ${path}: providers must not be empty`);
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`${label} ${path}: duplicate provider id "${id}"`);
    }
    seen.add(id);
    if (!(await isKnownId(id))) {
      throw new Error(`${label} ${path}: unknown provider id "${id}"`);
    }
  }
  return ids;
}

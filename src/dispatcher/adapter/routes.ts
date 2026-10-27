// Host route loading (design section 7): the input is the alias from
// StartRequest.hostAlias, resolved through a JSON file of alias-to-route
// entries. Errors name the bad alias and the file path, never the route.
import { readInputText, statInputPath } from "../../fs/input.js";

export type HostRoutes = ReadonlyMap<string, string>;

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function checkRoutesFile(
  filePath: string,
  value: unknown,
): { readonly routes: Record<string, string>; readonly aliases: readonly string[] } | { readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: `Host routes ${filePath}: must be a JSON object` };
  }
  const record = value as Record<string, unknown>;
  const aliases = Object.keys(record);
  if (aliases.length === 0) {
    return { error: `Host routes ${filePath}: needs at least one alias` };
  }
  const routes: Record<string, string> = {};
  for (const alias of aliases) {
    if (!ALIAS_PATTERN.test(alias)) {
      return { error: `Host routes ${filePath}: invalid alias "${alias}"` };
    }
    const route = record[alias];
    if (typeof route !== "string" || route.length === 0) {
      return { error: `Host routes ${filePath}: alias "${alias}" needs a non-empty route` };
    }
    routes[alias] = route;
  }
  return { routes, aliases };
}

export async function loadHostRoutes(
  envName: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<HostRoutes> {
  const filePath = env[envName];
  if (filePath === undefined || filePath === "") {
    throw new Error(`Host routes: env ${envName} is not set`);
  }
  const label = "Host routes";
  if ((await statInputPath(label, filePath)) === "absent") {
    throw new Error(`${label} ${filePath}: file is missing`);
  }
  const text = await readInputText(label, filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} ${filePath}: not valid JSON`);
  }
  const checked = checkRoutesFile(filePath, raw);
  if ("error" in checked) {
    throw new Error(checked.error);
  }
  return new Map(Object.entries(checked.routes));
}

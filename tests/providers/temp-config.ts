// Temp copies of the config tree for provider tests. Each case builds its own
// tree and reads it from a child `bun` process whose working directory is the
// temp tree, so the committed config is never touched and no network is used.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CONFIG_TS = join(REPO_ROOT, "src", "providers", "config.ts");
const ROUTER_TS = join(REPO_ROOT, "src", "providers", "router.ts");

export interface ChildResult {
  readonly code: number;
  readonly output: string;
}

export async function makeTempConfig(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "provider-config-"));
  const ids: string[] = [];
  for (const name of [
    "meta-api.json",
    "nvidia-build.json",
    "local.json",
    "route.json",
    "schema.json",
  ]) {
    const source = Bun.file(join(REPO_ROOT, "config", "providers", name));
    await Bun.write(join(dir, "config", "providers", name), await source.text());
    if (name !== "route.json" && name !== "schema.json") {
      ids.push(name.replace(/\.json$/, ""));
    }
  }
  await Bun.write(join(dir, "provider-ids.json"), JSON.stringify(ids));
  return dir;
}

export function removeTempConfig(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

let extraChildEnv: Record<string, string> = {};

export function setChildEnv(extra: Record<string, string>): void {
  extraChildEnv = extra;
}

async function childEnv(cwd: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("PROVIDER_")) {
      env[key] = value;
    }
  }
  env["NVIDIA_API_KEY"] = "test";
  env["META_API_KEY"] = "test";
  env["LOCAL_MODEL_BASE_URL"] = "http://localhost:1148/v1";
  // Pin every descriptor base URL to a closed loopback port, so a regression
  // in a child can never reach a third-party endpoint.
  for (const id of JSON.parse(await Bun.file(join(cwd, "provider-ids.json")).text()) as string[]) {
    env[`PROVIDER_${id.toUpperCase().replace(/-/g, "_")}_BASE_URL`] = "http://127.0.0.1:9";
  }
  for (const [key, value] of Object.entries(extraChildEnv)) {
    env[key] = value;
  }
  extraChildEnv = {};
  return env;
}

async function runHelper(dir: string, name: string, source: string): Promise<ChildResult> {
  await Bun.write(join(dir, name), source);
  const proc = Bun.spawn(["bun", name], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: await childEnv(dir),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

// Loads the providers of the temp tree and prints the result or the error.
export async function runLoadCheck(dir: string): Promise<ChildResult> {
  return runHelper(
    dir,
    "load-check.ts",
    `import { getProviders } from ${JSON.stringify(CONFIG_TS)};
try {
  const providers = await getProviders();
  console.log("loaded " + String(Object.keys(providers).length));
} catch (error: unknown) {
  console.log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`,
  );
}

// Calls the router against the temp tree after warming the provider cache
// with a valid route, then rewriting the route: the second call exercises
// the router's own route validation. Prints the result or the error.
export async function runWarmCallCheck(dir: string, badRoute: unknown): Promise<ChildResult> {
  return runHelper(
    dir,
    "warm-call-check.ts",
    `import { join } from "node:path";
import { getProviders } from ${JSON.stringify(CONFIG_TS)};
import { callWithFallback } from ${JSON.stringify(ROUTER_TS)};
try {
  await getProviders();
  await Bun.write(join("config", "providers", "route.json"), ${JSON.stringify(JSON.stringify(badRoute))});
  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  console.log("called " + JSON.stringify(result));
} catch (error: unknown) {
  console.log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`,
  );
}

// Calls the router against the temp tree and prints the result or the error.
export async function runCallCheck(dir: string): Promise<ChildResult> {
  return runHelper(
    dir,
    "call-check.ts",
    `import { callWithFallback } from ${JSON.stringify(ROUTER_TS)};
try {
  const result = await callWithFallback({ messages: [{ role: "user", content: "hi" }] });
  console.log("called " + JSON.stringify(result));
} catch (error: unknown) {
  console.log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`,
  );
}

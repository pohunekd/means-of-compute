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
  for (const name of [
    "meta-api.json",
    "nvidia-build.json",
    "local.json",
    "route.json",
    "schema.json",
  ]) {
    const source = Bun.file(join(REPO_ROOT, "config", "providers", name));
    await Bun.write(join(dir, "config", "providers", name), await source.text());
  }
  return dir;
}

export function removeTempConfig(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("PROVIDER_")) {
      env[key] = value;
    }
  }
  env["NVIDIA_API_KEY"] = "test";
  env["META_API_KEY"] = "test";
  env["LOCAL_MODEL_BASE_URL"] = "http://localhost:1148/v1";
  return env;
}

async function runHelper(dir: string, name: string, source: string): Promise<ChildResult> {
  await Bun.write(join(dir, name), source);
  const proc = Bun.spawn(["bun", name], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
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

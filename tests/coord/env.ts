// Coordinator session test env: an isolated tree with a temp checkout,
// a temp runs dir and a coordinator config pointing at the fake muse.
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpTestEnv, type McpTestEnv } from "../mcp/env.js";

export interface CoordTestEnv {
  readonly dir: string;
  readonly mcp: McpTestEnv;
  readonly checkoutDir: string;
  readonly runsDir: string;
  readonly configPath: string;
  readonly configJson: Record<string, unknown>;
  readonly recordPath: string;
  readonly fakeMusePath: string;
}

export async function createCoordTestEnv(): Promise<CoordTestEnv> {
  const dir = mkdtempSync(join(tmpdir(), "coord-test-"));
  const mcp = await createMcpTestEnv("coord-test-");
  const checkoutDir = join(dir, "checkout");
  mkdirSync(checkoutDir, { recursive: true });
  for (const name of ["src", "contracts", "node_modules"]) {
    symlinkSync(join(process.cwd(), name), join(checkoutDir, name));
  }
  cpSync(join(process.cwd(), "package.json"), join(checkoutDir, "package.json"));
  cpSync(join(process.cwd(), "config"), join(checkoutDir, "config"), { recursive: true });
  const runsDir = join(dir, "runs");
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const fakeMusePath = join(process.cwd(), "tests", "fixtures", "coord", "fake-muse.ts");
  const committed = (await Bun.file("config/coordinator.json").json()) as Record<string, unknown>;
  const configJson: Record<string, unknown> = {
    ...committed,
    museCommand: [process.execPath, fakeMusePath],
    envPassthrough: ["PATH", "FAKE_MUSE_RECORD", "FAKE_MUSE_SCRIPT"],
    mcpConfigPath: mcp.mcpConfigPath,
    runsDir,
  };
  const configPath = join(dir, "coordinator.json");
  await Bun.write(configPath, `${JSON.stringify(configJson)}\n`);
  return {
    dir,
    mcp,
    checkoutDir,
    runsDir,
    configPath,
    configJson,
    recordPath: join(dir, "fake-record.json"),
    fakeMusePath,
  };
}

export async function createRunDir(env: CoordTestEnv, runId: string): Promise<string> {
  const runDir = join(env.runsDir, runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const mcpConfig = (await Bun.file(env.mcp.mcpConfigPath).json()) as Record<string, unknown>;
  await Bun.write(
    join(runDir, "mcp.json"),
    `${JSON.stringify({ ...mcpConfig, callLogPath: join(runDir, "mcp-calls.jsonl") })}\n`,
  );
  await Bun.write(join(runDir, "prompt-1.md"), "prompt\n");
  return runDir;
}

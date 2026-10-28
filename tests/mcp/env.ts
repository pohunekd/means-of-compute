// Temporary MCP test environment: builds an isolated dir with absolute
// temp paths for every config the server loads, so spawned tests never
// touch the checkout logs/ directory.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface McpTestEnv {
  readonly dir: string;
  readonly mcpConfigPath: string;
  readonly workConfigPath: string;
  readonly auditorConfigPath: string;
  readonly dispatcherConfigPath: string;
  readonly storePath: string;
  readonly registryPath: string;
  readonly verdictDir: string;
  readonly callLogPath: string;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value)}\n`);
}

async function readCommittedJson(path: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(path).text();
  return JSON.parse(text) as Record<string, unknown>;
}

export async function createMcpTestEnv(prefix = "mcp-test-"): Promise<McpTestEnv> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "logs"), { recursive: true });
  const verdictDir = join(dir, "verdicts");
  mkdirSync(verdictDir, { recursive: true });
  const storePath = join(dir, "logs", "work-items.json");
  const registryPath = join(dir, "logs", "sessions.json");
  const callLogPath = join(dir, "logs", "mcp-calls.jsonl");
  const workConfigPath = join(dir, "work.json");
  const auditorConfigPath = join(dir, "auditor.json");
  const dispatcherConfigPath = join(dir, "dispatcher.json");
  const mcpConfigPath = join(dir, "mcp.json");

  const committedWork = await readCommittedJson("config/work.json");
  await writeJson(workConfigPath, {
    ...committedWork,
    storePath,
    factorySpecsPath: join(process.cwd(), "config", "factory-specs.json"),
  });
  const committedAuditor = await readCommittedJson("config/auditor.json");
  await writeJson(auditorConfigPath, { ...committedAuditor, verdictDir });
  const committedDispatcher = await readCommittedJson("config/dispatcher.json");
  await writeJson(dispatcherConfigPath, { ...committedDispatcher, registryPath });
  await writeJson(mcpConfigPath, {
    serverInfo: { name: "means-of-compute-factory", version: "0.1.0" },
    callers: ["coordinator", "mcp-call"],
    callLogPath,
    maxMessageBytes: 1048576,
    clientTimeoutMs: 30000,
    workConfigPath,
    auditorConfigPath,
    dispatcherConfigPath,
  });
  return {
    dir,
    mcpConfigPath,
    workConfigPath,
    auditorConfigPath,
    dispatcherConfigPath,
    storePath,
    registryPath,
    verdictDir,
    callLogPath,
  };
}

export async function writeTestFile(path: string, value: unknown): Promise<void> {
  await writeJson(path, value);
}

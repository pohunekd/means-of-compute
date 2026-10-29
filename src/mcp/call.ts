// mcp:call CLI: an MCP client of serve.ts over stdio. Usage:
// mcp:call <tool> [--file <path>] [--config <path>]. Exit 0 when ok is
// true, 3 when ok is false, 2 for usage or a bad --file, 4 when the server
// exits before answering, a JSON-RPC error comes back, a response is
// malformed, or there is no answer within clientTimeoutMs.
import { ClientError, runClientCall } from "./client.js";
import { MCP_CONFIG_PATH, loadMcpConfig } from "./config.js";
import { InputPathError, readInputText, statInputPath } from "../fs/input.js";

// Copies current defined environment entries for an explicit child spawn
// environment. Bun.spawn without env inherits the launch environment, so
// the current values must be read out explicitly. Entries whose value is an
// empty string stay set: only undefined entries are dropped.
export function definedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

function parseFlags(args: readonly string[]): { file: string | null; configPath: string } {
  let file: string | null = null;
  let configPath = MCP_CONFIG_PATH;
  let seenFile = false;
  let seenConfig = false;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--file") {
      if (seenFile) {
        throw new ClientError(
          2,
          "mcp:call: usage: mcp:call <tool> [--file <path>] [--config <path>]",
        );
      }
      const raw = args[index + 1];
      if (raw === undefined || raw.startsWith("--")) {
        throw new ClientError(2, "mcp:call: --file needs a value");
      }
      file = raw;
      seenFile = true;
      index += 2;
      continue;
    }
    if (arg === "--config") {
      if (seenConfig) {
        throw new ClientError(
          2,
          "mcp:call: usage: mcp:call <tool> [--file <path>] [--config <path>]",
        );
      }
      const raw = args[index + 1];
      if (raw === undefined || raw.startsWith("--")) {
        throw new ClientError(2, "mcp:call: --config needs a value");
      }
      configPath = raw;
      seenConfig = true;
      index += 2;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--")) {
      throw new ClientError(2, `mcp:call: unknown flag "${arg}"`);
    }
    throw new ClientError(2, "mcp:call: usage: mcp:call <tool> [--file <path>] [--config <path>]");
  }
  return { file, configPath };
}

async function readArgsFile(path: string): Promise<unknown> {
  try {
    if ((await statInputPath("mcp:call file", path)) === "absent") {
      throw new ClientError(2, `mcp:call file ${path}: file is missing`);
    }
  } catch (error: unknown) {
    if (error instanceof ClientError) {
      throw error;
    }
    if (error instanceof InputPathError) {
      throw new ClientError(2, error.message, { cause: error });
    }
    throw new ClientError(
      2,
      `mcp:call file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  let text: string;
  try {
    text = await readInputText("mcp:call file", path);
  } catch (error: unknown) {
    throw new ClientError(2, `mcp:call file ${path}: cannot read file`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ClientError(2, `mcp:call file ${path}: not valid JSON`);
  }
}

async function run(argv: readonly string[]): Promise<number> {
  try {
    if (argv.length === 0 || argv[0] === undefined || argv[0].startsWith("--")) {
      throw new ClientError(
        2,
        "mcp:call: usage: mcp:call <tool> [--file <path>] [--config <path>]",
      );
    }
    const tool = argv[0];
    const rest = argv.slice(1);
    const { file, configPath } = parseFlags(rest);
    const config = await loadMcpConfig(configPath).catch((error: unknown) => {
      throw new ClientError(
        4,
        `mcp:call: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    });
    const args = file === null ? {} : await readArgsFile(file);
    const structured = (await runClientCall({
      tool,
      args,
      configPath,
      serverVersion: config.serverInfo.version,
      clientTimeoutMs: config.clientTimeoutMs,
      env: definedEnv(process.env),
    })) as { ok?: unknown };
    process.stdout.write(`${JSON.stringify(structured)}\n`);
    return structured.ok === true ? 0 : 3;
  } catch (error: unknown) {
    if (error instanceof ClientError) {
      process.stderr.write(`${error.message}\n`);
      return error.code;
    }
    process.stderr.write(`mcp:call: ${error instanceof Error ? error.message : String(error)}\n`);
    return 4;
  }
}

const code = await run(Bun.argv.slice(2));
process.exitCode = code;

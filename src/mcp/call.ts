// mcp:call CLI: an MCP client of serve.ts over stdio. Usage:
// mcp:call <tool> [--file <path>] [--config <path>]. Exit 0 when ok is
// true, 3 when ok is false, 2 for usage or a bad --file, 4 when the server
// exits before answering, a JSON-RPC error comes back, a response is
// malformed, or there is no answer within clientTimeoutMs.
import { ClientError, runClientCall } from "./client.js";
import { loadMcpConfig } from "./config.js";
import { readInputText, statInputPath } from "../fs/input.js";

function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const raw = args[index + 1];
  if (raw === undefined || raw.startsWith("--")) {
    throw new ClientError(2, `mcp:call: ${flag} needs a value`);
  }
  return raw;
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
    const file = flagValue(rest, "--file");
    const configPath = flagValue(rest, "--config") ?? "config/mcp.json";
    for (const arg of rest) {
      if (arg.startsWith("--") && arg !== "--file" && arg !== "--config") {
        throw new ClientError(2, `mcp:call: unknown flag "${arg}"`);
      }
    }
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

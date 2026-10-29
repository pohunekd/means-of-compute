// Loop entry point: parses the CLI args and runs the stub demo run.
import { resolve } from "node:path";
import { LoopStartupError, loadLoopConfigs } from "./compose.js";
import { runStub } from "./stub/compose.js";

export interface LoopArgs {
  readonly config: string;
  readonly stub: boolean;
  readonly queue: string | null;
}

const USAGE = "usage: bun run loop --stub --queue <file> [--config <path>]";

export function parseLoopArgs(argv: readonly string[]): LoopArgs {
  let config: string | null = null;
  let stub = false;
  let queue: string | null = null;
  let stubCount = 0;
  let queueCount = 0;
  let configCount = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--stub") {
      stub = true;
      stubCount += 1;
    } else if (arg === "--queue") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new LoopStartupError(USAGE);
      }
      queue = value;
      queueCount += 1;
      index += 1;
    } else if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new LoopStartupError(USAGE);
      }
      config = value;
      configCount += 1;
      index += 1;
    } else {
      throw new LoopStartupError(USAGE);
    }
  }
  if (stubCount > 1 || queueCount > 1 || configCount > 1) {
    throw new LoopStartupError(USAGE);
  }
  if (stub !== (queue !== null)) {
    throw new LoopStartupError(USAGE);
  }
  if (config === null) {
    config = stub ? "config/loop-demo.json" : "config/loop.json";
  }
  return { config, stub, queue };
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: LoopArgs;
  try {
    args = parseLoopArgs(argv);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`loop: ${detail}\n`);
    return 2;
  }
  if (!args.stub) {
    process.stderr.write("loop: production mode is not available in this build; use --stub\n");
    return 2;
  }
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });
  try {
    const configs = await loadLoopConfigs(resolve(args.config), "stub");
    const queue = args.queue as string;
    const rc = await runStub({
      configs,
      queuePath: resolve(queue),
      stopping: () => stopping,
      out: (line: string) => {
        process.stdout.write(`${line}\n`);
      },
      warn: (line: string) => {
        process.stderr.write(`${line}\n`);
      },
    });
    return rc;
  } catch (error: unknown) {
    if (error instanceof LoopStartupError) {
      process.stderr.write(`loop: ${error.message}\n`);
      return 2;
    }
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`loop: ${detail}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

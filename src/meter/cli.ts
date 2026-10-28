// CLI entry point for the meter usage query: bun run meter:usage.
// Prints one JSON line with the joined usage for a grant, read-only:
// a torn tail is ignored and the file is never modified.
import { stat } from "node:fs/promises";
import { joinUsage } from "./join.js";
import { replayUsageLog } from "./usage-log.js";

const ALLOWED_FLAGS: readonly string[] = ["--log", "--request"];

function takeFlags(args: string[]): Map<string, string> {
  const seen = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    if (!flag.startsWith("--")) {
      throw new Error(`meter: unexpected argument ${JSON.stringify(flag)}`);
    }
    if (!ALLOWED_FLAGS.includes(flag)) {
      throw new Error(`meter: unknown flag ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`meter: repeated flag ${flag}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`meter: ${flag} needs a value`);
    }
    seen.set(flag, value);
    index += 1;
  }
  return seen;
}

function requiredFlag(flags: Map<string, string>, flag: string): string {
  const value = flags.get(flag);
  if (value === undefined) {
    throw new Error(`meter: ${flag} is required`);
  }
  return value;
}

async function runUsage(args: string[]): Promise<number> {
  const flags = takeFlags(args);
  const logPath = requiredFlag(flags, "--log");
  const requestId = requiredFlag(flags, "--request");
  try {
    await stat(logPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`meter: no log file at ${JSON.stringify(logPath)}`, { cause: error });
    }
    throw error;
  }
  const index = await replayUsageLog(logPath, "read-only", () => {});
  if (!index.grants.has(requestId)) {
    console.error(`meter: no grant for ${requestId}`);
    return 3;
  }
  console.log(JSON.stringify(joinUsage(index, requestId)));
  return 0;
}

function report(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.startsWith("meter") ? message : `meter: ${message}`;
  console.error(text);
  return 2;
}

async function run(): Promise<number> {
  const args = Bun.argv.slice(2);
  const command = args[0];
  try {
    if (command === "usage") {
      return await runUsage(args.slice(1));
    }
    throw new Error(`meter: unknown command ${JSON.stringify(command ?? "")}`);
  } catch (error: unknown) {
    return report(error);
  }
}

const code = await run();
process.exit(code);

// dispatch:diff command (PR 3c C2): parse --host/--session/--base, open the
// port, print the daemon diff. Flag errors exit 2 without opening the port;
// unreachable and rejected ports exit 2 with one line; anything else
// propagates. The port closes on every path once opened.
import { PortRejectedError, PortUnreachableError, type DispatcherPort } from "./port.js";

export interface DiffCommandIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (line: string) => void;
}

const KNOWN_FLAGS = new Set(["--host", "--session", "--base"]);

function parseDiffArgs(args: readonly string[]): {
  readonly hostAlias: string;
  readonly sessionId: string;
  readonly base: string;
} {
  const seen = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !KNOWN_FLAGS.has(flag)) {
      throw new Error(`dispatch: unknown flag "${String(flag)}"`);
    }
    if (seen.has(flag)) {
      throw new Error(`dispatch: flag "${flag}" given twice`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`dispatch: flag "${flag}" needs a value`);
    }
    seen.set(flag, value);
    index += 1;
  }
  for (const flag of KNOWN_FLAGS) {
    if (!seen.has(flag)) {
      throw new Error(`dispatch: flag "${flag}" is required`);
    }
  }
  return {
    hostAlias: seen.get("--host") as string,
    sessionId: seen.get("--session") as string,
    base: seen.get("--base") as string,
  };
}

export async function runDiffCommand(
  args: readonly string[],
  openPort: () => Promise<DispatcherPort>,
  io: DiffCommandIo,
): Promise<number> {
  let parsed: { hostAlias: string; sessionId: string; base: string };
  try {
    parsed = parseDiffArgs(args);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const port = await openPort();
  try {
    const result = await port.diff(
      { sessionId: parsed.sessionId, hostAlias: parsed.hostAlias },
      parsed.base,
    );
    io.stdout(result.unifiedDiff);
    if (result.truncated) {
      io.stderr("diff truncated by daemon");
    }
    return 0;
  } catch (error) {
    if (error instanceof PortUnreachableError) {
      io.stderr(`dispatch: ${parsed.hostAlias}: unreachable`);
      return 2;
    }
    if (error instanceof PortRejectedError) {
      io.stderr(`dispatch: ${parsed.hostAlias}: ${error.code}`);
      return 2;
    }
    throw error;
  } finally {
    await port.close();
  }
}

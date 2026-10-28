// dispatch:resolve command (53c): parse --request, run resolve through
// the runtime, print the outcome as one JSON line. Flag errors exit 2
// without opening the runtime; precondition errors exit 2.
import { FileLockError } from "../fs/lock.js";
import {
  DispatchPreconditionError,
  DispatchStateError,
  type ResolveOutcome,
} from "./dispatcher.js";
import { PortRejectedError, PortUnreachableError } from "./port.js";

function parseResolveArgs(args: readonly string[]): string {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--request") {
      throw new Error(`dispatch: unknown flag "${String(flag)}"`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error('dispatch: flag "--request" needs a value');
    }
    values.push(value);
    index += 1;
  }
  if (values.length === 0) {
    throw new Error('dispatch: flag "--request" is required');
  }
  if (values.length > 1) {
    throw new Error('dispatch: flag "--request" given twice');
  }
  return values[0] as string;
}

export async function runResolveCommand(
  args: readonly string[],
  withRuntime: <T>(
    use: (resolve: (requestId: string) => Promise<ResolveOutcome>) => Promise<T>,
  ) => Promise<T>,
  io: { stdout(line: string): void; stderr(line: string): void },
): Promise<number> {
  let requestId: string;
  try {
    requestId = parseResolveArgs(args);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let outcome: ResolveOutcome;
  try {
    outcome = await withRuntime((resolve) => resolve(requestId));
  } catch (error) {
    if (error instanceof PortUnreachableError) {
      io.stderr(`dispatch: ${requestId}: unreachable`);
      return 3;
    }
    if (error instanceof PortRejectedError) {
      io.stderr(`dispatch: ${requestId}: ${error.code}`);
      return 3;
    }
    if (error instanceof DispatchStateError) {
      io.stderr(`dispatch: ${requestId}: ${error.code}`);
      return 3;
    }
    if (error instanceof FileLockError && error.code === "busy") {
      io.stderr("dispatch: registry busy");
      return 3;
    }
    if (error instanceof DispatchPreconditionError) {
      io.stderr(`dispatch: ${error.message}`);
      return 2;
    }
    throw error;
  }
  io.stdout(JSON.stringify(outcome));
  return 0;
}

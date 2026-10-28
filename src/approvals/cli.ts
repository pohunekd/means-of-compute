// Out-of-band confirmation CLI: a human lists pending requests and
// approves or rejects one of them. runApprovalsCli holds every step;
// only main opens /dev/tty (AM3-4), after resolving the request line the
// terminal prints.
import { open } from "node:fs/promises";
import { APPROVALS_CONFIG_PATH, loadApprovalsConfig, type ApprovalsConfig } from "./config.js";
import { decideRequest } from "./decide.js";
import {
  ApprovalsBusyError,
  ApprovalsDataError,
  ApprovalsWriteError,
  pendingRequests,
  readApprovals,
  type ApprovalRequest,
} from "./store.js";

export interface ApprovalsCliDeps {
  readonly confirm: (prompt: string) => Promise<string>;
  readonly now: () => Date;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function lineOf(request: ApprovalRequest): string {
  return JSON.stringify({
    requestId: request.requestId,
    tool: request.tool,
    args: request.args,
    caller: request.caller,
    requestedAt: request.requestedAt,
  });
}

async function runList(argv: readonly string[], deps: ApprovalsCliDeps): Promise<number> {
  const rest = argv.slice(1);
  let configPath = APPROVALS_CONFIG_PATH;
  if (rest.length === 2 && rest[0] === "--config") {
    const value = rest[1];
    if (value === undefined) {
      throw new Error("approvals: usage: approvals:list [--config <path>]");
    }
    configPath = value;
  } else if (rest.length !== 0) {
    throw new Error("approvals: usage: approvals:list [--config <path>]");
  }
  const config = await loadApprovalsConfig(configPath);
  const doc = await readApprovals(config.requestsPath);
  for (const request of pendingRequests(doc)) {
    deps.out(lineOf(request));
  }
  return 0;
}

export class ApprovalsNotConfirmedError extends Error {
  constructor(message = "approvals: confirmation was not entered") {
    super(message);
    this.name = "ApprovalsNotConfirmedError";
  }
}

export class ApprovalsNoTerminalError extends Error {
  constructor() {
    super("approvals: decide needs an interactive terminal (/dev/tty)");
    this.name = "ApprovalsNoTerminalError";
  }
}

interface DecideArgs {
  readonly requestId: string;
  readonly decision: "approved" | "rejected";
  readonly author: string;
  readonly configPath: string;
}

function parseDecide(argv: readonly string[]): DecideArgs {
  const rest = argv.slice(1);
  const requestId = rest[0];
  if (requestId === undefined || requestId.startsWith("--")) {
    throw new Error(
      "approvals: usage: approvals:decide <requestId> (--approve|--reject) --author <handle> [--config <path>]",
    );
  }
  let approve = false;
  let reject = false;
  let author: string | null = null;
  let configPath = APPROVALS_CONFIG_PATH;
  const seen = new Set<string>();
  for (let index = 1; index < rest.length; index += 1) {
    const flag = rest[index] as string;
    if (flag === "--approve" || flag === "--reject") {
      if (seen.has(flag)) {
        throw new Error(`approvals: repeated flag ${flag}`);
      }
      seen.add(flag);
      if (flag === "--approve") {
        approve = true;
      } else {
        reject = true;
      }
    } else if (flag === "--author" || flag === "--config") {
      if (seen.has(flag)) {
        throw new Error(`approvals: repeated flag ${flag}`);
      }
      seen.add(flag);
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`approvals: ${flag} needs a value`);
      }
      index += 1;
      if (flag === "--author") {
        author = value;
      } else {
        configPath = value;
      }
    } else {
      throw new Error(`approvals: unknown flag ${flag}`);
    }
  }
  if (approve === reject) {
    throw new Error("approvals: usage: exactly one of --approve and --reject is required");
  }
  if (author === null) {
    throw new Error("approvals: usage: --author <handle> is required");
  }
  return { requestId, decision: approve ? "approved" : "rejected", author, configPath };
}

async function runDecide(argv: readonly string[], deps: ApprovalsCliDeps): Promise<number> {
  const parsed = parseDecide(argv);
  const config: ApprovalsConfig = await loadApprovalsConfig(parsed.configPath);
  if (!config.operators.includes(parsed.author)) {
    throw new Error(`approvals: author "${parsed.author}" is not an operator`);
  }
  const doc = await readApprovals(config.requestsPath);
  const request = doc.requests.find((entry) => entry.requestId === parsed.requestId);
  if (request === undefined) {
    throw new ApprovalsDataError(`approvals: unknown request "${parsed.requestId}"`);
  }
  const verb = parsed.decision === "approved" ? "approve" : "reject";
  let typed: string;
  try {
    typed = await deps.confirm(`Type ${parsed.requestId} to ${verb}: `);
  } catch {
    throw new ApprovalsNotConfirmedError(
      `approvals: confirmation for "${parsed.requestId}" was not entered`,
    );
  }
  if (typed !== parsed.requestId) {
    deps.err(`approvals: confirmation does not match "${parsed.requestId}"`);
    return 3;
  }
  const outcome = await decideRequest(config.requestsPath, {
    requestId: parsed.requestId,
    decision: parsed.decision,
    author: parsed.author,
    now: deps.now,
  });
  if (outcome.kind === "refused") {
    if (outcome.code === "unknown-request") {
      throw new ApprovalsDataError(`approvals: unknown request "${parsed.requestId}"`);
    }
    deps.err(`approvals: request "${parsed.requestId}" is already decided`);
    return 3;
  }
  const settled = outcome.request;
  deps.out(
    JSON.stringify({
      requestId: settled.requestId,
      state: settled.state,
      author: settled.decision?.author,
      decidedAt: settled.decision?.decidedAt,
    }),
  );
  return 0;
}

function exitOf(error: unknown): number {
  if (error instanceof ApprovalsBusyError || error instanceof ApprovalsNotConfirmedError) {
    return 3;
  }
  if (
    error instanceof ApprovalsNoTerminalError ||
    error instanceof ApprovalsDataError ||
    error instanceof ApprovalsWriteError
  ) {
    return 2;
  }
  return 2;
}

export async function runApprovalsCli(
  argv: readonly string[],
  deps: ApprovalsCliDeps,
): Promise<number> {
  try {
    const command = argv[0];
    if (command === "list") {
      return await runList(argv, deps);
    }
    if (command === "decide") {
      return await runDecide(argv, deps);
    }
    throw new Error("approvals: only the list and decide commands are supported");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    deps.err(message.startsWith("approvals") ? message : `approvals: ${message}`);
    return exitOf(error);
  }
}

async function confirmFromTty(requestLine: string, prompt: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open("/dev/tty", "r+");
  } catch {
    throw new ApprovalsNoTerminalError();
  }
  try {
    await handle.write(`${requestLine}\n`);
    await handle.write(prompt);
    for await (const line of handle.readLines()) {
      return line;
    }
    // EOF (Ctrl-D) closes the stream with no line: this is a not-confirmed
    // abort, not a missing terminal. Rejecting routes it to the mismatch
    // branch (exit 3) instead of the terminal-unavailable branch (exit 2).
    throw new ApprovalsNotConfirmedError();
  } finally {
    await handle.close();
  }
}

export async function requestLineFor(argv: readonly string[]): Promise<string> {
  const parsed = parseDecide(argv);
  const config = await loadApprovalsConfig(parsed.configPath);
  const doc = await readApprovals(config.requestsPath);
  const request = doc.requests.find((entry) => entry.requestId === parsed.requestId);
  if (request === undefined) {
    throw new ApprovalsDataError(`approvals: unknown request "${parsed.requestId}"`);
  }
  return lineOf(request);
}

export async function runApprovalsMain(argv: readonly string[]): Promise<number> {
  const shell: Omit<ApprovalsCliDeps, "confirm"> = {
    now: () => new Date(),
    out: (line: string): void => {
      console.log(line);
    },
    err: (line: string): void => {
      console.error(line);
    },
  };
  if (argv[0] !== "decide") {
    const unavailable = (): Promise<string> =>
      Promise.reject(new Error("approvals: confirm is unavailable for this command"));
    return runApprovalsCli(argv, { ...shell, confirm: unavailable });
  }
  let requestLine: string;
  try {
    requestLine = await requestLineFor(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith("approvals") ? message : `approvals: ${message}`);
    return 2;
  }
  const ttyConfirm = (prompt: string): Promise<string> => confirmFromTty(requestLine, prompt);
  return runApprovalsCli(argv, { ...shell, confirm: ttyConfirm });
}

if (import.meta.main) {
  process.exitCode = await runApprovalsMain(Bun.argv.slice(2));
}

// Budget gate client: run before any model work. It spawns the configured
// check command and maps its result to admit/refuse. Anything unexpected
// (nonzero rc outside 0/3, signal, timeout, stdout mismatch) throws and
// never admits.
import { readInputText, statInputPath } from "../fs/input.js";

export type Admission =
  | { readonly admit: true; readonly line: string }
  | { readonly admit: false; readonly reason: string; readonly line: string };

export interface BudgetGate {
  admit(): Promise<Admission>;
}
export interface BudgetGateOptions {
  readonly command: readonly string[];
  readonly timeoutMs: number;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

const GATE_CONFIG_PATH = "config/budget-gate.json";
const MAX_STDERR_SNIPPET = 500;

export class BudgetGateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BudgetGateError";
  }
}

function requiredCommand(record: Record<string, unknown>, path: string): readonly string[] {
  const command = record.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((entry: unknown) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${path}: 'command' must be a non-empty array of non-empty strings`);
  }
  return command as string[];
}

function requiredTimeout(record: Record<string, unknown>, path: string): number {
  const timeoutMs = record.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600000
  ) {
    throw new Error(`${path}: 'timeoutMs' must be an integer in 1..600000`);
  }
  return timeoutMs;
}

export async function loadBudgetGateConfig(
  path: string = GATE_CONFIG_PATH,
): Promise<{ readonly command: readonly string[]; readonly timeoutMs: number }> {
  const label = "Budget gate";
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} ${path}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} ${path}: must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "command" || keys[1] !== "timeoutMs") {
    throw new Error(`${label} ${path}: only 'command' and 'timeoutMs' are allowed`);
  }
  return { command: requiredCommand(record, path), timeoutMs: requiredTimeout(record, path) };
}

const ADMITTED_PATTERN = /^admitted: .+$/m;
const REFUSED_PATTERN = /^refused: (.+?) \(today /m;

// Bounds a pipe read by a deadline in milliseconds. The bound is a setTimeout
// handle cleared as soon as the read wins, so the bound leaves no timer
// behind and a short-lived caller can exit right after admit() resolves (P2).
// Returns null when the deadline expires first.
async function readWithDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T | null> {
  if (deadlineMs <= 0) {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createCliBudgetGate(options: BudgetGateOptions): BudgetGate {
  return {
    async admit(): Promise<Admission> {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([...options.command], {
          cwd: options.cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: options.env,
        });
      } catch (error: unknown) {
        throw new BudgetGateError(
          `budget gate: cannot start ${options.command[0] as string} (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
      const startedAt = Date.now();
      const state = { timedOut: false };
      const timer = setTimeout(() => {
        state.timedOut = true;
        proc.kill("SIGKILL");
      }, options.timeoutMs);
      try {
        const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
        const stderrPromise = new Response(proc.stderr as ReadableStream).text();
        const code = await proc.exited;
        clearTimeout(timer);
        const remaining = options.timeoutMs - (Date.now() - startedAt);
        if (proc.signalCode !== null) {
          if (state.timedOut) {
            throw new BudgetGateError(
              `budget gate: timed out after ${String(options.timeoutMs)} ms`,
            );
          }
          const snippet = await readWithDeadline(stderrPromise, remaining).then(
            (stderr) => (stderr ?? "").slice(0, MAX_STDERR_SNIPPET),
            () => "",
          );
          throw new BudgetGateError(
            `budget gate: killed by signal ${String(proc.signalCode)}: ${snippet}`,
          );
        }
        if (state.timedOut) {
          throw new BudgetGateError(`budget gate: timed out after ${String(options.timeoutMs)} ms`);
        }
        const reads = Promise.all([stdoutPromise, stderrPromise]);
        const bounded = await readWithDeadline(reads, remaining);
        if (bounded === null) {
          throw new BudgetGateError(
            `budget gate: output not closed within ${String(options.timeoutMs)} ms`,
          );
        }
        const [stdout, stderr] = bounded;
        const commandText = JSON.stringify(options.command);
        if (code === 0 && ADMITTED_PATTERN.test(stdout)) {
          const line = findLine(stdout, /^admitted: /);
          if (line !== undefined) {
            return { admit: true, line };
          }
        }
        if (code === 3) {
          const reason = REFUSED_PATTERN.exec(stdout)?.[1];
          const line = findLine(stdout, /^refused: /);
          if (reason !== undefined && line !== undefined) {
            return { admit: false, reason, line };
          }
        }
        const snippet = stderr.slice(0, MAX_STDERR_SNIPPET);
        throw new BudgetGateError(
          `budget gate command ${commandText} failed with rc ${String(code)}: ${snippet}`,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function findLine(stdout: string, pattern: RegExp): string | undefined {
  return stdout.split("\n").find((entry) => pattern.test(entry));
}

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
    throw new Error(`${path}: \"command\" must be a non-empty array of non-empty strings`);
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
    throw new Error(`${path}: \"timeoutMs\" must be an integer in 1..600000`);
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
    throw new Error(`${label} ${path}: only \"command\" and \"timeoutMs\" are allowed`);
  }
  return { command: requiredCommand(record, path), timeoutMs: requiredTimeout(record, path) };
}

const ADMITTED_PATTERN = /^admitted: .+$/m;
const REFUSED_PATTERN = /^refused: (.+?) \(today /m;

export function createCliBudgetGate(options: BudgetGateOptions): BudgetGate {
  return {
    async admit(): Promise<Admission> {
      const proc = Bun.spawn([...options.command], {
        cwd: options.cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const timeout = setTimeout(() => {
        try {
          proc.kill(9);
        } catch {
          // The child may have exited already; the timeout path throws below.
        }
      }, options.timeoutMs);
      let stdout: string;
      let stderr: string;
      let code: number | null;
      let signal: string | null;
      try {
        [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
          proc.exited,
        ]);
        signal = proc.signalCode;
      } finally {
        clearTimeout(timeout);
      }
      if (signal !== null && signal !== undefined) {
        const snippet = stderr.slice(0, MAX_STDERR_SNIPPET);
        throw new BudgetGateError(
          `budget gate command ${JSON.stringify(options.command)} killed by signal ${signal}: ${snippet}`,
        );
      }
      if (code === 0 && ADMITTED_PATTERN.test(stdout)) {
        const line = stdout.split("\n").find((entry) => /^admitted: /.test(entry)) as string;
        return { admit: true, line };
      }
      if (code === 3) {
        const match = REFUSED_PATTERN.exec(stdout);
        if (match?.[1] !== undefined) {
          const line = stdout.split("\n").find((entry) => /^refused: /.test(entry)) as string;
          return { admit: false, reason: match[1], line };
        }
      }
      const snippet = stderr.slice(0, MAX_STDERR_SNIPPET);
      throw new BudgetGateError(
        `budget gate command ${JSON.stringify(options.command)} failed with rc ${String(code)}: ${snippet}`,
      );
    },
  };
}

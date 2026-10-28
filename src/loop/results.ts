// Per-round result record: one JSON line per closed round in
// logs/loop-results.jsonl. Reads tolerate a torn tail; appends repair it.
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { open, readFile, truncate } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkItem } from "../../contracts/v1/types.js";
import { readInputText, statInputPath } from "../fs/input.js";
import { OUTCOME_CLASSES } from "./policy.js";
import type { RoundRecord, RoutingResult, RoundOutcome } from "./types.js";
import resultsSchema from "./results.schema.json" with { type: "json" };

export class LoopResultsDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopResultsDataError";
  }
}

export class LoopResultsWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopResultsWriteError";
  }
}

export interface ResultLine {
  readonly schemaVersion: "v1";
  readonly key: string;
  readonly at: string;
  readonly workItemId: string;
  readonly repo: string;
  readonly round: number;
  readonly retry: number;
  readonly model: string;
  readonly providerId: string;
  readonly hostAlias: string | null;
  readonly outcome: RoundOutcome;
  readonly routingResult: RoutingResult;
}

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const validateResult = ajv.compile(resultsSchema);

function checkLineShape(value: unknown): asserts value is ResultLine {
  if (!validateResult(value)) {
    const errors = validateResult.errors ?? [];
    const first = errors[0] as { instancePath?: string; keyword?: string } | undefined;
    const where =
      first?.instancePath === "" || first?.instancePath === undefined ? "/" : first.instancePath;
    throw new LoopResultsDataError(`invalid shape at ${where} (${String(first?.keyword)})`);
  }
}

function checkLineRules(line: ResultLine): void {
  if (line.key !== `${line.workItemId}:${String(line.round)}`) {
    throw new LoopResultsDataError("rule R-a");
  }
  if (line.routingResult !== OUTCOME_CLASSES[line.outcome].routing) {
    throw new LoopResultsDataError("rule R-b");
  }
}

function checkResultLine(line: ResultLine): void {
  checkLineShape(line);
  checkLineRules(line);
}

// The result line derived from a closed round record alone.
export function resultLineOf(item: WorkItem, record: RoundRecord): ResultLine {
  return {
    schemaVersion: "v1",
    key: `${item.id}:${String(record.round)}`,
    at: record.at,
    workItemId: item.id,
    repo: item.repo,
    round: record.round,
    retry: record.retry,
    model: record.model,
    providerId: record.providerId,
    hostAlias: record.hostAlias,
    outcome: record.outcome,
    routingResult: OUTCOME_CLASSES[record.outcome].routing,
  };
}

function parseLine(segment: string, path: string, line: number): ResultLine {
  const label = `loop results ${path}: line ${String(line)}`;
  if (segment === "") {
    throw new LoopResultsDataError(`${label}: empty`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(segment) as unknown;
  } catch {
    throw new LoopResultsDataError(`${label}: not JSON`);
  }
  try {
    const candidate = raw as ResultLine;
    checkResultLine(candidate);
    return candidate;
  } catch (error: unknown) {
    if (error instanceof LoopResultsDataError) {
      throw new LoopResultsDataError(`${label}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export async function readResults(path: string): Promise<readonly ResultLine[]> {
  const label = "loop results";
  let status: "absent" | "file";
  try {
    status = await statInputPath(label, path);
  } catch (error: unknown) {
    throw new LoopResultsDataError(`${label} ${path}: cannot stat path`, { cause: error });
  }
  if (status === "absent") {
    return [];
  }
  let text: string;
  try {
    text = await readInputText(label, path);
  } catch (error: unknown) {
    throw new LoopResultsDataError(`${label} ${path}: cannot read file`, { cause: error });
  }
  if (text === "") {
    return [];
  }
  const segments = text.split("\n");
  const last: string | undefined = segments[segments.length - 1];
  // A non-empty last segment is a torn tail: ignored, left in place.
  const body = last === "" ? segments.slice(0, -1) : segments.slice(0, -1);
  const lines: ResultLine[] = [];
  const seen = new Set<string>();
  body.forEach((segment: string | undefined, index) => {
    if (segment === undefined || segment === "") {
      throw new LoopResultsDataError(`loop results ${path}: line ${String(index + 1)}: empty`);
    }
    const parsed = parseLine(segment, path, index + 1);
    if (!seen.has(parsed.key)) {
      seen.add(parsed.key);
      lines.push(parsed);
    }
  });
  return lines;
}

// One in-process chain per resolved path, so concurrent appends keep order.
const appendChains = new Map<string, Promise<void>>();

function errnoOf(error: unknown): string {
  return String((error as NodeJS.ErrnoException).code);
}

async function appendOnce(
  path: string,
  line: ResultLine,
): Promise<{ readonly truncatedBytes: number }> {
  let truncatedBytes = 0;
  try {
    const raw = await readFile(path);
    const lastNewline = raw.lastIndexOf(0x0a);
    const tail = lastNewline === -1 ? raw.length : raw.length - lastNewline - 1;
    if (tail > 0) {
      await truncate(path, raw.length - tail);
      truncatedBytes = tail;
    }
  } catch (error: unknown) {
    if (errnoOf(error) !== "ENOENT") {
      throw new LoopResultsWriteError(
        `loop results ${path}: cannot repair tail (${errnoOf(error)})`,
        { cause: error },
      );
    }
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "a", 0o600);
    await handle.write(`${JSON.stringify(line)}\n`);
    await handle.sync();
  } catch (error: unknown) {
    throw new LoopResultsWriteError(`loop results ${path}: cannot append (${errnoOf(error)})`, {
      cause: error,
    });
  } finally {
    if (handle !== null) {
      await handle.close().catch((error: unknown) => {
        throw new LoopResultsWriteError(`loop results ${path}: cannot close (${errnoOf(error)})`, {
          cause: error,
        });
      });
    }
  }
  return { truncatedBytes };
}

export async function appendResultLine(
  path: string,
  line: ResultLine,
): Promise<{ readonly truncatedBytes: number }> {
  try {
    checkResultLine(line);
  } catch (error: unknown) {
    if (error instanceof LoopResultsDataError) {
      throw new LoopResultsDataError(`loop results ${path}: ${error.message}`, { cause: error });
    }
    throw error;
  }
  const key = resolve(path);
  const previous = appendChains.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = previous.then(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  appendChains.set(key, current);
  await previous;
  try {
    return await appendOnce(path, line);
  } finally {
    release();
    if (appendChains.get(key) === current) {
      appendChains.delete(key);
    }
  }
}

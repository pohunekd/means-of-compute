// Evidence bundle builder: redacts paths, copies run files and scans deny patterns.
// The key value is compared in memory only, never printed or written.
import { homedir } from "node:os";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { InputPathError, readInputText, statInputPath } from "../fs/input.js";
import { writeFileAtomic } from "../fs/write.js";
import { sha256Hex } from "../work/canonical.js";
import { definedEnv } from "../mcp/client.js";
import { CoordConfigError, loadCoordConfig } from "./config.js";

export function redactText(
  text: string,
  paths: { readonly runDirs: readonly string[]; readonly cwd: string; readonly home: string },
): string {
  let out = text;
  for (const runDir of paths.runDirs) {
    out = out.replaceAll(join(runDir, "home"), "<run-home>");
  }
  return out.replaceAll(paths.cwd, "<checkout>").replaceAll(paths.home, "~");
}

const PROMPT_PATTERN = /^prompt-\d+\.md$/;
const EXPORT_PATTERN = /^session-\d+-export\.json$/;
const REQUIRED_FILES = ["report.md", "report.json", "mcp-calls.jsonl"] as const;

class EvidenceInputError extends Error {}

function parseArgs(argv: readonly string[]): { runDir: string; outDir: string } {
  let runDir: string | null = null;
  let outDir: string | null = null;
  let runCount = 0;
  let outCount = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--run" || arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value === "") {
        throw new EvidenceInputError(`${arg} needs a value`);
      }
      i += 1;
      if (arg === "--run") {
        runCount += 1;
        if (runCount > 1) {
          throw new EvidenceInputError("--run given more than once");
        }
        runDir = value;
      } else {
        outCount += 1;
        if (outCount > 1) {
          throw new EvidenceInputError("--out given more than once");
        }
        outDir = value;
      }
    } else {
      throw new EvidenceInputError(`unknown argument ${arg}`);
    }
  }
  if (runDir === null) {
    throw new EvidenceInputError("--run is required");
  }
  if (outDir === null) {
    throw new EvidenceInputError("--out is required");
  }
  return { runDir, outDir };
}

interface LoadedReport {
  readonly configPath: string;
  readonly configSha256: string;
}

async function loadRunReport(runDir: string): Promise<LoadedReport> {
  const path = join(runDir, "report.json");
  let text: string;
  try {
    text = await readInputText("Run report", path);
  } catch {
    throw new EvidenceInputError(`${path} is not a run report`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch {
    throw new EvidenceInputError(`${path} is not a run report`);
  }
  if (
    typeof doc !== "object" ||
    doc === null ||
    Array.isArray(doc) ||
    typeof (doc as Record<string, unknown>)["configPath"] !== "string" ||
    typeof (doc as Record<string, unknown>)["configSha256"] !== "string"
  ) {
    throw new EvidenceInputError(`${path} is not a run report`);
  }
  const record = doc as Record<string, string>;
  return {
    configPath: record["configPath"] as string,
    configSha256: record["configSha256"] as string,
  };
}

export async function run(argv: readonly string[]): Promise<number> {
  let prepared: {
    readonly runDir: string;
    readonly outDir: string;
    readonly configPath: string;
    readonly denyPatterns: readonly string[];
    readonly apiKeyEnv: string;
    readonly texts: Array<{ readonly name: string; readonly text: string }>;
  };
  try {
    const { runDir, outDir } = parseArgs(argv);
    const report = await loadRunReport(runDir);
    const configText = await readInputText("Evidence config", report.configPath);
    if (sha256Hex(configText) !== report.configSha256) {
      throw new EvidenceInputError(`config ${report.configPath} changed since the run`);
    }
    const { config, apiKeyEnv } = await loadCoordConfig(report.configPath);
    console.error(
      `coord:evidence: config ${report.configPath}, ${String(config.evidenceDenyPatterns.length)} deny patterns`,
    );
    let outEntry: unknown;
    try {
      outEntry = await lstat(outDir);
    } catch {
      outEntry = null;
    }
    if (outEntry !== null) {
      throw new EvidenceInputError(`${outDir} already exists`);
    }
    let parentEntry: unknown;
    try {
      parentEntry = await stat(dirname(outDir));
    } catch {
      parentEntry = null;
    }
    if (
      parentEntry === null ||
      typeof (parentEntry as { isDirectory?: unknown }).isDirectory !== "function" ||
      !(parentEntry as { isDirectory(): boolean }).isDirectory()
    ) {
      throw new EvidenceInputError(`${outDir} parent is not a directory`);
    }
    let entries: string[];
    try {
      entries = await readdir(runDir);
    } catch (error: unknown) {
      throw new EvidenceInputError(
        `${runDir} cannot be read (${String((error as NodeJS.ErrnoException).code)})`,
      );
    }
    const names: string[] = [...REQUIRED_FILES];
    for (const entry of entries) {
      if (PROMPT_PATTERN.test(entry) || EXPORT_PATTERN.test(entry)) {
        names.push(entry);
      }
    }
    names.sort();
    const cwd = process.cwd();
    const home = homedir();
    const runAbs = resolve(runDir);
    const runReal = await realpath(runAbs);
    const runDirs = runReal === runAbs ? [runAbs] : [runReal, runAbs];
    const texts: Array<{ readonly name: string; readonly text: string }> = [];
    for (const name of names) {
      const source = join(runDir, name);
      let raw: string;
      try {
        raw = await readInputText("Run file", source);
      } catch (error: unknown) {
        if (error instanceof InputPathError) {
          const status = await statInputPath("Run file", source);
          if (status === "absent") {
            throw new EvidenceInputError(`${runDir}/${name} is missing`);
          }
          throw error;
        }
        throw error;
      }
      texts.push({ name, text: redactText(raw, { runDirs, cwd, home }) });
    }
    prepared = {
      runDir,
      outDir,
      configPath: report.configPath,
      denyPatterns: config.evidenceDenyPatterns,
      apiKeyEnv,
      texts,
    };
  } catch (error: unknown) {
    if (
      error instanceof EvidenceInputError ||
      error instanceof InputPathError ||
      error instanceof CoordConfigError
    ) {
      console.error(`coord:evidence: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const patterns = prepared.denyPatterns.map((p) => new RegExp(p));
  const env = definedEnv(process.env);
  const keyValue = env[prepared.apiKeyEnv];
  const literal = keyValue === undefined || keyValue === "" ? null : keyValue;
  let hits = 0;
  for (const { name, text } of prepared.texts) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      let index: number | null = null;
      if (literal !== null && line.includes(literal)) {
        index = -1;
      } else {
        for (let p = 0; p < patterns.length; p += 1) {
          if ((patterns[p] as RegExp).test(line)) {
            index = p;
            break;
          }
        }
      }
      if (index === null) {
        continue;
      }
      const label = index === -1 ? "key" : String(index);
      console.error(`coord:evidence: ${name}:${String(i + 1)} matches deny pattern ${label}`);
      hits += 1;
    }
  }
  await mkdir(prepared.outDir, { mode: 0o700 });
  for (const { name, text } of prepared.texts) {
    await writeFileAtomic("Evidence file", join(prepared.outDir, name), text);
  }
  if (hits > 0) {
    return 3;
  }
  for (const { name } of prepared.texts) {
    console.log(join(prepared.outDir, name));
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await run(Bun.argv.slice(2));
  } catch (error: unknown) {
    console.error(`coord:evidence: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

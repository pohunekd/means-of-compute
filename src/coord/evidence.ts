// Evidence bundle builder: redacts paths, copies run files and scans deny patterns.
// The key value is compared in memory only, never printed or written.
import { homedir } from "node:os";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readInputText } from "../fs/input.js";
import { writeFileAtomic } from "../fs/write.js";
import { sha256Hex } from "../work/canonical.js";
import { definedEnv } from "../mcp/client.js";
import { loadCoordConfig } from "./config.js";

export function redactText(
  text: string,
  paths: { readonly cwd: string; readonly home: string },
): string {
  return text.replaceAll(paths.cwd, "<checkout>").replaceAll(paths.home, "~");
}

const PROMPT_PATTERN = /^prompt-\d+\.md$/;
const EXPORT_PATTERN = /^session-\d+-export\.json$/;
const REQUIRED_FILES = ["report.md", "report.json", "mcp-calls.jsonl"] as const;

function fail(message: string): never {
  console.error(`coord:evidence: ${message}`);
  process.exit(2);
  throw new Error("unreachable");
}

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
        fail(`${arg} needs a value`);
      }
      i += 1;
      if (arg === "--run") {
        runCount += 1;
        if (runCount > 1) {
          fail("--run given more than once");
        }
        runDir = value;
      } else {
        outCount += 1;
        if (outCount > 1) {
          fail("--out given more than once");
        }
        outDir = value;
      }
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  if (runDir === null) {
    fail("--run is required");
  }
  if (outDir === null) {
    fail("--out is required");
  }
  return { runDir, outDir };
}

interface LoadedReport {
  readonly configPath: string;
  readonly configSha256: string;
}

async function loadRunReport(runDir: string): Promise<LoadedReport> {
  const path = join(runDir, "report.json");
  const text = await readInputText("Run report", path);
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch {
    fail(`${path} is not a run report`);
  }
  if (
    typeof doc !== "object" ||
    doc === null ||
    Array.isArray(doc) ||
    typeof (doc as Record<string, unknown>)["configPath"] !== "string" ||
    typeof (doc as Record<string, unknown>)["configSha256"] !== "string"
  ) {
    fail(`${path} is not a run report`);
  }
  const record = doc as Record<string, string>;
  return {
    configPath: record["configPath"] as string,
    configSha256: record["configSha256"] as string,
  };
}

export async function run(argv: readonly string[]): Promise<number> {
  const { runDir, outDir } = parseArgs(argv);
  const report = await loadRunReport(runDir);
  const configText = await readInputText("Evidence config", report.configPath);
  if (sha256Hex(configText) !== report.configSha256) {
    fail(`config ${report.configPath} changed since the run`);
  }
  const { config, apiKeyEnv } = await loadCoordConfig(report.configPath);
  console.error(
    `coord:evidence: config ${report.configPath}, ${String(config.evidenceDenyPatterns.length)} deny patterns`,
  );
  if ((await stat(outDir).catch(() => null)) !== null) {
    fail(`${outDir} already exists`);
  }
  await mkdir(outDir, { mode: 0o700 });
  const names: string[] = [...REQUIRED_FILES];
  for (const entry of await readdir(runDir)) {
    if (PROMPT_PATTERN.test(entry) || EXPORT_PATTERN.test(entry)) {
      names.push(entry);
    }
  }
  names.sort();
  const cwd = process.cwd();
  const home = homedir();
  const written: Array<{ readonly name: string; readonly text: string }> = [];
  for (const name of names) {
    const source = join(runDir, name);
    let redacted: string;
    try {
      redacted = redactText(await readInputText("Run file", source), { cwd, home });
    } catch {
      fail(`${source} is missing`);
    }
    await writeFileAtomic("Evidence file", join(outDir, name), redacted);
    written.push({ name, text: redacted });
  }
  const patterns = config.evidenceDenyPatterns.map((p) => new RegExp(p));
  const env = definedEnv(process.env);
  const keyValue = env[apiKeyEnv];
  const literal = keyValue === undefined || keyValue === "" ? null : keyValue;
  let hits = 0;
  for (const { name, text } of written) {
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
  if (hits > 0) {
    return 3;
  }
  for (const { name } of written) {
    console.log(join(outDir, name));
  }
  return 0;
}

try {
  process.exitCode = await run(Bun.argv.slice(2));
} catch (error: unknown) {
  console.error(`coord:evidence: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

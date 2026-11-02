// CLI for fleet simulator: bun run sim:fleet --timeline <path> --out <path>
import { readFile, stat } from "node:fs/promises";
import { loadPlacementConfig } from "../placement/config.js";
import { loadTimeline } from "./timeline.js";
import { runTimeline } from "./run.js";
import { writeFileAtomic } from "../fs/write.js";

function parseFlags(args: string[]): { timeline: string; out: string } {
  const allowed = new Set(["--timeline", "--out"]);
  const seen = new Map<string, number>();
  let timeline: string | null = null;
  let out: string | null = null;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      break;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`sim:fleet: unknown flag "${arg}"`);
    }
    if (!allowed.has(arg)) {
      throw new Error(`sim:fleet: unknown flag "${arg}"`);
    }
    const count = seen.get(arg) ?? 0;
    if (count >= 1) {
      throw new Error(`sim:fleet: flag "${arg}" repeated`);
    }
    seen.set(arg, count + 1);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`sim:fleet: ${arg} needs a file path`);
    }
    if (arg === "--timeline") {
      timeline = value;
    } else if (arg === "--out") {
      out = value;
    }
    i += 2;
  }
  if (timeline === null) {
    throw new Error("sim:fleet: --timeline is required");
  }
  if (out === null) {
    throw new Error("sim:fleet: --out is required");
  }
  return { timeline, out };
}

async function guardOutPath(outPath: string): Promise<void> {
  try {
    const s = await stat(outPath);
    if (!s.isFile()) {
      return;
    }
  } catch {
    return;
  }
  let text: string;
  try {
    text = await readFile(outPath, "utf8");
  } catch {
    throw new Error(`Trace ${outPath}: cannot read existing file`);
  }
  const firstLine = text.split("\n")[0] ?? "";
  if (firstLine.length === 0) {
    throw new Error(`Trace ${outPath}: refusing to overwrite existing file`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    throw new Error(`Trace ${outPath}: refusing to overwrite existing file`);
  }
  const rec = parsed as Record<string, unknown>;
  if (rec["kind"] !== "header" || rec["schemaVersion"] !== "sim-trace-v1") {
    throw new Error(`Trace ${outPath}: refusing to overwrite existing file`);
  }
}

async function main(): Promise<number> {
  let flags: { timeline: string; out: string };
  try {
    flags = parseFlags(Bun.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    await guardOutPath(flags.out);
    const timeline = await loadTimeline(flags.timeline);
    const config = await loadPlacementConfig();
    const lines = runTimeline({ timeline, config });
    const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    await writeFileAtomic("Trace", flags.out, text);
    const hostCount = timeline.generators.reduce((sum, g) => sum + g.count, 0);
    let changes = 0;
    let calls = 0;
    let chosenCount = 0;
    for (const line of lines) {
      if (line.kind === "host") {
        changes += 1;
      } else if (line.kind === "placement") {
        calls += 1;
        if (line.chosenHostAlias !== null) {
          chosenCount += 1;
        }
      }
    }
    const unplaced = calls - chosenCount;
    console.log(
      `sim: ${String(hostCount)} hosts, ${String(changes)} host changes, ${String(calls)} placements (${String(chosenCount)} chosen, ${String(unplaced)} unplaced) -> ${flags.out}`,
    );
    return 0;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

const code = await main();
process.exit(code);

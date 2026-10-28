#!/usr/bin/env bun

import { dirname, join } from "node:path";
import { runProbe } from "./probe.js";
import { loadHostFile, loadPluginConfig } from "./config.js";

const configDir = join(dirname(Bun.main), "..", "config");

function parseArgs(args: readonly string[]): {
  factsPath?: string;
  scenario?: string;
} {
  let factsPath: string | undefined;
  let scenario: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--facts" && args[i + 1] !== undefined) {
      factsPath = args[i + 1];
      i++;
    } else if (arg === "--scenario" && args[i + 1] !== undefined) {
      scenario = args[i + 1];
      i++;
    } else {
      process.stderr.write("moc-host-state: unknown argument\n");
      process.exit(2);
    }
  }
  return { factsPath, scenario };
}

async function main(): Promise<void> {
  const { factsPath, scenario } = parseArgs(Bun.argv.slice(2));
  const output = await runProbe({
    configDir,
    resolveHostAlias: () => loadHostFile(loadPluginConfig(join(configDir, "plugin.json")).hostFile),
    factsPath,
    scenario,
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

#!/usr/bin/env bun

import { runProbe } from "./src/probe/probe.js";
import { FactsError } from "./src/probe/facts.js";

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  let factsPath: string | undefined;
  let scenario: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--facts" && args[i + 1]) {
      factsPath = args[i + 1];
      i++;
    } else if (args[i] === "--scenario" && args[i + 1]) {
      scenario = args[i + 1];
      i++;
    }
  }

  const output = await runProbe({ factsPath, scenario });
  console.log(JSON.stringify(output));
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    if (e instanceof FactsError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    console.error(e);
    process.exit(1);
  });
}

#!/usr/bin/env bun

import { runProbe } from "../../src/probe/probe.js";

const configDir = Bun.argv[2];
const factsPath = Bun.argv[3];
if (!configDir || !factsPath) {
  console.error("usage: darwin-probe.ts <configDir> <factsPath>");
  process.exit(2);
}

const doc = await runProbe({
  configDir,
  resolveHostAlias: () => "laptop-mac",
  factsPath,
});
console.log(JSON.stringify(doc));

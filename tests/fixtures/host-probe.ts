#!/usr/bin/env bun

import { runProbe } from "../../src/probe/probe.js";
import { loadHostFile } from "../../src/probe/config.js";

const configDir = Bun.argv[2];
const factsPath = Bun.argv[3];
const hostFile = Bun.argv[4];
if (!configDir || !factsPath || !hostFile) {
  console.error("usage: host-probe.ts <configDir> <factsPath> <hostFile>");
  process.exit(2);
}

const doc = await runProbe({
  configDir,
  resolveHost: () => loadHostFile(hostFile),
  factsPath,
});
console.log(JSON.stringify(doc));

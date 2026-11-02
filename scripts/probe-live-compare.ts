#!/usr/bin/env bun
// Compares two HostCapacity JSON files (one-line documents) from the TS
// probe and the Rust binary. See issue #263.

import { isHostCapacity } from "../contracts/v1/validate.js";

const [tsPath, rsPath] = Bun.argv.slice(2);

if (!tsPath || !rsPath) {
  console.error("usage: bun run scripts/probe-live-compare.ts <ts.json> <rs.json>");
  process.exit(2);
}

async function loadHostCapacity(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (e) {
    console.error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  // Enforce one-line document: exactly one non-empty line that is JSON.
  const trimmed = text.trim();
  const lines = trimmed.split("\n");
  if (lines.length !== 1) {
    console.log(`${path}: not a one-line document`);
    process.exit(1);
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    console.log(`${path}: not JSON`);
    process.exit(1);
  }
  if (!isHostCapacity(value)) {
    console.log(`${path}: not HostCapacity`);
    process.exit(1);
  }
  return value;
}

const tsValue = (await loadHostCapacity(tsPath)) as Record<string, unknown>;
const rsValue = (await loadHostCapacity(rsPath)) as Record<string, unknown>;

const diffs: string[] = [];

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

if (tsValue["hostAlias"] !== rsValue["hostAlias"]) {
  diffs.push(
    `hostAlias differs: ${String(tsValue["hostAlias"])} vs ${String(rsValue["hostAlias"])}`,
  );
}
if (tsValue["idle"] !== rsValue["idle"]) {
  diffs.push(`idle differs: ${String(tsValue["idle"])} vs ${String(rsValue["idle"])}`);
}
if (tsValue["acPower"] !== rsValue["acPower"]) {
  diffs.push(`acPower differs: ${String(tsValue["acPower"])} vs ${String(rsValue["acPower"])}`);
}
if (!equal(tsValue["batteryPercent"], rsValue["batteryPercent"])) {
  diffs.push(
    `batteryPercent differs: ${JSON.stringify(tsValue["batteryPercent"])} vs ${JSON.stringify(rsValue["batteryPercent"])}`,
  );
}

const tsCpu = tsValue["cpu"] as Record<string, unknown>;
const rsCpu = rsValue["cpu"] as Record<string, unknown>;
if (tsCpu["cores"] !== rsCpu["cores"]) {
  diffs.push(`cpu.cores differs: ${String(tsCpu["cores"])} vs ${String(rsCpu["cores"])}`);
}

const tsMem = tsValue["memory"] as Record<string, unknown>;
const rsMem = rsValue["memory"] as Record<string, unknown>;
if (tsMem["totalMb"] !== rsMem["totalMb"]) {
  diffs.push(`memory.totalMb differs: ${String(tsMem["totalMb"])} vs ${String(rsMem["totalMb"])}`);
}

if (!equal(tsValue["gpu"], rsValue["gpu"])) {
  diffs.push(`gpu differs: ${JSON.stringify(tsValue["gpu"])} vs ${JSON.stringify(rsValue["gpu"])}`);
}
if (!equal(tsValue["localModels"], rsValue["localModels"])) {
  diffs.push(
    `localModels differs: ${JSON.stringify(tsValue["localModels"])} vs ${JSON.stringify(rsValue["localModels"])}`,
  );
}
if (!equal(tsValue["policy"], rsValue["policy"])) {
  diffs.push(
    `policy differs: ${JSON.stringify(tsValue["policy"])} vs ${JSON.stringify(rsValue["policy"])}`,
  );
}

const tsIdleReason = tsValue["idleReason"] as string;
const rsIdleReason = rsValue["idleReason"] as string;
const normalize = (s: string): string => s.replace(/[0-9]+/g, "N");
if (normalize(tsIdleReason) !== normalize(rsIdleReason)) {
  diffs.push(
    `idleReason differs: ${JSON.stringify(tsIdleReason)} vs ${JSON.stringify(rsIdleReason)} (normalized ${JSON.stringify(normalize(tsIdleReason))} vs ${JSON.stringify(normalize(rsIdleReason))})`,
  );
}

const tsSeconds = Number(tsValue["secondsSinceInput"]);
const rsSeconds = Number(rsValue["secondsSinceInput"]);
if (Number.isFinite(tsSeconds) && Number.isFinite(rsSeconds)) {
  if (Math.abs(tsSeconds - rsSeconds) > 5) {
    diffs.push(`secondsSinceInput diff > 5: ${String(tsSeconds)} vs ${String(rsSeconds)}`);
  }
} else {
  diffs.push(`secondsSinceInput not a number`);
}

const tsFree = Number(tsMem["freeMb"]);
const rsFree = Number(rsMem["freeMb"]);
const totalMb = Number(tsMem["totalMb"] ?? rsMem["totalMb"]);
if (Number.isFinite(tsFree) && Number.isFinite(rsFree) && Number.isFinite(totalMb) && totalMb > 0) {
  const diff = Math.abs(tsFree - rsFree);
  const threshold = totalMb * 0.05;
  if (diff > threshold) {
    diffs.push(
      `memory.freeMb diff > 5% of totalMb: ${String(tsFree)} vs ${String(rsFree)} (threshold ${String(threshold)})`,
    );
  }
} else {
  diffs.push(`memory.freeMb not comparable`);
}

if (diffs.length === 0) {
  console.log("probe live compare: match");
  process.exit(0);
} else {
  for (const line of diffs) {
    console.log(line);
  }
  process.exit(1);
}

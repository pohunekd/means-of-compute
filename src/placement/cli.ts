// CLI entry point for placement: bun run place --item <file> --hosts <file>
// --running <file>. All three flags are required. --hosts is a JSON array of
// HostCapacity, --running a JSON array of WorkItem (possibly empty). Exit 0
// with the PlacementDecision on stdout when a host is chosen, exit 3 with the
// decision when no host is eligible, exit 2 on any input or config error. An
// error never yields a decision.
import {
  contractErrors,
  isHostCapacity,
  isPlacementDecision,
  isWorkItem,
  type SchemaName,
} from "../../contracts/v1/validate.js";
import type { HostCapacity, WorkItem } from "../../contracts/v1/types.js";
import { readInputText, statInputPath } from "../fs/input.js";
import { loadPlacementWeights } from "./config.js";
import { place } from "./place.js";

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const raw = args[index + 1];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`place: ${flag} needs a file path`);
  }
  return raw;
}

function contractPointer(schemaName: SchemaName, value: unknown): string {
  const errors = contractErrors(schemaName, value) as readonly { instancePath?: unknown }[] | null;
  const first = errors?.[0];
  const pointer =
    typeof first?.instancePath === "string" && first.instancePath.length > 0
      ? first.instancePath
      : "/";
  return pointer;
}

async function readJsonFile(label: string, path: string): Promise<unknown> {
  if ((await statInputPath(label, path)) === "absent") {
    throw new Error(`${label} ${path}: file is missing`);
  }
  const text = await readInputText(label, path);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} ${path}: not valid JSON`);
  }
}

function readWorkItem(label: string, path: string, value: unknown): WorkItem {
  if (!isWorkItem(value)) {
    throw new Error(
      `${label} ${path}: invalid work item at ${contractPointer("work-item", value)}`,
    );
  }
  if (value.status !== "queued") {
    throw new Error(`${label} ${path}: work item status must be "queued", got "${value.status}"`);
  }
  return value;
}

function readHosts(label: string, path: string, value: unknown): HostCapacity[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} ${path}: must be a JSON array of host capacity documents`);
  }
  if (value.length === 0) {
    throw new Error(`${label} ${path}: must not be an empty array`);
  }
  const hosts: HostCapacity[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (!isHostCapacity(entry)) {
      throw new Error(
        `${label} ${path}: invalid host capacity at index ${String(index)} (${contractPointer("host-capacity", entry)})`,
      );
    }
    if (seen.has(entry.hostAlias)) {
      throw new Error(
        `${label} ${path}: duplicate hostAlias "${entry.hostAlias}" at index ${String(index)}`,
      );
    }
    seen.add(entry.hostAlias);
    hosts.push(entry);
  }
  return hosts;
}

function readRunning(label: string, path: string, value: unknown): WorkItem[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} ${path}: must be a JSON array of work items`);
  }
  const items: WorkItem[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (!isWorkItem(entry)) {
      throw new Error(
        `${label} ${path}: invalid work item at index ${String(index)} (${contractPointer("work-item", entry)})`,
      );
    }
    items.push(entry);
  }
  return items;
}

async function run(): Promise<number> {
  let itemPath: string | null;
  let hostsPath: string | null;
  let runningPath: string | null;
  try {
    const args = Bun.argv.slice(2);
    itemPath = flagValue(args, "--item");
    hostsPath = flagValue(args, "--hosts");
    runningPath = flagValue(args, "--running");
    if (itemPath === null || hostsPath === null || runningPath === null) {
      throw new Error("place: --item, --hosts and --running are all required");
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const weights = await loadPlacementWeights();
    const item = readWorkItem("Work item", itemPath, await readJsonFile("Work item", itemPath));
    const hosts = readHosts("Hosts", hostsPath, await readJsonFile("Hosts", hostsPath));
    const running = readRunning(
      "Running work",
      runningPath,
      await readJsonFile("Running work", runningPath),
    );
    const decision = place(item, hosts, running, weights);
    if (!isPlacementDecision(decision)) {
      throw new Error("place: produced decision fails the PlacementDecision contract");
    }
    console.log(JSON.stringify(decision, null, 2));
    return decision.chosenHostAlias === null ? 3 : 0;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

const code = await run();
process.exit(code);

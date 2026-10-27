#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */

import { hostname as osHostname, cpus, totalmem, freemem } from "node:os";
import { contractErrors, isHostCapacity } from "./contracts/v1/validate.js";
import { assertSysfsRoot, configPath, loadConfig, loadHostAlias, readJson } from "./src/probe/config.js";
import { linuxCpu, linuxGpu, linuxManagerIdleSecs, linuxMemory, linuxPower, linuxSecondsSinceInput, linuxUptimeSecs } from "./src/probe/linux.js";

export { loadConfig };

type Facts = Partial<{
  secondsSinceInput: number;
  // Simulates a failed user-activity reader: the probe reports activity as
  // unknown (never idle) with this cause instead of reading live input state.
  userActivityError: string;
  // Simulates a host where the login query ran and found no local session
  // of class user (remote sessions excluded): idle when on AC, battery above
  // threshold, inside the window. Requires an explicit secondsSinceInput
  // fact (combine the two in every scenario); without it the probe exits 1.
  // A failed query is userActivityError instead (never idle). The live
  // manager hint failure fallback (/proc/uptime) is covered by the loginctl
  // test double, not by a fact.
  noLocalUserSession: boolean;
  // Fixture override for every sysfs path (power_supply, drm): a scenario
  // may point it at a committed fixture tree, as an absolute path.
  sysfsRoot: string;
  acPower: boolean;
  batteryPercent: number | null;
  cpuCores: number;
  cpuLoad1m: number;
  memoryTotalMb: number;
  memoryFreeMb: number;
  gpuPresent: boolean;
  gpuName: string | null;
  gpuFreeMb: number | null;
  localModelsReachable: boolean;
  localModels: string[];
  hostAlias: string;
  timestamp: string;
  policyAllowedWindowStart: string;
  policyAllowedWindowEnd: string;
}>;

function parseMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function insideWindow(now: Date, start: string, end: string): boolean {
  const nowM = now.getHours() * 60 + now.getMinutes();
  const startM = parseMinutes(start);
  const endM = parseMinutes(end);
  if (startM === endM) return true;
  if (startM <= endM) {
    return nowM >= startM && nowM < endM;
  }
  return nowM >= startM || nowM < endM;
}

async function macosGpu(): Promise<{
  present: boolean;
  name: string | null;
  freeMb: number | null;
}> {
  try {
    const proc = Bun.spawn(["system_profiler", "SPDisplaysDataType", "-json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0 || !out) throw new Error("system_profiler failed");
    const data = JSON.parse(out) as { SPDisplaysDataType?: { sppci_model?: string }[] };
    const cards = data.SPDisplaysDataType ?? [];
    if (cards.length === 0) return { present: false, name: null, freeMb: null };
    return { present: true, name: cards[0]?.sppci_model ?? null, freeMb: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`gpu unknown: ${msg}`, { cause: e });
  }
}

async function macosPower(): Promise<{ acPower: boolean; batteryPercent: number | null }> {
  const proc = Bun.spawn(["pmset", "-g", "batt"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`pmset failed: exit ${String(proc.exitCode)}`);
  if (!/drawing from/.test(out)) throw new Error("pmset failed: no drawing from line");
  const ac = /AC Power/.test(out);
  const batteryLine = out.split("\n").find((line) => line.includes("InternalBattery"));
  let batteryPercent: number | null = null;
  if (batteryLine !== undefined) {
    const m = /(\d{1,3})%/.exec(batteryLine);
    if (!m || !m[1]) throw new Error(`pmset battery unparsable: ${batteryLine}`);
    batteryPercent = Number(m[1]);
  }
  return { acPower: ac, batteryPercent };
}

async function macosConsoleOwner(): Promise<string> {
  const proc = Bun.spawn(["stat", "-f", "%Su", "/dev/console"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (proc.exitCode !== 0 || !out) throw new Error("console owner query failed");
  return out;
}

async function macosSecondsSinceInput(): Promise<number> {
  const proc = Bun.spawn(["ioreg", "-c", "IOHIDSystem"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error("ioreg HIDIdleTime failed");
  const m = /"HIDIdleTime"\s+=\s+(\d+)/.exec(out);
  if (!m || !m[1]) throw new Error("HIDIdleTime missing");
  const ns = BigInt(m[1]);
  const secs = Number(ns / 1000000000n);
  return secs;
}

async function macosHidIdle(): Promise<number> {
  try {
    return await macosSecondsSinceInput();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`activity unknown after logout: ${msg}`, { cause: e });
  }
}

async function macosCpu(): Promise<{ cores: number; load1m: number }> {
  const cores = cpus().length;
  const proc = Bun.spawn(["sysctl", "-n", "vm.loadavg"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error("sysctl vm.loadavg failed");
  const m = /{(.+?)}/.exec(out);
  if (!m || !m[1]) throw new Error("loadavg parse");
  const parts = m[1]
    .trim()
    .split(/\s+/)
    .map((s) => Number(s));
  const load1m = parts[0];
  if (load1m === undefined || !Number.isFinite(load1m)) throw new Error("loadavg parse");
  return { cores, load1m };
}

function macosMemory(): { totalMb: number; freeMb: number } {
  const total = Math.round(totalmem() / 1024 / 1024);
  const free = Math.round(freemem() / 1024 / 1024);
  return { totalMb: total, freeMb: free };
}

async function queryLocalModels(
  baseUrl: string,
  timeoutMs: number,
): Promise<{ reachable: boolean; models: string[] }> {
  if (!baseUrl) return { reachable: false, models: [] };
  const controller = new AbortController();
  const t = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      return { reachable: false, models: [] };
    }
    const data: unknown = await res.json();
    const items =
      typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)
        ? (data as { data: unknown[] }).data
        : null;
    if (!items) return { reachable: false, models: [] };
    const seen = new Set<string>();
    const models: string[] = [];
    for (const entry of items) {
      if (typeof entry !== "object" || entry === null) continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  } finally {
    clearTimeout(t);
  }
}

function deriveIdle(
  secondsSinceInput: number,
  acPower: boolean,
  batteryPercent: number | null,
  insideWindow: boolean,
  idleMinutes: number,
  batteryThreshold: number,
  userActivityUnknown = false,
  userActivityCause = "",
  powerUnknown = false,
  powerCause = "",
  loggedOut = false,
): { idle: boolean; reason: string } {
  if (userActivityUnknown) {
    return { idle: false, reason: `user activity unknown: ${userActivityCause || "unavailable"}` };
  }
  if (powerUnknown) {
    return { idle: false, reason: `power unknown: ${powerCause || "unavailable"}` };
  }
  const idleMinutesSec = idleMinutes * 60;
  const batteryOk = batteryPercent === null || batteryPercent > batteryThreshold;

  if (!insideWindow) {
    return { idle: false, reason: "outside the policy window" };
  }
  if (!acPower) {
    return { idle: false, reason: "not on AC power" };
  }
  if (!batteryOk) {
    return {
      idle: false,
      reason: `battery at ${String(batteryPercent)} percent, at or below the ${String(batteryThreshold)} percent floor`,
    };
  }
  if (loggedOut) {
    return { idle: true, reason: "no user logged in, on AC power" };
  }
  if (secondsSinceInput < idleMinutesSec) {
    return { idle: false, reason: `user input ${String(secondsSinceInput)} seconds ago` };
  }
  const mins = Math.round(secondsSinceInput / 60);
  return { idle: true, reason: `no user input for ${String(mins)} minutes, on AC power` };
}

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

  let facts: Facts = {};
  if (factsPath) {
    facts = readJson<Facts>(factsPath);
  } else if (scenario) {
    facts = readJson<Facts>(configPath("scenarios", `${scenario}.json`));
  }

  const cfg = loadConfig();
  let sysfsRoot = cfg.sysfsRoot;
  if (facts.sysfsRoot !== undefined) {
    sysfsRoot = facts.sysfsRoot;
    // loadConfig already asserted the config root on Linux; a facts
    // override gets the same rule with the matching label.
    if (process.platform === "linux") {
      assertSysfsRoot(sysfsRoot, "facts: invalid sysfsRoot");
    }
  }
  const hostAlias = facts.hostAlias ?? loadHostAlias(osHostname());
  const now = new Date();
  const timestamp = facts.timestamp ?? now.toISOString();
  const evalAt = new Date(timestamp);

  const windowStart = facts.policyAllowedWindowStart ?? cfg.policy.allowedWindowStart;
  const windowEnd = facts.policyAllowedWindowEnd ?? cfg.policy.allowedWindowEnd;
  const insideWindowBool = insideWindow(evalAt, windowStart, windowEnd);

  const platform = process.platform;

  let secondsSinceInput = facts.secondsSinceInput ?? 0;
  let acPower = facts.acPower ?? true;
  let batteryPercent: number | null = facts.batteryPercent ?? null;
  let cpuCores = facts.cpuCores ?? cpus().length;
  let cpuLoad1m = facts.cpuLoad1m ?? 0;
  let memoryTotalMb = facts.memoryTotalMb ?? 0;
  let memoryFreeMb = facts.memoryFreeMb ?? 0;
  let gpuPresent = facts.gpuPresent ?? false;
  let gpuName = facts.gpuName ?? null;
  let gpuFreeMb = facts.gpuFreeMb ?? null;
  let localModelsReachable = facts.localModelsReachable ?? false;
  let localModelsList = facts.localModels ?? [];

  let userActivityUnknown = typeof facts.userActivityError === "string";
  let userActivityCause = facts.userActivityError ?? "";
  if (facts.noLocalUserSession === false) {
    throw new Error("noLocalUserSession must be true or absent");
  }
  let loggedOut = facts.noLocalUserSession === true;
  let loggedOutSecs: number | null = null;
  if (loggedOut && facts.secondsSinceInput === undefined) {
    throw new Error("noLocalUserSession needs secondsSinceInput");
  }
  let powerUnknown = false;
  let powerCause = "";

  // Facts override the live readers member by member: a member left
  // undefined falls back to the live reader, including inside the grouped
  // gpu and localModels objects. An explicitly set member (even false or an
  // empty list) always wins over the reader; that includes an explicit
  // secondsSinceInput fact next to the logged-out facts. A live value
  // needed on an unsupported platform fails fast. Two exceptions: an
  // explicit noLocalUserSession may only be true (false exits 1), and an
  // unreadable power supply clears acPower only when the fact is absent.
  function platformOrThrow(): "linux" | "darwin" {
    if (platform === "linux" || platform === "darwin") return platform;
    throw new Error("unsupported platform");
  }

  if (userActivityUnknown) {
    secondsSinceInput = 0;
  } else if (facts.secondsSinceInput === undefined) {
    try {
      if (platformOrThrow() === "linux") {
        const secs = await linuxSecondsSinceInput(evalAt.getTime());
        if (Number.isNaN(secs)) {
          loggedOut = true;
          try {
            loggedOutSecs = await linuxManagerIdleSecs(evalAt.getTime());
          } catch (managerError) {
            try {
              loggedOutSecs = linuxUptimeSecs();
            } catch (uptimeError) {
              const managerMsg =
                managerError instanceof Error ? managerError.message : String(managerError);
              const uptimeMsg =
                uptimeError instanceof Error ? uptimeError.message : String(uptimeError);
              throw new Error(`logged out but input time unreadable: ${managerMsg}; ${uptimeMsg}`, {
                cause: uptimeError,
              });
            }
          }
        } else {
          secondsSinceInput = secs;
        }
      } else {
        const owner = await macosConsoleOwner();
        if (owner === "root") {
          loggedOut = true;
        } else {
          secondsSinceInput = await macosSecondsSinceInput();
        }
      }
      if (loggedOut) {
        if (platform === "linux" && loggedOutSecs === null) {
          throw new Error("logged out but input time unreadable");
        }
        secondsSinceInput = loggedOutSecs ?? (await macosHidIdle());
      }
    } catch (e) {
      userActivityUnknown = true;
      userActivityCause = e instanceof Error ? e.message : String(e);
      secondsSinceInput = 0;
    }
  }

  if (facts.acPower === undefined || facts.batteryPercent === undefined) {
    try {
      const p = platformOrThrow() === "linux" ? linuxPower(sysfsRoot) : await macosPower();
      if (facts.acPower === undefined) acPower = p.acPower;
      if (facts.batteryPercent === undefined) batteryPercent = p.batteryPercent;
    } catch (e) {
      powerUnknown = true;
      powerCause = e instanceof Error ? e.message : String(e);
      if (facts.acPower === undefined) acPower = false;
    }
  }

  if (facts.memoryTotalMb === undefined || facts.memoryFreeMb === undefined) {
    const mem = platformOrThrow() === "linux" ? linuxMemory() : macosMemory();
    if (facts.memoryTotalMb === undefined) memoryTotalMb = mem.totalMb;
    if (facts.memoryFreeMb === undefined) memoryFreeMb = mem.freeMb;
  }

  if (facts.cpuCores === undefined || facts.cpuLoad1m === undefined) {
    const cpu = platformOrThrow() === "linux" ? linuxCpu() : await macosCpu();
    if (facts.cpuCores === undefined) cpuCores = cpu.cores;
    if (facts.cpuLoad1m === undefined) cpuLoad1m = cpu.load1m;
  }

  if (
    facts.gpuPresent === undefined ||
    facts.gpuName === undefined ||
    facts.gpuFreeMb === undefined
  ) {
    const gpu = platformOrThrow() === "linux" ? await linuxGpu(sysfsRoot) : await macosGpu();
    if (facts.gpuPresent === undefined) gpuPresent = gpu.present;
    if (facts.gpuName === undefined) gpuName = gpu.name;
    if (facts.gpuFreeMb === undefined) gpuFreeMb = gpu.freeMb;
  }

  if (facts.localModelsReachable === undefined || facts.localModels === undefined) {
    const lm = await queryLocalModels(cfg.localModelsBaseUrl, cfg.localModelsTimeoutMs);
    if (facts.localModelsReachable === undefined) localModelsReachable = lm.reachable;
    if (facts.localModels === undefined) localModelsList = lm.models;
  }

  const { idle, reason } = deriveIdle(
    secondsSinceInput,
    acPower,
    batteryPercent,
    insideWindowBool,
    cfg.idleMinutes,
    cfg.batteryThreshold,
    userActivityUnknown,
    userActivityCause,
    powerUnknown,
    powerCause,
    loggedOut,
  );

  const output = {
    schemaVersion: "v1" as const,
    hostAlias,
    timestamp,
    idle,
    idleReason: reason,
    secondsSinceInput,
    acPower,
    batteryPercent,
    cpu: { cores: cpuCores, load1m: cpuLoad1m },
    memory: { totalMb: memoryTotalMb, freeMb: memoryFreeMb },
    gpu: { present: gpuPresent, name: gpuName, freeMb: gpuFreeMb },
    localModels: { reachable: localModelsReachable, models: localModelsList },
    policy: {
      allowedWindow: { start: windowStart, end: windowEnd },
      insideWindow: insideWindowBool,
      maxConcurrentAgents: cfg.policy.maxConcurrentAgents,
    },
  };

  if (!isHostCapacity(output)) {
    throw new Error(
      `probe output violates host-capacity contract: ${JSON.stringify(contractErrors("host-capacity", output))}`,
    );
  }

  console.log(JSON.stringify(output));
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}

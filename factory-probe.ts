#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { hostname as osHostname, cpus, totalmem, freemem } from "node:os";
import { contractErrors, isHostCapacity } from "./contracts/v1/validate.js";

type ProbeConfig = {
  idleMinutes: number;
  batteryThreshold: number;
  localModelsBaseUrl: string;
  localModelsTimeoutMs: number;
  policy: {
    allowedWindowStart: string;
    allowedWindowEnd: string;
    maxConcurrentAgents: number;
  };
};

type HostMap = Record<string, string>;

type Facts = Partial<{
  secondsSinceInput: number;
  // Simulates a failed user-activity reader: the probe reports activity as
  // unknown (never idle) with this cause instead of reading live input state.
  userActivityError: string;
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

function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    throw new Error(`parse error in ${path}`);
  }
}

function loadConfig(): ProbeConfig {
  return readJson<ProbeConfig>("config/probe.json");
}

function loadHostAlias(hostnameVal: string): string {
  const hostsRaw = readJson<HostMap>("config/hosts.json");
  const alias = (hostsRaw as Record<string, unknown>)[hostnameVal];
  if (typeof alias !== "string") {
    throw new Error(`host ${hostnameVal} not in config/hosts.json`);
  }
  return alias;
}

function parseMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function insideWindow(now: Date, start: string, end: string): boolean {
  const nowM = now.getHours() * 60 + now.getMinutes();
  const startM = parseMinutes(start);
  const endM = parseMinutes(end);
  if (startM <= endM) {
    return nowM >= startM && nowM < endM;
  }
  return nowM >= startM || nowM < endM;
}

function readFileIfExists(p: string): string | null {
  try {
    if (existsSync(p)) return readFileSync(p, "utf-8").trim();
  } catch {
    // ignore
  }
  return null;
}

function linuxPower(): { acPower: boolean; batteryPercent: number | null } {
  const base = "/sys/class/power_supply";
  if (!existsSync(base)) {
    return { acPower: true, batteryPercent: null };
  }
  let acPower = false;
  let batteryPercent: number | null = null;
  let hasMains = false;
  let hasBattery = false;
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    throw new Error("power unknown: cannot read power_supply");
  }
  for (const entry of entries) {
    const typePath = `${base}/${entry}/type`;
    const type = readFileIfExists(typePath);
    if (!type) continue;
    if (type === "Mains") {
      hasMains = true;
      const online = readFileIfExists(`${base}/${entry}/online`);
      if (online === "1") acPower = true;
    }
    if (type === "Battery") {
      hasBattery = true;
      const cap = readFileIfExists(`${base}/${entry}/capacity`);
      if (cap) {
        const n = Number(cap);
        if (!Number.isNaN(n)) batteryPercent = n;
      }
    }
  }
  if (!hasMains && !hasBattery) {
    return { acPower: true, batteryPercent: null };
  }
  if (hasBattery && !hasMains) {
    throw new Error("power unknown: battery present without mains");
  }
  return { acPower, batteryPercent };
}

function linuxMemory(): { totalMb: number; freeMb: number } {
  const txt = readFileIfExists("/proc/meminfo");
  if (!txt) throw new Error("meminfo missing");
  const total = /MemTotal:\s+(\d+)/.exec(txt)?.[1];
  const avail = /MemAvailable:\s+(\d+)/.exec(txt)?.[1] ?? /MemFree:\s+(\d+)/.exec(txt)?.[1];
  if (!total || !avail) throw new Error("meminfo parse");
  const totalKb = Number(total);
  const availKb = Number(avail);
  return { totalMb: Math.round(totalKb / 1024), freeMb: Math.round(availKb / 1024) };
}

function linuxCpu(): { cores: number; load1m: number } {
  const cores = cpus().length;
  const txt = readFileIfExists("/proc/loadavg");
  let load1m = 0;
  if (txt) {
    const m = /([\d.]+)\s/.exec(txt);
    if (m) load1m = Number(m[1]);
  }
  return { cores, load1m };
}

async function showSessionProps(
  id: string,
  names: readonly string[],
): Promise<Map<string, string>> {
  const args: string[] = ["show-session", id];
  for (const name of names) args.push("-p", name);
  const showProc = Bun.spawn(["loginctl", ...args], { stdout: "pipe" });
  const out = await new Response(showProc.stdout).text();
  const props = new Map<string, string>();
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return props;
}

async function linuxSecondsSinceInput(): Promise<number> {
  const whoamiProc = Bun.spawn(["whoami"], { stdout: "pipe" });
  const user = (await new Response(whoamiProc.stdout).text()).trim();
  const listProc = Bun.spawn(["loginctl", "list-sessions", "--no-legend"], { stdout: "pipe" });
  const listOut = await new Response(listProc.stdout).text();
  const ownSessionIds: string[] = [];
  for (const line of listOut.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const id = parts[0];
    if (parts.length >= 3 && parts[2] === user && id) {
      ownSessionIds.push(id);
    }
  }
  if (ownSessionIds.length === 0) throw new Error("no session for user");
  // Prefer the active graphical session: Active=yes on a seat with an X11 or
  // Wayland type. A session without a seat (manager, ssh) must never decide
  // idleness for a user who is active on the graphical session.
  const graphicalSessionIds: string[] = [];
  for (const id of ownSessionIds) {
    const props = await showSessionProps(id, ["Active", "Type", "Seat", "Remote"]);
    const seat = props.get("Seat") ?? "";
    const sessionType = props.get("Type") ?? "";
    if (
      props.get("Active") === "yes" &&
      seat !== "" &&
      (sessionType === "x11" || sessionType === "wayland") &&
      props.get("Remote") !== "yes"
    ) {
      graphicalSessionIds.push(id);
    }
  }
  if (graphicalSessionIds.length === 0) throw new Error("no active graphical session for user");
  // Any graphical session with recent input means the user is active; only
  // when all of them are idle does the most recent idle timestamp decide.
  let minSecs: number | null = null;
  for (const id of graphicalSessionIds) {
    const props = await showSessionProps(id, ["IdleHint", "IdleSinceHint"]);
    if (props.get("IdleHint") !== "yes") return 0;
    const sinceRaw = props.get("IdleSinceHint");
    if (sinceRaw === undefined || sinceRaw === "") throw new Error("IdleSinceHint missing");
    const idleSinceUs = Number(sinceRaw);
    if (!Number.isFinite(idleSinceUs) || idleSinceUs <= 0) return 0;
    const secs = Math.max(0, Math.floor((Date.now() - idleSinceUs / 1000) / 1000));
    minSecs = minSecs === null ? secs : Math.min(minSecs, secs);
  }
  if (minSecs === null) throw new Error("IdleSinceHint missing");
  return minSecs;
}

async function macosPower(): Promise<{ acPower: boolean; batteryPercent: number | null }> {
  const proc = Bun.spawn(["pmset", "-g", "batt"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  const ac = /AC Power/.test(out);
  const m = /(\d+)%/.exec(out);
  const batteryPercent = m ? Number(m[1]) : null;
  return { acPower: ac, batteryPercent };
}

async function macosSecondsSinceInput(): Promise<number> {
  const proc = Bun.spawn(["ioreg", "-c", "IOHIDSystem"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  const m = /"HIDIdleTime"\s+=\s+(\d+)/.exec(out);
  if (!m || !m[1]) throw new Error("HIDIdleTime missing");
  const ns = BigInt(m[1]);
  const secs = Number(ns / 1000000000n);
  return secs;
}

async function macosCpu(): Promise<{ cores: number; load1m: number }> {
  const cores = cpus().length;
  try {
    const proc = Bun.spawn(["sysctl", "-n", "vm.loadavg"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    const m = /{(.+?)}/.exec(out);
    if (m && m[1]) {
      const parts = m[1]
        .trim()
        .split(/\s+/)
        .map((s) => Number(s));
      return { cores, load1m: parts[0] ?? 0 };
    }
  } catch {
    // fallback
  }
  return { cores, load1m: 0 };
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
  try {
    const controller = new AbortController();
    const t = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { reachable: false, models: [] };
    const data = (await res.json()) as { data?: { id: string }[] };
    const models = (data.data ?? []).map((d) => d.id);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
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
): { idle: boolean; reason: string } {
  if (userActivityUnknown) {
    return { idle: false, reason: `user activity unknown: ${userActivityCause || "unavailable"}` };
  }
  if (powerUnknown) {
    return { idle: false, reason: `power unknown: ${powerCause || "unavailable"}` };
  }
  const idleMinutesSec = idleMinutes * 60;
  const inputOk = secondsSinceInput >= idleMinutesSec || !insideWindow;
  const powerOk = acPower;
  const batteryOk = batteryPercent === null || batteryPercent >= batteryThreshold;

  if (!batteryOk) {
    return {
      idle: false,
      reason: `battery at ${String(batteryPercent)} percent, below the ${String(batteryThreshold)} percent floor`,
    };
  }
  if (!powerOk) {
    return { idle: false, reason: "not on AC power" };
  }
  if (!inputOk) {
    return { idle: false, reason: `user input ${String(secondsSinceInput)} seconds ago` };
  }
  if (!insideWindow) {
    return { idle: true, reason: "outside working hours, on AC power" };
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
    if (!existsSync(factsPath)) throw new Error(`facts file not found: ${factsPath}`);
    facts = readJson<Facts>(factsPath);
  } else if (scenario) {
    const mapped = `config/scenarios/${scenario}.json`;
    if (!existsSync(mapped)) throw new Error(`scenario not found: ${scenario}`);
    facts = readJson<Facts>(mapped);
  }

  const cfg = loadConfig();
  const hostAlias = facts.hostAlias ?? loadHostAlias(osHostname());
  const now = new Date();
  const timestamp = facts.timestamp ?? now.toISOString();

  const insideWindowBool =
    facts.policyAllowedWindowStart && facts.policyAllowedWindowEnd
      ? insideWindow(now, facts.policyAllowedWindowStart, facts.policyAllowedWindowEnd)
      : insideWindow(now, cfg.policy.allowedWindowStart, cfg.policy.allowedWindowEnd);

  const platform = process.platform;

  let secondsSinceInput = facts.secondsSinceInput ?? 0;
  let acPower = facts.acPower ?? true;
  let batteryPercent: number | null = facts.batteryPercent ?? null;
  let cpuCores = facts.cpuCores ?? cpus().length;
  let cpuLoad1m = facts.cpuLoad1m ?? 0;
  let memoryTotalMb = facts.memoryTotalMb ?? 0;
  let memoryFreeMb = facts.memoryFreeMb ?? 0;
  const gpuPresent = facts.gpuPresent ?? false;
  const gpuName = facts.gpuName ?? null;
  const gpuFreeMb = facts.gpuFreeMb ?? null;
  let localModelsReachable = facts.localModelsReachable ?? false;
  let localModelsList = facts.localModels ?? [];

  let userActivityUnknown = typeof facts.userActivityError === "string";
  let userActivityCause = facts.userActivityError ?? "";
  let powerUnknown = false;
  let powerCause = "";

  // Facts override the live readers field by field. Any field left unset
  // falls back to the live reader, so a partial --facts file can never
  // silently emit schema-invalid defaults. A live value needed on an
  // unsupported platform fails fast.
  function platformOrThrow(): "linux" | "darwin" {
    if (platform === "linux" || platform === "darwin") return platform;
    throw new Error("unsupported platform");
  }

  if (userActivityUnknown) {
    secondsSinceInput = 0;
  } else if (facts.secondsSinceInput === undefined) {
    try {
      secondsSinceInput =
        platformOrThrow() === "linux"
          ? await linuxSecondsSinceInput()
          : await macosSecondsSinceInput();
    } catch (e) {
      userActivityUnknown = true;
      userActivityCause = String(e);
      secondsSinceInput = 0;
    }
  }

  if (facts.acPower === undefined || facts.batteryPercent === undefined) {
    try {
      const p = platformOrThrow() === "linux" ? linuxPower() : await macosPower();
      if (facts.acPower === undefined) acPower = p.acPower;
      if (facts.batteryPercent === undefined) batteryPercent = p.batteryPercent;
    } catch (e) {
      powerUnknown = true;
      powerCause = String(e);
    }
  }

  if (facts.memoryTotalMb === undefined) {
    const mem = platformOrThrow() === "linux" ? linuxMemory() : macosMemory();
    memoryTotalMb = mem.totalMb;
    memoryFreeMb = mem.freeMb;
  }

  if (facts.cpuCores === undefined) {
    const cpu = platformOrThrow() === "linux" ? linuxCpu() : await macosCpu();
    cpuCores = cpu.cores;
    cpuLoad1m = cpu.load1m;
  }

  if (localModelsList.length === 0 && !facts.localModelsReachable) {
    const lm = await queryLocalModels(cfg.localModelsBaseUrl, cfg.localModelsTimeoutMs);
    localModelsReachable = lm.reachable;
    localModelsList = lm.models;
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
      allowedWindow: { start: cfg.policy.allowedWindowStart, end: cfg.policy.allowedWindowEnd },
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

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

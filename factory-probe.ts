#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unnecessary-type-parameters */

import { existsSync, readFileSync } from "node:fs";
import { hostname as osHostname, cpus, totalmem, freemem } from "node:os";

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

function readJson<T>(path: string): T | null {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8")) as T;
    }
  } catch {
    // ignore
  }
  return null;
}

function loadConfig(): ProbeConfig {
  const raw = readJson<ProbeConfig>("config/probe.json");
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config/probe.json missing");
  }
  return raw;
}

function loadHostAlias(hostnameVal: string): string {
  const hostsRaw =
    readJson<HostMap>("config/hosts.json") ?? readJson<HostMap>("config/hosts.example.json");
  if (hostsRaw && typeof hostsRaw === "object") {
    const alias = (hostsRaw as Record<string, unknown>)[hostnameVal];
    if (typeof alias === "string") return alias;
    const values = Object.values(hostsRaw).filter((v) => typeof v === "string") as string[];
    if (values.length > 0) return values[0] ?? "desktop";
  }
  return "desktop";
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
  const acOnline =
    readFileIfExists("/sys/class/power_supply/AC/online") ??
    readFileIfExists("/sys/class/power_supply/ACAD/online");
  const acPower = acOnline === "1";
  const batCap =
    readFileIfExists("/sys/class/power_supply/BAT0/capacity") ??
    readFileIfExists("/sys/class/power_supply/BAT1/capacity");
  let batteryPercent: number | null = null;
  if (batCap) {
    const n = Number(batCap);
    if (!Number.isNaN(n)) batteryPercent = n;
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

async function linuxSecondsSinceInput(): Promise<number> {
  try {
    const proc = Bun.spawn(["loginctl", "show-session", "-p", "IdleHint"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    const m = /IdleHint=(true|false)/.exec(out);
    if (m) {
      return m[1] === "true" ? 3600 : 0;
    }
  } catch {
    // fallback
  }
  return 3600;
}

async function macosPower(): Promise<{ acPower: boolean; batteryPercent: number | null }> {
  try {
    const proc = Bun.spawn(["pmset", "-g", "batt"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    const ac = /AC Power/.test(out);
    const m = /(\d+)%/.exec(out);
    const batteryPercent = m ? Number(m[1]) : null;
    return { acPower: ac, batteryPercent };
  } catch {
    return { acPower: true, batteryPercent: null };
  }
}

async function macosSecondsSinceInput(): Promise<number> {
  try {
    const proc = Bun.spawn(["ioreg", "-c", "IOHIDSystem"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    const m = /"HIDIdleTime"\s+=\s+(\d+)/.exec(out);
    if (m) {
      const ms = Number(m[1]);
      return Math.floor(ms / 1000);
    }
  } catch {
    // fallback
  }
  return 3600;
}

async function macosCpu(): Promise<{ cores: number; load1m: number }> {
  const cores = cpus().length;
  try {
    const proc = Bun.spawn(["sysctl", "-n", "vm.loadavg"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    const m = /{(.+?)}/.exec(out);
    if (m && m[1]) {
      const parts = m[1].split(",").map((s) => Number(s.trim()));
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
): { idle: boolean; reason: string } {
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
    const raw = readJson<Facts>(factsPath);
    if (typeof raw === "object" && raw !== null) facts = raw;
  } else if (scenario) {
    const mapped = `config/scenarios/${scenario}.json`;
    if (existsSync(mapped)) {
      const raw = readJson<Facts>(mapped);
      if (typeof raw === "object" && raw !== null) facts = raw;
    }
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

  if (facts.secondsSinceInput === undefined) {
    if (platform === "linux") {
      secondsSinceInput = await linuxSecondsSinceInput();
      const p = linuxPower();
      if (facts.acPower === undefined) acPower = p.acPower;
      if (facts.batteryPercent === undefined) batteryPercent = p.batteryPercent;
      if (!facts.memoryTotalMb) {
        const mem = linuxMemory();
        memoryTotalMb = mem.totalMb;
        memoryFreeMb = mem.freeMb;
      }
      if (!facts.cpuCores) {
        const cpu = linuxCpu();
        cpuCores = cpu.cores;
        cpuLoad1m = cpu.load1m;
      }
    } else if (platform === "darwin") {
      secondsSinceInput = await macosSecondsSinceInput();
      const p = await macosPower();
      if (facts.acPower === undefined) acPower = p.acPower;
      if (facts.batteryPercent === undefined) batteryPercent = p.batteryPercent;
      if (!facts.memoryTotalMb) {
        const mem = macosMemory();
        memoryTotalMb = mem.totalMb;
        memoryFreeMb = mem.freeMb;
      }
      if (!facts.cpuCores) {
        const cpu = await macosCpu();
        cpuCores = cpu.cores;
        cpuLoad1m = cpu.load1m;
      }
    } else {
      secondsSinceInput = 3600;
    }
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

  console.log(JSON.stringify(output));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

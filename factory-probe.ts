#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname as osHostname, cpus, totalmem, freemem } from "node:os";
import { contractErrors, isHostCapacity } from "./contracts/v1/validate.js";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const configPath = (...parts: string[]): string => join(repoRoot, "config", ...parts);

type ProbeConfig = {
  idleMinutes: number;
  batteryThreshold: number;
  localModelsBaseUrl: string;
  localModelsTimeoutMs: number;
  sysfsRoot: string;
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
  // Simulates a host where the login query ran and found no local session
  // of class user (remote sessions excluded): idle when on AC, battery above
  // threshold, inside the window. A failed query is userActivityError instead
  // (never idle). Combine with an explicit secondsSinceInput fact for a
  // deterministic logged-out value (otherwise the live readers run); the
  // manager hint failure fallback is simulated with the managerHintFailed
  // fact, which uses /proc/uptime instead of the hint.
  noLocalUserSession: boolean;
  // Fixture override for every sysfs path (power_supply, drm): a scenario
  // may point it at a committed fixture tree under tests/fixtures/sysfs,
  // resolved against the repository root.
  sysfsRoot: string;
  managerHintFailed: boolean;
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
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`${path}: ${code}`, { cause: e });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`${path}: parse error`, { cause: e });
  }
}

function loadConfig(): ProbeConfig {
  return readJson<ProbeConfig>(configPath("probe.json"));
}

function loadHostAlias(hostnameVal: string): string {
  const hostsRaw = readJson<HostMap>(configPath("hosts.json"));
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
  if (startM === endM) return true;
  if (startM <= endM) {
    return nowM >= startM && nowM < endM;
  }
  return nowM >= startM || nowM < endM;
}

function readFileIfExists(p: string): string | null {
  try {
    lstatSync(p);
  } catch (e) {
    // Only a missing file means the attribute does not exist; any other
    // stat error is reported so callers can fail with the cause.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`${p}: ${(e as NodeJS.ErrnoException).code ?? "unknown"}`, { cause: e });
    }
    return null;
  }
  try {
    return readFileSync(p, "utf-8").trim();
  } catch (e) {
    throw new Error(`${p}: ${(e as NodeJS.ErrnoException).code ?? "unknown"}`, { cause: e });
  }
}

function readRequired(path: string, what: string): string {
  const value = readFileIfExists(path);
  if (value === null || value === "") throw new Error(`cannot read ${what}`);
  return value;
}

function linuxPower(sysfsRoot: string): { acPower: boolean; batteryPercent: number | null } {
  const base = `${sysfsRoot}/class/power_supply`;
  let acPower = false;
  let batteryPercent: number | null = null;
  let hasMains = false;
  let hasBattery = false;
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch (e) {
    // A missing power_supply class directory is the desktop default; any
    // other error means power unknown.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { acPower: true, batteryPercent: null };
    }
    throw new Error(`${base}: ${(e as NodeJS.ErrnoException).code ?? "unknown"}`, { cause: e });
  }
  for (const entry of entries) {
    const type = readRequired(`${base}/${entry}/type`, `type of ${entry}`);
    if (type === "Mains") {
      const scope = readFileIfExists(`${base}/${entry}/scope`) ?? "System";
      if (scope === "Device") continue;
      hasMains = true;
      const online = readRequired(`${base}/${entry}/online`, `online of ${entry}`);
      if (online === "1") acPower = true;
    }
    if (type === "Battery") {
      const scope = readFileIfExists(`${base}/${entry}/scope`) ?? "System";
      if (scope === "Device") continue;
      hasBattery = true;
      const cap = readRequired(`${base}/${entry}/capacity`, `capacity of ${entry}`);
      const n = Number(cap);
      if (!Number.isFinite(n)) {
        throw new Error(`power unknown: cannot read capacity of ${entry}`);
      }
      batteryPercent = batteryPercent === null ? n : Math.min(batteryPercent, n);
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

async function linuxGpu(sysfsRoot: string): Promise<{
  present: boolean;
  name: string | null;
  freeMb: number | null;
}> {
  const base = `${sysfsRoot}/class/drm`;
  try {
    let entries: string[];
    try {
      entries = readdirSync(base).filter((e) => /^card\d+$/.test(e));
    } catch (e) {
      // A missing DRM class directory means the kernel loaded no DRM
      // driver, so there is no DRM GPU. Other read errors fail the probe.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const nvidia = await nvidiaGpu();
      if (nvidia) return nvidia;
      return { present: false, name: null, freeMb: null };
    }
    let best: { present: boolean; name: string | null; freeMb: number | null } | null = null;
    for (const card of entries) {
      const deviceDir = `${base}/${card}/device`;
      const vendor = readFileIfExists(`${deviceDir}/vendor`);
      if (!vendor) continue;
      const name = readFileIfExists(`${deviceDir}/uevent`)
        ?.split("\n")
        .find((l) => l.startsWith("DRIVER="))
        ?.slice("DRIVER=".length);
      const totalKb = readFileIfExists(`${deviceDir}/mem_info_vram_total`);
      const usedKb = readFileIfExists(`${deviceDir}/mem_info_vram_used`);
      let freeMb: number | null = null;
      if (totalKb !== null && usedKb !== null) {
        const total = Number(totalKb);
        const used = Number(usedKb);
        if (Number.isFinite(total) && Number.isFinite(used)) {
          freeMb = Math.max(0, Math.round((total - used) / 1024 / 1024));
        }
      }
      best = { present: true, name: name || null, freeMb };
    }
    const nvidia = await nvidiaGpu();
    if (nvidia) return nvidia;
    if (best) return best;
    return { present: false, name: null, freeMb: null };
  } catch (e) {
    throw new Error(`gpu unknown: ${String(e)}`, { cause: e });
  }
}

async function nvidiaGpu(): Promise<{
  present: boolean;
  name: string | null;
  freeMb: number | null;
} | null> {
  try {
    const proc = Bun.spawn(
      ["nvidia-smi", "--query-gpu=name,memory.free", "--format=csv,noheader,nounits"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (proc.exitCode !== 0 || !out) return null;
    const first = out
      .split("\n")[0]
      ?.split(",")
      .map((s) => s.trim());
    if (!first || !first[0]) return null;
    const free = first[1] ? Number(first[1]) : NaN;
    return {
      present: true,
      name: first[0],
      freeMb: Number.isFinite(free) ? free : null,
    };
  } catch {
    return null;
  }
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
    throw new Error(`gpu unknown: ${String(e)}`, { cause: e });
  }
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
  if (!txt) throw new Error("loadavg missing");
  const m = /([\d.]+)\s/.exec(txt);
  if (!m || !m[1]) throw new Error("loadavg parse");
  const load1m = Number(m[1]);
  if (!Number.isFinite(load1m)) throw new Error("loadavg parse");
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
  await showProc.exited;
  if (showProc.exitCode !== 0) throw new Error(`loginctl show-session ${id} failed`);
  const props = new Map<string, string>();
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return props;
}

async function linuxSecondsSinceInput(): Promise<number> {
  const listProc = Bun.spawn(["loginctl", "list-sessions", "--no-legend"], { stdout: "pipe" });
  const listOut = await new Response(listProc.stdout).text();
  await listProc.exited;
  if (listProc.exitCode !== 0) throw new Error("loginctl list-sessions failed");
  const sessionIds: string[] = [];
  for (const line of listOut.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const id = parts[0];
    if (parts.length >= 2 && id) {
      sessionIds.push(id);
    }
  }
  if (sessionIds.length === 0) return Number.NaN;
  // Somebody is logged in when at least one session has a local class
  // matching ^user(-|$) and is not remote. Every Type counts, with or
  // without a seat, active or not; only remote sessions are ignored. NaN
  // means the query ran and found no such session. A session whose Class
  // or Remote line is missing or empty cannot be parsed, which throws
  // (unknown, never idle). When somebody is logged in but has no active
  // graphical session, activity is unknown (never idle).
  const loggedInIds: string[] = [];
  for (const id of sessionIds) {
    const props = await showSessionProps(id, ["Class", "Remote"]);
    const cls = props.get("Class");
    const remote = props.get("Remote");
    if (cls === undefined || cls === "" || remote === undefined || remote === "") {
      throw new Error(`loginctl session ${id} has no Class or Remote`);
    }
    if (/^user(-|$)/.test(cls) && remote !== "yes") {
      loggedInIds.push(id);
    }
  }
  if (loggedInIds.length === 0) return Number.NaN;
  const graphicalSessionIds: string[] = [];
  for (const id of loggedInIds) {
    const props = await showSessionProps(id, ["Active", "Type", "Seat"]);
    const seat = props.get("Seat") ?? "";
    const sessionType = props.get("Type") ?? "";
    if (
      props.get("Active") === "yes" &&
      seat !== "" &&
      (sessionType === "x11" || sessionType === "wayland")
    ) {
      graphicalSessionIds.push(id);
    }
  }
  if (graphicalSessionIds.length === 0)
    throw new Error("logged in without an active graphical session");
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

async function linuxManagerIdleSecs(): Promise<number> {
  const proc = Bun.spawn(["loginctl", "show-session", "-p", "IdleHint", "-p", "IdleSinceHint"], {
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error("loginctl show-session manager failed");
  const props = new Map<string, string>();
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const sinceRaw = props.get("IdleSinceHint");
  const sinceUs = sinceRaw === undefined || sinceRaw === "" ? NaN : Number(sinceRaw);
  if (!Number.isFinite(sinceUs) || sinceUs <= 0) {
    throw new Error(`manager IdleSinceHint not above zero: ${sinceRaw ?? "missing"}`);
  }
  return Math.max(0, Math.floor((Date.now() - sinceUs / 1000) / 1000));
}

function linuxUptimeSecs(): number {
  const first = readFileIfExists("/proc/uptime")?.split(/\s+/)[0];
  const upSecs = first ? Math.floor(Number(first)) : NaN;
  if (!Number.isFinite(upSecs)) throw new Error("/proc/uptime unreadable");
  return upSecs;
}

async function macosPower(): Promise<{ acPower: boolean; batteryPercent: number | null }> {
  const proc = Bun.spawn(["pmset", "-g", "batt"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  const ac = /AC Power/.test(out);
  const m = /(\d+)%/.exec(out);
  const batteryPercent = m ? Number(m[1]) : null;
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
    throw new Error(`activity unknown after logout: ${String(e)}`, { cause: e });
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

  if (!batteryOk) {
    return {
      idle: false,
      reason: `battery at ${String(batteryPercent)} percent, at or below the ${String(batteryThreshold)} percent floor`,
    };
  }
  if (!acPower) {
    return { idle: false, reason: "not on AC power" };
  }
  if (loggedOut) {
    if (!insideWindow) {
      return { idle: false, reason: "no user logged in, outside working hours" };
    }
    return { idle: true, reason: "no user logged in, on AC power" };
  }
  const inputOk = secondsSinceInput >= idleMinutesSec || !insideWindow;

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
    facts = readJson<Facts>(factsPath);
  } else if (scenario) {
    facts = readJson<Facts>(configPath("scenarios", `${scenario}.json`));
  }

  const cfg = loadConfig();
  const sysfsRoot = facts.sysfsRoot ? join(repoRoot, facts.sysfsRoot) : cfg.sysfsRoot;
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
  let loggedOut = facts.noLocalUserSession === true;
  let loggedOutSecs: number | null = null;
  const managerHintFailed = facts.managerHintFailed === true;
  if (managerHintFailed && !loggedOut) {
    throw new Error("managerHintFailed needs noLocalUserSession");
  }
  let powerUnknown = false;
  let powerCause = "";

  // Facts override the live readers member by member: a member left
  // undefined falls back to the live reader, including inside the grouped
  // gpu and localModels objects. An explicitly set member (even false or an
  // empty list) always wins over the reader; that includes an explicit
  // secondsSinceInput fact next to the logged-out facts. managerHintFailed
  // is valid only together with noLocalUserSession (otherwise the probe
  // exits 1); together they force the manager-hint/uptime path instead of
  // the live session reader. A live value needed on an unsupported
  // platform fails fast.
  function platformOrThrow(): "linux" | "darwin" {
    if (platform === "linux" || platform === "darwin") return platform;
    throw new Error("unsupported platform");
  }

  if (userActivityUnknown) {
    secondsSinceInput = 0;
  } else if (facts.secondsSinceInput === undefined) {
    try {
      if (platformOrThrow() === "linux") {
        const secs = managerHintFailed ? Number.NaN : await linuxSecondsSinceInput();
        if (Number.isNaN(secs)) {
          loggedOut = true;
          try {
            if (managerHintFailed) throw new Error("simulated: manager hint query failed");
            loggedOutSecs = await linuxManagerIdleSecs();
          } catch (managerError) {
            try {
              loggedOutSecs = linuxUptimeSecs();
            } catch (uptimeError) {
              throw new Error(
                `logged out but input time unreadable: ${String(managerError)}; ${String(uptimeError)}`,
                { cause: uptimeError },
              );
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
      userActivityCause = String(e);
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
      powerCause = String(e);
      acPower = false;
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

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

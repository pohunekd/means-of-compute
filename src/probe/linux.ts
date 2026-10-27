import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { cpus } from "node:os";

export function readFileIfExists(p: string): string | null {
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

export function readRequired(path: string, what: string): string {
  const value = readFileIfExists(path);
  if (value === null || value === "") throw new Error(`cannot read ${what}`);
  return value;
}

export function linuxPower(sysfsRoot: string): { acPower: boolean; batteryPercent: number | null } {
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
        throw new Error(`cannot read capacity of ${entry}: not a number`);
      }
      batteryPercent = batteryPercent === null ? n : Math.min(batteryPercent, n);
    }
  }
  if (!hasMains && !hasBattery) {
    return { acPower: true, batteryPercent: null };
  }
  if (hasBattery && !hasMains) {
    throw new Error("battery present without mains");
  }
  return { acPower, batteryPercent };
}

export async function linuxGpu(sysfsRoot: string): Promise<{
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
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`gpu unknown: ${msg}`, { cause: e });
  }
}

export async function nvidiaGpu(): Promise<{
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

export function linuxMemory(): { totalMb: number; freeMb: number } {
  const txt = readFileIfExists("/proc/meminfo");
  if (!txt) throw new Error("meminfo missing");
  const total = /MemTotal:\s+(\d+)/.exec(txt)?.[1];
  const avail = /MemAvailable:\s+(\d+)/.exec(txt)?.[1] ?? /MemFree:\s+(\d+)/.exec(txt)?.[1];
  if (!total || !avail) throw new Error("meminfo parse");
  const totalKb = Number(total);
  const availKb = Number(avail);
  return { totalMb: Math.round(totalKb / 1024), freeMb: Math.round(availKb / 1024) };
}

export function linuxCpu(): { cores: number; load1m: number } {
  const cores = cpus().length;
  const txt = readFileIfExists("/proc/loadavg");
  if (!txt) throw new Error("loadavg missing");
  const m = /([\d.]+)\s/.exec(txt);
  if (!m || !m[1]) throw new Error("loadavg parse");
  const load1m = Number(m[1]);
  if (!Number.isFinite(load1m)) throw new Error("loadavg parse");
  return { cores, load1m };
}

export async function showSessionProps(
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

export async function linuxSecondsSinceInput(nowMs: number): Promise<number> {
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
    const hint = props.get("IdleHint");
    if (hint === "no") return 0;
    if (hint !== "yes") throw new Error(`loginctl session ${id} has no IdleHint`);
    const sinceRaw = props.get("IdleSinceHint");
    const idleSinceUs = sinceRaw === undefined || sinceRaw === "" ? NaN : Number(sinceRaw);
    if (!Number.isFinite(idleSinceUs) || idleSinceUs <= 0) {
      throw new Error(`loginctl session ${id} has no numeric IdleSinceHint`);
    }
    const secs = Math.max(0, Math.floor((nowMs - idleSinceUs / 1000) / 1000));
    minSecs = minSecs === null ? secs : Math.min(minSecs, secs);
  }
  if (minSecs === null) throw new Error("IdleSinceHint missing");
  return minSecs;
}

export async function linuxManagerIdleSecs(nowMs: number): Promise<number> {
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
  return Math.max(0, Math.floor((nowMs - sinceUs / 1000) / 1000));
}

export function linuxUptimeSecs(): number {
  const first = readFileIfExists("/proc/uptime")?.split(/\s+/)[0];
  const upSecs = first ? Math.floor(Number(first)) : NaN;
  if (!Number.isFinite(upSecs)) throw new Error("/proc/uptime unreadable");
  return upSecs;
}

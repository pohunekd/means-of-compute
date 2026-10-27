import { cpus, freemem, totalmem } from "node:os";

export async function macosGpu(): Promise<{
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

export async function macosPower(): Promise<{
  acPower: boolean;
  batteryPercent: number | null;
}> {
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

export async function macosConsoleOwner(): Promise<string> {
  const proc = Bun.spawn(["stat", "-f", "%Su", "/dev/console"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (proc.exitCode !== 0 || !out) throw new Error("console owner query failed");
  return out;
}

export async function macosSecondsSinceInput(): Promise<number> {
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

export async function macosHidIdle(): Promise<number> {
  try {
    return await macosSecondsSinceInput();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`activity unknown after logout: ${msg}`, { cause: e });
  }
}

export async function macosCpu(): Promise<{ cores: number; load1m: number }> {
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

export function macosMemory(): { totalMb: number; freeMb: number } {
  const total = Math.round(totalmem() / 1024 / 1024);
  const free = Math.round(freemem() / 1024 / 1024);
  return { totalMb: total, freeMb: free };
}

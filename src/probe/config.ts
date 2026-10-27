/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ProbeConfig = {
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

export function readJson<T>(path: string): T {
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

export function loadConfig(path: string): ProbeConfig {
  const raw = readJson<Record<string, unknown>>(path);
  const num = (key: string, min: number, max = Number.POSITIVE_INFINITY): number => {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(`config probe.json: invalid ${key}`);
    }
    return v;
  };
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string") throw new Error(`config probe.json: invalid ${key}`);
    return v;
  };
  const nonEmpty = (key: string): string => {
    const v = str(key);
    if (v === "") throw new Error(`config probe.json: invalid ${key}`);
    return v;
  };
  const policyRaw = raw["policy"];
  if (typeof policyRaw !== "object" || policyRaw === null) {
    throw new Error("config probe.json: invalid policy");
  }
  const policy = policyRaw as Record<string, unknown>;
  for (const key of ["allowedWindowStart", "allowedWindowEnd"]) {
    const v = policy[key];
    if (typeof v !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v)) {
      throw new Error(`config probe.json: invalid policy.${key}`);
    }
  }
  const maxAgents = policy["maxConcurrentAgents"];
  if (typeof maxAgents !== "number" || !Number.isInteger(maxAgents) || maxAgents < 1) {
    throw new Error("config probe.json: invalid policy.maxConcurrentAgents");
  }
  const sysfsRoot = nonEmpty("sysfsRoot");
  // The sysfs tree only exists on Linux; on other platforms the readers
  // never use this root, so it is not checked there.
  if (process.platform === "linux") {
    assertSysfsRoot(sysfsRoot, "config probe.json: invalid sysfsRoot");
  }
  return {
    idleMinutes: num("idleMinutes", 1),
    batteryThreshold: num("batteryThreshold", 0, 100),
    localModelsBaseUrl: str("localModelsBaseUrl"),
    localModelsTimeoutMs: num("localModelsTimeoutMs", 0),
    sysfsRoot,
    policy: {
      allowedWindowStart: policy["allowedWindowStart"] as string,
      allowedWindowEnd: policy["allowedWindowEnd"] as string,
      maxConcurrentAgents: maxAgents,
    },
  };
}

export function assertSysfsRoot(root: unknown, label: string): void {
  if (typeof root !== "string" || !root.startsWith("/")) {
    throw new Error(`${label}: ${String(root)}: not an absolute path`);
  }
  // A valid sysfs tree always has class/ (Linux hosts and the committed
  // fixtures alike); an existing directory without it is not sysfs.
  const classDir = `${root}/class`;
  try {
    if (!lstatSync(classDir).isDirectory()) {
      throw new Error(`${label}: ${root}: no class directory`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(`${label}:`)) throw e;
    throw new Error(`${label}: ${root}: ${(e as NodeJS.ErrnoException).code ?? "unknown"}`, {
      cause: e,
    });
  }
}

export function loadHostAlias(configDir: string, hostnameVal: string): string {
  const hostsPath = join(configDir, "hosts.json");
  const hostsRaw = readJson<HostMap>(hostsPath);
  const alias = (hostsRaw as Record<string, unknown>)[hostnameVal];
  if (typeof alias !== "string") {
    throw new Error(`host ${hostnameVal} not in ${hostsPath}`);
  }
  return alias;
}

const hostAliasPattern = /^[a-z][a-z0-9-]{0,31}$/;

export function loadHostFile(path: string): string {
  let raw: unknown;
  try {
    raw = readJson<unknown>(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`host file ${path}: ${code}`, { cause: e });
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 1 ||
    typeof (raw as Record<string, unknown>)["hostAlias"] !== "string" ||
    !hostAliasPattern.test((raw as Record<string, unknown>)["hostAlias"] as string)
  ) {
    throw new Error(`host file ${path}: invalid hostAlias`);
  }
  return (raw as { hostAlias: string }).hostAlias;
}

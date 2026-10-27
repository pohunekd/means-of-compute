import { dirname, join } from "node:path";
import { loadConfig, readJson } from "../probe/config.js";

export const hostStateTargets = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-arm64",
  "bun-darwin-x64",
] as const;

export type HostStateTarget = (typeof hostStateTargets)[number];

export type HostStatePackage = {
  readonly id: string;
  readonly version: string;
  readonly sourceDigest: string;
  readonly targets: readonly HostStateTarget[];
};

export type HostStateCollector = {
  readonly acceptedVersions: readonly string[];
  readonly pluginTimeoutMs: number;
  readonly transportMarginMs: number;
  readonly maxOutputBytes: number;
  readonly maxClockSkewMs: number;
};

export type HostStateConfig = {
  readonly package: HostStatePackage;
  readonly collector: HostStateCollector;
};

const packageIdPattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const sourceDigestPattern = /^sha256:[0-9a-f]{64}$/;

function fail(key: string): never {
  throw new Error(`config host-state.json: invalid ${key}`);
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function loadHostStateConfig(path: string): HostStateConfig {
  const raw = readJson<unknown>(path);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("package");
  }
  const root = raw as Record<string, unknown>;
  if (!("package" in root)) {
    fail("package");
  }
  if (!("collector" in root)) {
    fail("collector");
  }
  for (const key of Object.keys(root)) {
    if (key !== "package" && key !== "collector") {
      fail("package");
    }
  }
  const pkg = root["package"];
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    fail("package");
  }
  const fields = pkg as Record<string, unknown>;
  const expectedPackageKeys = ["id", "version", "sourceDigest", "targets"];
  for (const key of expectedPackageKeys) {
    if (!(key in fields)) {
      fail(`package.${key}`);
    }
  }
  for (const key of Object.keys(fields)) {
    if (!expectedPackageKeys.includes(key)) {
      fail(`package.${key}`);
    }
  }
  const id = fields["id"];
  if (typeof id !== "string" || !packageIdPattern.test(id)) {
    fail("package.id");
  }
  const version = fields["version"];
  if (typeof version !== "string" || !versionPattern.test(version)) {
    fail("package.version");
  }
  const sourceDigest = fields["sourceDigest"];
  if (typeof sourceDigest !== "string" || !sourceDigestPattern.test(sourceDigest)) {
    fail("package.sourceDigest");
  }
  const targets = fields["targets"];
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    new Set(targets).size !== targets.length ||
    !targets.every(
      (t): t is HostStateTarget =>
        typeof t === "string" && (hostStateTargets as readonly string[]).includes(t),
    )
  ) {
    fail("package.targets");
  }
  const collectorRaw = root["collector"];
  if (typeof collectorRaw !== "object" || collectorRaw === null || Array.isArray(collectorRaw)) {
    fail("collector");
  }
  const collectorFields = collectorRaw as Record<string, unknown>;
  const expectedCollectorKeys = [
    "acceptedVersions",
    "pluginTimeoutMs",
    "transportMarginMs",
    "maxOutputBytes",
    "maxClockSkewMs",
  ];
  for (const key of expectedCollectorKeys) {
    if (!(key in collectorFields)) {
      fail(`collector.${key}`);
    }
  }
  for (const key of Object.keys(collectorFields)) {
    if (!expectedCollectorKeys.includes(key)) {
      fail(`collector.${key}`);
    }
  }
  const acceptedVersions = collectorFields["acceptedVersions"];
  if (
    !Array.isArray(acceptedVersions) ||
    acceptedVersions.length === 0 ||
    new Set(acceptedVersions).size !== acceptedVersions.length ||
    !acceptedVersions.every((v): v is string => typeof v === "string" && versionPattern.test(v)) ||
    !acceptedVersions.includes(version)
  ) {
    fail("collector.acceptedVersions");
  }
  const pluginTimeoutMs = collectorFields["pluginTimeoutMs"];
  if (!integerInRange(pluginTimeoutMs, 1000, 60000)) {
    fail("collector.pluginTimeoutMs");
  }
  const probeConfig = loadConfig(join(dirname(path), "probe.json"));
  if (pluginTimeoutMs <= probeConfig.localModelsTimeoutMs) {
    fail("collector.pluginTimeoutMs");
  }
  const transportMarginMs = collectorFields["transportMarginMs"];
  if (!integerInRange(transportMarginMs, 500, 30000)) {
    fail("collector.transportMarginMs");
  }
  const maxOutputBytes = collectorFields["maxOutputBytes"];
  if (!integerInRange(maxOutputBytes, 1024, 1048576)) {
    fail("collector.maxOutputBytes");
  }
  const maxClockSkewMs = collectorFields["maxClockSkewMs"];
  if (!integerInRange(maxClockSkewMs, 0, 600000)) {
    fail("collector.maxClockSkewMs");
  }
  return {
    package: {
      id,
      version,
      sourceDigest,
      targets: [...targets] as readonly HostStateTarget[],
    },
    collector: {
      acceptedVersions: [...acceptedVersions] as readonly string[],
      pluginTimeoutMs,
      transportMarginMs,
      maxOutputBytes,
      maxClockSkewMs,
    },
  };
}

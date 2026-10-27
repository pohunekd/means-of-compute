import { readJson } from "../probe/config.js";

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

export type HostStateConfig = {
  readonly package: HostStatePackage;
};

const packageIdPattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const sourceDigestPattern = /^sha256:[0-9a-f]{64}$/;

function fail(key: string): never {
  throw new Error(`config host-state.json: invalid ${key}`);
}

export function loadHostStateConfig(path: string): HostStateConfig {
  const raw = readJson<unknown>(path);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("package");
  }
  const root = raw as Record<string, unknown>;
  const rootKeys = Object.keys(root);
  if (rootKeys.length !== 1 || rootKeys[0] !== "package") {
    fail("package");
  }
  const pkg = root["package"];
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    fail("package");
  }
  const fields = pkg as Record<string, unknown>;
  const keys = Object.keys(fields).sort();
  const expected = ["id", "sourceDigest", "targets", "version"];
  if (keys.length !== expected.length || !expected.every((k, i) => keys[i] === k)) {
    fail("package");
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
  return {
    package: {
      id,
      version,
      sourceDigest,
      targets: [...targets] as readonly HostStateTarget[],
    },
  };
}

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostStateConfig } from "../../src/hoststate/config.js";

const validPackage = {
  id: "moc.host-state",
  version: "0.1.0",
  sourceDigest: `sha256:${"a".repeat(64)}`,
  command: "host-state",
};

const validCollector = {
  acceptedVersions: ["0.1.0"],
  pluginTimeoutMs: 10000,
  transportMarginMs: 2000,
  maxOutputBytes: 16384,
  maxClockSkewMs: 120000,
};

const repoProbePath = join(import.meta.dir, "..", "..", "config", "probe.json");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function writeDoc(doc: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "hoststate-config-"));
  tempDirs.push(dir);
  copyFileSync(repoProbePath, join(dir, "probe.json"));
  const path = join(dir, "host-state.json");
  await Bun.write(path, JSON.stringify(doc));
  return path;
}

async function writeProbe(overrides: Record<string, unknown>): Promise<string> {
  const base = JSON.parse(readFileSync(repoProbePath, "utf-8")) as Record<string, unknown>;
  const merged = { ...base, ...overrides };
  const dir = mkdtempSync(join(tmpdir(), "hoststate-config-"));
  tempDirs.push(dir);
  await Bun.write(join(dir, "probe.json"), JSON.stringify(merged));
  return dir;
}

async function mutatePackage(mutate: (pkg: Record<string, unknown>) => void): Promise<string> {
  const pkg = JSON.parse(JSON.stringify(validPackage)) as Record<string, unknown>;
  mutate(pkg);
  return writeDoc({ package: pkg, collector: validCollector });
}

async function mutateCollector(
  mutate: (collector: Record<string, unknown>) => void,
): Promise<string> {
  const collector = JSON.parse(JSON.stringify(validCollector)) as Record<string, unknown>;
  mutate(collector);
  return writeDoc({ package: validPackage, collector });
}

async function packageWithout(key: "id" | "version" | "sourceDigest" | "command"): Promise<string> {
  const full = JSON.parse(JSON.stringify(validPackage)) as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(full)) {
    if (k !== key) rest[k] = full[k];
  }
  return writeDoc({ package: rest, collector: validCollector });
}

async function collectorWithout(
  key:
    | "acceptedVersions"
    | "pluginTimeoutMs"
    | "transportMarginMs"
    | "maxOutputBytes"
    | "maxClockSkewMs",
): Promise<string> {
  const full = JSON.parse(JSON.stringify(validCollector)) as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(full)) {
    if (k !== key) rest[k] = full[k];
  }
  return writeDoc({ package: validPackage, collector: rest });
}

describe("host-state package config", () => {
  test("valid package loads", async () => {
    const config = loadHostStateConfig(
      await writeDoc({ package: validPackage, collector: validCollector }),
    );
    expect(config.package.id).toBe("moc.host-state");
    expect(config.package.version).toBe("0.1.0");
    expect(config.package.command).toBe("host-state");
    expect(config.collector.acceptedVersions).toEqual(["0.1.0"]);
    expect(config.collector.pluginTimeoutMs).toBe(10000);
    expect(config.collector.transportMarginMs).toBe(2000);
    expect(config.collector.maxOutputBytes).toBe(16384);
    expect(config.collector.maxClockSkewMs).toBe(120000);
  });

  test("missing package section throws", async () => {
    const path = await writeDoc({ collector: validCollector });
    expect(() => loadHostStateConfig(path)).toThrow(/^config host-state\.json: invalid package$/);
  });

  test("extra top-level key throws", async () => {
    const path = await writeDoc({
      package: validPackage,
      collector: validCollector,
      extra: {},
    });
    expect(() => loadHostStateConfig(path)).toThrow(/^config host-state\.json: invalid package$/);
  });

  test("extra package key throws", async () => {
    const path = await mutatePackage((pkg) => {
      pkg["extra"] = true;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.extra",
    );
  });

  for (const key of ["id", "version", "sourceDigest", "command"] as const) {
    test(`missing package ${key} throws`, async () => {
      const path = await packageWithout(key);
      expect(() => loadHostStateConfig(path)).toThrow(
        `config host-state.json: invalid package.${key}`,
      );
    });
  }

  test("bad id throws", async () => {
    const path = await mutatePackage((pkg) => {
      pkg["id"] = "Moc Host State";
    });
    expect(() => loadHostStateConfig(path)).toThrow("config host-state.json: invalid package.id");
  });

  test("bad version throws", async () => {
    const path = await mutatePackage((pkg) => {
      pkg["version"] = "1.0";
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.version",
    );
  });

  test("bad sourceDigest throws", async () => {
    const path = await mutatePackage((pkg) => {
      pkg["sourceDigest"] = "sha256:xyz";
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.sourceDigest",
    );
  });

  test("missing package.command throws", async () => {
    const path = await mutatePackage((pkg) => {
      delete pkg["command"];
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.command",
    );
  });

  test("uppercase package.command throws", async () => {
    const path = await mutatePackage((pkg) => {
      pkg["command"] = "Host-State";
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.command",
    );
  });

  test("long package.command throws", async () => {
    const path = await mutatePackage((pkg) => {
      pkg["command"] = "a".repeat(33);
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.command",
    );
  });

  test("package.targets present throws", async () => {
    const path = await mutatePackage((pkg) => {
      pkg["targets"] = ["bun-linux-x64"];
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.targets",
    );
  });
});

describe("host-state collector config", () => {
  test("missing collector section throws", async () => {
    const path = await writeDoc({ package: validPackage });
    expect(() => loadHostStateConfig(path)).toThrow(/^config host-state\.json: invalid collector$/);
  });

  test("extra collector key throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["extra"] = true;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.extra",
    );
  });

  for (const key of [
    "acceptedVersions",
    "pluginTimeoutMs",
    "transportMarginMs",
    "maxOutputBytes",
    "maxClockSkewMs",
  ] as const) {
    test(`missing collector ${key} throws`, async () => {
      const path = await collectorWithout(key);
      expect(() => loadHostStateConfig(path)).toThrow(
        `config host-state.json: invalid collector.${key}`,
      );
    });
  }

  test("empty acceptedVersions throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["acceptedVersions"] = [];
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.acceptedVersions",
    );
  });

  test("duplicate acceptedVersions throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["acceptedVersions"] = ["0.1.0", "0.1.0"];
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.acceptedVersions",
    );
  });

  test("non-semver acceptedVersions throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["acceptedVersions"] = ["0.1.0", "latest"];
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.acceptedVersions",
    );
  });

  test("acceptedVersions without package version throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["acceptedVersions"] = ["0.2.0"];
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.acceptedVersions",
    );
  });

  test("pluginTimeoutMs below range throws", async () => {
    const dir = await writeProbe({ localModelsTimeoutMs: 100 });
    const path = join(dir, "host-state.json");
    await Bun.write(
      path,
      JSON.stringify({
        package: validPackage,
        collector: { ...validCollector, pluginTimeoutMs: 500 },
      }),
    );
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.pluginTimeoutMs",
    );
  });

  test("pluginTimeoutMs above range throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["pluginTimeoutMs"] = 70000;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.pluginTimeoutMs",
    );
  });

  test("non-integer pluginTimeoutMs throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["pluginTimeoutMs"] = 10000.5;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.pluginTimeoutMs",
    );
  });

  test("pluginTimeoutMs at localModelsTimeoutMs throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["pluginTimeoutMs"] = 2000;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.pluginTimeoutMs",
    );
  });

  test("pluginTimeoutMs above range floor but below localModelsTimeoutMs throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["pluginTimeoutMs"] = 1500;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.pluginTimeoutMs",
    );
  });

  test("transportMarginMs below range throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["transportMarginMs"] = 100;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.transportMarginMs",
    );
  });

  test("transportMarginMs above range throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["transportMarginMs"] = 40000;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.transportMarginMs",
    );
  });

  test("maxOutputBytes below range throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["maxOutputBytes"] = 512;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.maxOutputBytes",
    );
  });

  test("maxOutputBytes at the daemon ceiling loads", async () => {
    const path = await mutateCollector((collector) => {
      collector["maxOutputBytes"] = 131072;
    });
    const config = loadHostStateConfig(path);
    expect(config.collector.maxOutputBytes).toBe(131072);
  });

  test("maxOutputBytes above range throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["maxOutputBytes"] = 131073;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.maxOutputBytes",
    );
  });

  test("negative maxClockSkewMs throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["maxClockSkewMs"] = -1;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.maxClockSkewMs",
    );
  });

  test("maxClockSkewMs above range throws", async () => {
    const path = await mutateCollector((collector) => {
      collector["maxClockSkewMs"] = 700000;
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid collector.maxClockSkewMs",
    );
  });

  test("zero maxClockSkewMs loads", async () => {
    const path = await mutateCollector((collector) => {
      collector["maxClockSkewMs"] = 0;
    });
    const config = loadHostStateConfig(path);
    expect(config.collector.maxClockSkewMs).toBe(0);
  });
});

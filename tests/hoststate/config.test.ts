import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostStateConfig } from "../../src/hoststate/config.js";

const validPackage = {
  id: "moc.host-state",
  version: "0.1.0",
  sourceDigest: `sha256:${"a".repeat(64)}`,
  targets: ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64", "bun-darwin-x64"],
};

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeDoc(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "hoststate-config-"));
  tempDirs.push(dir);
  const path = join(dir, "host-state.json");
  Bun.write(path, JSON.stringify(doc));
  return path;
}

function mutatePackage(mutate: (pkg: Record<string, unknown>) => void): string {
  const pkg = JSON.parse(JSON.stringify(validPackage)) as Record<string, unknown>;
  mutate(pkg);
  return writeDoc({ package: pkg });
}

describe("host-state package config", () => {
  test("valid package loads", () => {
    const config = loadHostStateConfig(writeDoc({ package: validPackage }));
    expect(config.package.id).toBe("moc.host-state");
    expect(config.package.version).toBe("0.1.0");
    expect(config.package.targets).toEqual([
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-darwin-arm64",
      "bun-darwin-x64",
    ]);
  });

  test("missing package section throws", () => {
    expect(() => loadHostStateConfig(writeDoc({}))).toThrow(
      "config host-state.json: invalid package",
    );
  });

  test("extra top-level key throws", () => {
    const path = writeDoc({ package: validPackage, collector: {} });
    expect(() => loadHostStateConfig(path)).toThrow("config host-state.json: invalid package");
  });

  test("extra package key throws", () => {
    const path = mutatePackage((pkg) => {
      pkg["extra"] = true;
    });
    expect(() => loadHostStateConfig(path)).toThrow("config host-state.json: invalid package");
  });

  test("missing package id throws", () => {
    const path = mutatePackage((pkg) => {
      delete pkg["id"];
    });
    expect(() => loadHostStateConfig(path)).toThrow("config host-state.json: invalid package");
  });

  test("bad id throws", () => {
    const path = mutatePackage((pkg) => {
      pkg["id"] = "Moc Host State";
    });
    expect(() => loadHostStateConfig(path)).toThrow("config host-state.json: invalid package.id");
  });

  test("bad version throws", () => {
    const path = mutatePackage((pkg) => {
      pkg["version"] = "1.0";
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.version",
    );
  });

  test("bad sourceDigest throws", () => {
    const path = mutatePackage((pkg) => {
      pkg["sourceDigest"] = "sha256:xyz";
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.sourceDigest",
    );
  });

  test("empty targets throws", () => {
    const path = mutatePackage((pkg) => {
      pkg["targets"] = [];
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.targets",
    );
  });

  test("duplicate targets throws", () => {
    const path = mutatePackage((pkg) => {
      pkg["targets"] = ["bun-linux-x64", "bun-linux-x64"];
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.targets",
    );
  });

  test("unknown target throws", () => {
    const path = mutatePackage((pkg) => {
      pkg["targets"] = ["bun-linux-x64", "bun-windows-x64"];
    });
    expect(() => loadHostStateConfig(path)).toThrow(
      "config host-state.json: invalid package.targets",
    );
  });
});

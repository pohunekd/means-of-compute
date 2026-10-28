import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHostCapacity } from "../../contracts/v1/validate.js";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function run(
  cmd: readonly string[],
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<RunResult> {
  const proc = Bun.spawn([...cmd], {
    cwd: options?.cwd ?? repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TZ: "UTC", ...options?.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode: proc.exitCode ?? 1, stdout, stderr };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function buildPackage(out: string): Promise<string> {
  const r = await run(["bun", "run", "plugin:build", "--out", out]);
  expect(r.exitCode).toBe(0);
  const entries = readdirSync(out);
  expect(entries).toEqual(["moc-host-state-0.2.0"]);
  return join(out, entries[0] as string);
}

const buildTimeoutMs = 180_000;

describe("plugin package", () => {
  test(
    "bundled entry output deep-equals fixtures for every scenario",
    async () => {
      const out = tempDir("hoststate-pkg-");
      try {
        const pkg = await buildPackage(out);
        const bin = join(pkg, "bin", "moc-host-state");
        const scenarios = readdirSync(join(repoRoot, "config", "scenarios"))
          .filter((f) => f.endsWith(".json"))
          .sort();
        expect(scenarios.length).toBeGreaterThan(0);
        for (const file of scenarios) {
          const name = file.replace(/\.json$/, "");
          const r = await run([bin, "--scenario", name]);
          expect(r.exitCode).toBe(0);
          expect(r.stderr).toBe("");
          const actual: unknown = JSON.parse(r.stdout);
          expect(isHostCapacity(actual)).toBe(true);
          const fixture: unknown = JSON.parse(
            readFileSync(join(repoRoot, "tests", "fixtures", "probe", "scenarios", file), "utf-8"),
          );
          expect(actual).toEqual(fixture);
        }
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    buildTimeoutMs,
  );

  test("no file under src/probe/ uses import.meta.url or process.execPath", () => {
    const probeDir = join(repoRoot, "src", "probe");
    const files = (readdirSync(probeDir, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(probeDir, file), "utf-8");
      expect(text).not.toContain("import.meta.url");
      expect(text).not.toContain("process.execPath");
    }
  });

  test(
    "host file outside HOME resolves the alias, missing host file fails",
    async () => {
      const out = tempDir("hoststate-pkg-");
      const home = tempDir("hoststate-home-");
      const etcDir = tempDir("hoststate-etc-");
      try {
        const pkg = await buildPackage(out);
        writeFileSync(
          join(pkg, "config", "plugin.json"),
          JSON.stringify({ hostFile: join(etcDir, "host.json") }),
        );
        // A valid host file inside HOME must not be used: the package
        // points outside HOME.
        const homeHostDir = join(home, ".config", "means-of-compute");
        mkdirSync(homeHostDir, { recursive: true });
        writeFileSync(join(homeHostDir, "host.json"), JSON.stringify({ hostAlias: "laptop-z" }));
        const scenario = JSON.parse(
          readFileSync(join(repoRoot, "config", "scenarios", "desktop-mains.json"), "utf-8"),
        ) as Record<string, unknown>;
        delete scenario["hostAlias"];
        const factsPath = join(home, "facts.json");
        writeFileSync(factsPath, JSON.stringify(scenario));
        const hostPath = join(etcDir, "host.json");
        const missing = await run([join(pkg, "bin", "moc-host-state"), "--facts", factsPath], {
          env: { HOME: home },
        });
        expect(missing.exitCode).toBe(1);
        expect(missing.stdout).toBe("");
        expect(missing.stderr).toBe(`host file ${hostPath}: ENOENT\n`);
        writeFileSync(join(etcDir, "host.json"), "{not json");
        const unparsable = await run([join(pkg, "bin", "moc-host-state"), "--facts", factsPath], {
          env: { HOME: home },
        });
        expect(unparsable.exitCode).toBe(1);
        expect(unparsable.stdout).toBe("");
        expect(unparsable.stderr).toBe(`host file ${hostPath}: invalid hostAlias\n`);
        writeFileSync(
          join(etcDir, "host.json"),
          JSON.stringify({ hostAlias: "laptop-a", extra: true }),
        );
        const extra = await run([join(pkg, "bin", "moc-host-state"), "--facts", factsPath], {
          env: { HOME: home },
        });
        expect(extra.exitCode).toBe(1);
        expect(extra.stdout).toBe("");
        expect(extra.stderr).toBe(`host file ${hostPath}: invalid hostAlias\n`);
        writeFileSync(join(etcDir, "host.json"), JSON.stringify({ hostAlias: "laptop-a" }));
        const present = await run([join(pkg, "bin", "moc-host-state"), "--facts", factsPath], {
          env: { HOME: home },
        });
        expect(present.exitCode).toBe(0);
        const doc = JSON.parse(present.stdout) as { hostAlias: string };
        expect(doc.hostAlias).toBe("laptop-a");
      } finally {
        rmSync(out, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
        rmSync(etcDir, { recursive: true, force: true });
      }
    },
    buildTimeoutMs,
  );

  test(
    "package lists the six entries with mode, shebang, size and manifest",
    async () => {
      const out = tempDir("hoststate-pkg-");
      try {
        const pkg = await buildPackage(out);
        expect(readdirSync(pkg).sort()).toEqual(["bin", "build.json", "config", "runtime.toml"]);
        expect(readdirSync(join(pkg, "config")).sort()).toEqual([
          "plugin.json",
          "probe.json",
          "scenarios",
        ]);
        const binPath = join(pkg, "bin", "moc-host-state");
        const { mode, size } = await Bun.file(binPath)
          .stat()
          .then((s) => s);
        expect(mode & 0o777).toBe(0o755);
        const firstLine = readFileSync(binPath, "utf-8").split("\n")[0];
        expect(firstLine).toBe("#!/usr/bin/env bun");
        expect(size).toBeLessThan(16777216);
        const config = JSON.parse(
          readFileSync(join(repoRoot, "config", "host-state.json"), "utf-8"),
        ) as { package: { id: string; version: string; command: string } };
        const manifest = readFileSync(join(pkg, "runtime.toml"), "utf-8");
        expect(manifest).toBe(
          [
            "schema = 1",
            `id = "${config.package.id}"`,
            `version = "${config.package.version}"`,
            "runtime_api = 1",
            `requires = ["package-commands-v1"]`,
            "",
            `[commands.${config.package.command}]`,
            `program = "bin/moc-host-state"`,
            `args = []`,
            `expose = "peers"`,
            "",
          ].join("\n"),
        );
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    buildTimeoutMs,
  );

  test("plugin:build rejects --target as an unknown argument", async () => {
    const dir = tempDir("hoststate-target-");
    try {
      const r = await run(["bun", "run", "plugin:build", "--target", "native", "--out", dir]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("plugin:build: unknown argument --target");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    "unknown argument exits 2 with empty stdout",
    async () => {
      const out = tempDir("hoststate-pkg-");
      try {
        const pkg = await buildPackage(out);
        const r = await run([join(pkg, "bin", "moc-host-state"), "--bogus"]);
        expect(r.exitCode).toBe(2);
        expect(r.stdout).toBe("");
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    buildTimeoutMs,
  );

  test(
    "plugin:digest matches the committed source digest",
    async () => {
      const r = await run(["bun", "run", "plugin:digest"]);
      expect(r.exitCode).toBe(0);
    },
    buildTimeoutMs,
  );

  test("plugin:digest exits 2 on an invalid config", async () => {
    const dir = tempDir("hoststate-invalid-");
    try {
      const configPath = join(dir, "host-state.json");
      const config = JSON.parse(
        readFileSync(join(repoRoot, "config", "host-state.json"), "utf-8"),
      ) as { package: Record<string, unknown>; collector: Record<string, unknown> };
      config.package["version"] = "not-a-version";
      writeFileSync(configPath, JSON.stringify(config));
      const r = await run(["bun", "run", "plugin:digest", "--config", configPath]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("config host-state.json: invalid package.version");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plugin:build exits 2 when --out is a file", async () => {
    const dir = tempDir("hoststate-outfile-");
    try {
      const filePath = join(dir, "out");
      writeFileSync(filePath, "taken");
      const r = await run(["bun", "run", "plugin:build", "--out", filePath]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(`output path ${filePath} is not a directory`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("build.json records the package command", async () => {
    const out = tempDir("hoststate-pkg-");
    try {
      const pkg = await buildPackage(out);
      const buildJson = JSON.parse(readFileSync(join(pkg, "build.json"), "utf-8")) as Record<
        string,
        unknown
      >;
      expect(buildJson["command"]).toBe("host-state");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

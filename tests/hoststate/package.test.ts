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

async function buildNative(out: string): Promise<string> {
  const r = await run(["bun", "run", "plugin:build", "--target", "native", "--out", out]);
  expect(r.exitCode).toBe(0);
  const entries = readdirSync(out);
  expect(entries.length).toBe(1);
  const bin = join(out, entries[0] as string, "bin", "moc-host-state");
  return bin;
}

const buildTimeoutMs = 180_000;

describe("plugin package", () => {
  test(
    "compiled binary output deep-equals fixtures for every scenario",
    async () => {
      const out = tempDir("hoststate-pkg-");
      try {
        const bin = await buildNative(out);
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

  test("no file under src/probe/ derives paths from import.meta.url", () => {
    const probeDir = join(repoRoot, "src", "probe");
    const files = (readdirSync(probeDir, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(probeDir, file), "utf-8");
      expect(text).not.toContain("import.meta.url");
    }
  });

  test(
    "host file resolves the alias, missing host file fails",
    async () => {
      const out = tempDir("hoststate-pkg-");
      const home = tempDir("hoststate-home-");
      try {
        const bin = await buildNative(out);
        const scenario = JSON.parse(
          readFileSync(join(repoRoot, "config", "scenarios", "desktop-mains.json"), "utf-8"),
        ) as Record<string, unknown>;
        delete scenario["hostAlias"];
        const factsPath = join(home, "facts.json");
        writeFileSync(factsPath, JSON.stringify(scenario));
        const missing = await run([bin, "--facts", factsPath], { env: { HOME: home } });
        expect(missing.exitCode).toBe(1);
        expect(missing.stdout).toBe("");
        const hostPath = join(home, ".config", "means-of-compute", "host.json");
        expect(missing.stderr).toBe(`host file ${hostPath}: ENOENT\n`);
        const hostDir = join(home, ".config", "means-of-compute");
        mkdirSync(hostDir, { recursive: true });
        writeFileSync(join(hostDir, "host.json"), "{not json");
        const unparsable = await run([bin, "--facts", factsPath], { env: { HOME: home } });
        expect(unparsable.exitCode).toBe(1);
        expect(unparsable.stdout).toBe("");
        expect(unparsable.stderr).toBe(`host file ${hostPath}: invalid hostAlias\n`);
        writeFileSync(
          join(hostDir, "host.json"),
          JSON.stringify({ hostAlias: "laptop-a", extra: true }),
        );
        const extra = await run([bin, "--facts", factsPath], { env: { HOME: home } });
        expect(extra.exitCode).toBe(1);
        expect(extra.stdout).toBe("");
        expect(extra.stderr).toBe(`host file ${hostPath}: invalid hostAlias\n`);
        writeFileSync(join(hostDir, "host.json"), JSON.stringify({ hostAlias: "laptop-a" }));
        const present = await run([bin, "--facts", factsPath], { env: { HOME: home } });
        expect(present.exitCode).toBe(0);
        const doc = JSON.parse(present.stdout) as { hostAlias: string };
        expect(doc.hostAlias).toBe("laptop-a");
      } finally {
        rmSync(out, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    buildTimeoutMs,
  );

  test(
    "unknown argument exits 2 with empty stdout",
    async () => {
      const out = tempDir("hoststate-pkg-");
      try {
        const bin = await buildNative(out);
        const r = await run([bin, "--bogus"]);
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
      const r = await run([
        "bun",
        "run",
        "plugin:digest",
        "--config",
        configPath,
      ]);
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
      const r = await run(["bun", "run", "plugin:build", "--target", "native", "--out", filePath]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(`output path ${filePath} is not a directory`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

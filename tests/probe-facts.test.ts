import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { isHostCapacity } from "../contracts/v1/validate.js";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const probe = join(repoRoot, "factory-probe.ts");

describe.skipIf(process.platform !== "linux")("facts validation", () => {
  test("every committed scenario validates and matches its committed output", async () => {
    const scenariosDir = join(repoRoot, "config", "scenarios");
    const fixturesDir = join(repoRoot, "tests", "fixtures", "probe", "scenarios");
    const names = readdirSync(scenariosDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const proc = Bun.spawn(["bun", probe, "--scenario", name], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TZ: "UTC" },
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(`${name}: ${stderr}`).toBe(`${name}: `);
      expect(proc.exitCode).toBe(0);
      const output: unknown = JSON.parse(stdout);
      expect(isHostCapacity(output)).toBe(true);
      const fixture: unknown = JSON.parse(await Bun.file(join(fixturesDir, `${name}.json`)).text());
      expect(output).toEqual(fixture);
    }
  });
});

import { expect, test } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, "scripts", "work-summary.ts");

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("work:summary prints summary for --store", async () => {
  const { code, stdout, stderr } = await runCli(["--store", "tests/fixtures/coord/d3/store.json"]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  const summary = JSON.parse(stdout.trim()) as unknown;
  expect(summary).toEqual({
    revision: 4,
    total: 3,
    byStatus: {
      queued: 1,
      running: 0,
      review: 0,
      parked: 0,
      blocked: 1,
      done: 1,
    },
  });
});

test("work:summary exits 2 for unknown argument", async () => {
  const { code, stderr } = await runCli(["--bogus"]);
  expect(code).toBe(2);
  const line = stderr.trim();
  expect(line.startsWith("work:summary:")).toBeTrue();
  expect(line.split("\n").length).toBe(1);
});

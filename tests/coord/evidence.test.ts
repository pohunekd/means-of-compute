// Evidence bundle tests (V1) and judge replay (J1).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { homedir } from "node:os";
import { mkdirSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../../src/work/canonical.js";
import { redactText } from "../../src/coord/evidence.js";
import { createCoordTestEnv } from "./env.js";
import { createMcpTestEnv } from "../mcp/env.js";

function checkoutLogNames(): string[] {
  try {
    return readdirSync(join(process.cwd(), "logs")).sort();
  } catch {
    return [];
  }
}

let checkoutBefore: string[] = [];

beforeAll(() => {
  checkoutBefore = checkoutLogNames();
});

afterAll(() => {
  expect(checkoutLogNames()).toEqual(checkoutBefore);
});

async function runEvidence(
  args: readonly string[],
  cwd: string,
  home: string,
): Promise<{
  readonly rc: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, "run", join(cwd, "src/coord/evidence.ts"), ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [rc, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { rc, stdout, stderr };
}

test("evidence bundle redacts paths and scans deny patterns (V1)", async () => {
  expect(
    redactText("/h/u/code/moc/logs/r/home/.x /h/u/code/moc/a /h/u/b", {
      runDirs: ["/h/u/code/moc/logs/r"],
      cwd: "/h/u/code/moc",
      home: "/h/u",
    }),
  ).toBe("<run-home>/.x <checkout>/a ~/b");
  const env = await createCoordTestEnv();
  const home = homedir();
  const configJson = {
    ...env.configJson,
    skillDir: join(process.cwd(), ".agents/skills/factory-coord"),
  };
  const configPath = join(env.dir, "coordinator-ev.json");
  const configText = `${JSON.stringify(configJson)}\n`;
  await Bun.write(configPath, configText);
  const runDir = join(env.dir, "run");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(runDir, { recursive: true });
  await Bun.write(
    join(runDir, "report.json"),
    `${JSON.stringify({ configPath, configSha256: sha256Hex(configText) })}\n`,
  );
  const checkoutReal = realpathSync(env.checkoutDir);
  await Bun.write(join(runDir, "report.md"), `see ${checkoutReal}/a and ${home}/b task-x\n`);
  await Bun.write(join(runDir, "mcp-calls.jsonl"), `{"event":"server-start"}\n`);
  await Bun.write(join(runDir, "prompt-1.md"), "prompt\n");
  mkdirSync(join(env.dir, "outs-real"));
  symlinkSync(join(env.dir, "outs-real"), join(env.dir, "outs"));
  const out1 = join(env.dir, "outs", "out1");
  const first = await runEvidence(["--run", runDir, "--out", out1], checkoutReal, home);
  expect(first.rc).toBe(0);
  expect(first.stdout.trim().split("\n").length).toBe(4);
  expect(await Bun.file(join(out1, "report.md")).text()).toBe("see <checkout>/a and ~/b task-x\n");
  expect(statSync(out1).mode & 0o777).toBe(0o700);
  for (const name of ["report.md", "report.json", "mcp-calls.jsonl", "prompt-1.md"]) {
    expect(statSync(join(out1, name)).mode & 0o777).toBe(0o600);
  }
  await Bun.write(join(runDir, "session-1-export.json"), `{"x":"192.168.1.5"}\n`);
  const out2 = join(env.dir, "out2");
  const second = await runEvidence(["--run", runDir, "--out", out2], checkoutReal, home);
  expect(second.rc).toBe(3);
  expect(
    second.stderr.includes("coord:evidence: session-1-export.json:1 matches deny pattern 2"),
  ).toBe(true);
  expect(second.stderr.includes("192.168")).toBe(false);
  expect(statSync(out2).isDirectory()).toBe(true);
  const third = await runEvidence(["--run", runDir, "--out", out1], checkoutReal, home);
  expect(third.rc).toBe(2);
  expect(third.stderr.includes("already exists")).toBe(true);
}, 30000);

test("judge replay returns the pinned submission id (J1)", async () => {
  const mcp = await createMcpTestEnv("coord-judge-");
  const fixturePath = join(process.cwd(), "tests/fixtures/coord/replay/d1-submit.json");
  const fixture = (await Bun.file(fixturePath).json()) as { readonly items: readonly unknown[] };
  async function submitOnce(): Promise<{
    readonly rc: number;
    readonly last: Record<string, unknown>;
  }> {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "mcp:call",
        "submit_work",
        "--file",
        fixturePath,
        "--config",
        mcp.mcpConfigPath,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [rc, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    const lines = stdout.trim().split("\n");
    return { rc, last: JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown> };
  }
  const first = await submitOnce();
  expect(first.rc).toBe(0);
  expect(first.last["ok"]).toBe(true);
  expect(first.last["submissionId"]).toBe("sub-6b9641d69cb833e3");
  expect(first.last["replayed"]).toBe(false);
  const second = await submitOnce();
  expect(second.last["replayed"]).toBe(true);
  expect(`sub-${sha256Hex(canonicalJson(fixture.items)).slice(0, 16)}`).toBe(
    "sub-6b9641d69cb833e3",
  );
}, 30000);

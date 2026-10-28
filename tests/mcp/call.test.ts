// mcp:call tests (matrix C1, C2): a spawned mcp:call fleet_status exits
// 0 with one stdout line holding "ok":true; --bogus exits 2 and a config
// naming an unknown caller exits 4.
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { createMcpTestEnv } from "./env.js";

interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function spawnCall(args: readonly string[]): Promise<SpawnResult> {
  const proc = Bun.spawn([process.execPath, "src/mcp/call.ts", ...args], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  return { code, stdout: out, stderr: err };
}

test("C1 spawned mcp:call fleet_status exits 0 with ok true (C1)", async () => {
  const env = await createMcpTestEnv("mcp-c1-");
  await Bun.write(
    env.storePath,
    JSON.stringify({ schemaVersion: "v1", revision: 0, items: [], submissions: [] }),
  );
  await Bun.write(env.registryPath, JSON.stringify({ sessions: [] }));
  const result = await spawnCall(["fleet_status", "--config", env.mcpConfigPath]);
  expect(result.code).toBe(0);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBe(1);
  const parsed = JSON.parse(lines[0] as string) as { ok: boolean };
  expect(parsed.ok).toBe(true);
});

test("O2 large list_work result drains via slow reader without truncation (O2)", async () => {
  const env = await createMcpTestEnv("mcp-o2-");
  const items: unknown[] = [];
  for (let n = 0; n < 600; n += 1) {
    items.push({
      schemaVersion: "v1",
      id: `w-${String(n).padStart(4, "0")}`,
      repo: "example/demo-repo",
      title: `Item ${String(n)} ${"x".repeat(200)}`,
      goal: "Goal",
      issue: n + 1,
      dod: [{ id: "D1", text: "Done", done: false }],
      dependencies: [],
      status: "queued",
      statusReason: null,
      assignedHostAlias: null,
      branch: null,
      pullNumber: null,
      modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
      retryCount: 0,
      stallRounds: 0,
    });
  }
  await Bun.write(
    env.storePath,
    JSON.stringify({ schemaVersion: "v1", revision: 1, items, submissions: [] }),
  );
  await Bun.write(env.registryPath, JSON.stringify({ sessions: [] }));
  await Bun.write(
    "tests/fixtures/mcp/list-all.json",
    JSON.stringify({ status: ["queued", "running", "review", "parked", "blocked", "done"] }),
  );
  const rcFile = `${env.dir}/rc`;
  const shCmd = `{ ${process.execPath} src/mcp/call.ts list_work --file tests/fixtures/mcp/list-all.json --config "${env.mcpConfigPath}"; echo $? > "${rcFile}"; } | (sleep 1; cat)`;
  const proc = Bun.spawn(["sh", "-c", shCmd], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
  ]);
  expect(code).toBe(0);
  expect(out.length).toBeGreaterThan(200000);
  const parsed = JSON.parse(out.split("\n")[0] as string) as { ok: boolean; items: unknown[] };
  expect(parsed.ok).toBe(true);
  expect(parsed.items.length).toBe(600);
  expect(await Bun.file(rcFile).text()).toBe("0\n");
}, 25000);

test("C2 usage and config errors map to exits 2 and 4 (C2)", async () => {
  const bogus = await spawnCall(["fleet_status", "--bogus"]);
  expect(bogus.code).toBe(2);

  const env = await createMcpTestEnv("mcp-c2-");
  const raw = JSON.parse(await Bun.file(env.mcpConfigPath).text()) as Record<string, unknown>;
  raw["callers"] = ["someone-else"];
  await writeFile(env.mcpConfigPath, JSON.stringify(raw));
  const unknownCaller = await spawnCall(["fleet_status", "--config", env.mcpConfigPath]);
  expect(unknownCaller.code).toBe(4);
  expect(unknownCaller.stdout).toBe("");
});

// mcp:call tests (matrix C1, C2): a spawned mcp:call fleet_status exits
// 0 with one stdout line holding "ok":true; --bogus exits 2 and a config
// naming an unknown caller exits 4.
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { createMcpTestEnv } from "../../tests/mcp/env.js";

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

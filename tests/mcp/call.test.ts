// mcp:call tests (matrix C1, C2): a spawned mcp:call fleet_status exits
// 0 with one stdout line holding "ok":true; --bogus exits 2 and a config
// naming an unknown caller exits 4.
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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

test("O1 a server that never answers exits 4 within the bound (O1)", async () => {
  const env = await createMcpTestEnv("mcp-o1-");
  const raw = JSON.parse(await Bun.file(env.mcpConfigPath).text()) as Record<string, unknown>;
  raw["clientTimeoutMs"] = 1500;
  await writeFile(env.mcpConfigPath, JSON.stringify(raw));
  await Bun.write(
    `${env.dir}/block.ts`,
    'if (process.argv.includes("--caller")) { await Bun.write("server.pid", String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }\n',
  );
  await Bun.write(`${env.dir}/bunfig.toml`, 'preload = ["./block.ts"]\n');
  const pidFile = `${env.dir}/server.pid`;
  const started = Date.now();
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn(
      [
        process.execPath,
        join(process.cwd(), "src/mcp/call.ts"),
        "fleet_status",
        "--config",
        env.mcpConfigPath,
      ],
      { cwd: env.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const outcome = await Promise.race([
      proc.exited.then(() => "exited" as const),
      Bun.sleep(10000).then(() => "hang" as const),
    ]);
    expect(outcome).toBe("exited");
    const code = await proc.exited;
    const elapsed = Date.now() - started;
    expect(await Bun.file(pidFile).exists()).toBe(true);
    const pid = Number((await Bun.file(pidFile).text()).trim());
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    const [out, err] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    expect(code).toBe(4);
    expect(out).toBe("");
    expect(err).toBe("mcp:call: no answer within 1500 ms\n");
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(5000);
  } finally {
    const client = proc;
    if (client !== null) {
      try {
        client.kill("SIGKILL");
      } catch {
        // The client already exited.
      }
      try {
        await client.exited;
      } catch {
        // The client already exited.
      }
    }
    let leftover = Number.NaN;
    try {
      leftover = Number((await Bun.file(pidFile).text()).trim());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        expect.unreachable(`leftover server pid unreadable: ${(error as Error).message}`);
      }
      // The server never reached the preload, so it wrote no pid file.
    }
    if (Number.isInteger(leftover)) {
      try {
        process.kill(leftover, "SIGKILL");
      } catch {
        // The client already reaped the blocked server.
      }
    }
  }
}, 20000);

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
  expect(out.endsWith("\n")).toBe(true);
  expect(out.split("\n").length).toBe(2);
  expect(await Bun.file(rcFile).text()).toBe("0\n");
}, 25000);

test("O3 --file rejects a directory and a path under a missing dir (O3)", async () => {
  const env = await createMcpTestEnv("mcp-o3-");
  const dirCase = await spawnCall([
    "fleet_status",
    "--file",
    env.dir,
    "--config",
    env.mcpConfigPath,
  ]);
  expect(dirCase.code).toBe(2);
  expect(dirCase.stdout).toBe("");
  expect(dirCase.stderr).toBe(`mcp:call file ${env.dir}: not a regular file\n`);

  const missing = `${env.dir}/missing/x.json`;
  const missingCase = await spawnCall([
    "fleet_status",
    "--file",
    missing,
    "--config",
    env.mcpConfigPath,
  ]);
  expect(missingCase.code).toBe(2);
  expect(missingCase.stdout).toBe("");
  expect(missingCase.stderr).toBe(`mcp:call file ${missing}: cannot stat parent (ENOENT)\n`);
});

test("O5 extra positional and duplicate --config exit 2 (O5)", async () => {
  const env = await createMcpTestEnv("mcp-o5-");
  const usage = "mcp:call: usage: mcp:call <tool> [--file <path>] [--config <path>]\n";

  const extra = await spawnCall(["fleet_status", "extra", "--config", env.mcpConfigPath]);
  expect(extra.code).toBe(2);
  expect(extra.stdout).toBe("");
  expect(extra.stderr).toBe(usage);

  const dup = await spawnCall(["fleet_status", "--config", "a", "--config", "b"]);
  expect(dup.code).toBe(2);
  expect(dup.stdout).toBe("");
  expect(dup.stderr).toBe(usage);
});

test("E2 spawned mcp:call submit_work --file cyclic exits 3 with the cycle edge (E2)", async () => {
  const env = await createMcpTestEnv("mcp-e2-");
  await Bun.write(
    env.storePath,
    JSON.stringify({ schemaVersion: "v1", revision: 0, items: [], submissions: [] }),
  );
  await Bun.write(env.registryPath, JSON.stringify({ sessions: [] }));
  const result = await spawnCall([
    "submit_work",
    "--file",
    "tests/fixtures/mcp/cyclic-dag.json",
    "--config",
    env.mcpConfigPath,
  ]);
  expect(result.code).toBe(3);
  expect(result.stdout).toContain("cycle edge demo-cyc-c -> demo-cyc-a");
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

// Placement CLI tests: exit codes and input validation for
// `bun run place --item --hosts --running`. The CLI reads
// config/placement.json relative to the working directory, so each test runs
// in a temp sandbox with its own config and inputs. Each test names the
// mutation that must make it fail.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const ITEM = {
  schemaVersion: "v1",
  id: "w1-demo",
  repo: "pohunekd/means-of-compute",
  title: "Demo placement run",
  goal: "Demo placement on the synthetic fleet",
  issue: 11,
  dod: [{ id: "D1", text: "Placement chooses the idle desktop", done: false }],
  dependencies: [],
  status: "queued",
  statusReason: null,
  assignedHostAlias: null,
  branch: null,
  pullNumber: null,
  modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
  retryCount: 0,
  stallRounds: 0,
};

function idleHost(hostAlias: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    hostAlias,
    timestamp: "2026-10-26T10:00:00.000Z",
    idle: true,
    idleReason: "no user input for 42 minutes, on AC power",
    secondsSinceInput: 2520,
    acPower: true,
    batteryPercent: null,
    cpu: { cores: 8, load1m: 0.7 },
    memory: { totalMb: 32768, freeMb: 21000 },
    gpu: { present: false, name: null, freeMb: null },
    localModels: { reachable: false, models: [] },
    policy: {
      allowedWindow: { start: "08:00", end: "22:00" },
      insideWindow: true,
      maxConcurrentAgents: 2,
    },
  };
}

async function makeSandbox(
  configBody = '{"batteryFloorPercent": 50, "weights": {"cpu": 0.4, "memory": 0.4, "gpu": 0.2}}',
): Promise<{
  dir: string;
  run: (args: readonly string[]) => Promise<SpawnResult>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "moc-place-"));
  await Bun.write(join(dir, "config", "placement.json"), configBody);
  await Bun.write(join(dir, "item.json"), JSON.stringify(ITEM));
  await Bun.write(join(dir, "hosts.json"), JSON.stringify([idleHost("desktop")]));
  await Bun.write(join(dir, "running.json"), JSON.stringify([]));
  const script = join(import.meta.dir, "..", "..", "src", "placement", "cli.ts");
  const run = async (args: readonly string[]): Promise<SpawnResult> => {
    const proc = Bun.spawn(["bun", script, ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };
  return { dir, run };
}

test("all hosts excluded: CLI exits 3 with a null decision (mutation: return the first host)", async () => {
  const sandbox = await makeSandbox();
  try {
    await Bun.write(
      join(sandbox.dir, "hosts.json"),
      JSON.stringify([
        { ...idleHost("desktop"), idle: false, idleReason: "user input 10 seconds ago" },
      ]),
    );
    const result = await sandbox.run([
      "--item",
      join(sandbox.dir, "item.json"),
      "--hosts",
      join(sandbox.dir, "hosts.json"),
      "--running",
      join(sandbox.dir, "running.json"),
    ]);
    expect(result.code).toBe(3);
    const decision = JSON.parse(result.stdout) as { chosenHostAlias: unknown; reason: string };
    expect(decision.chosenHostAlias).toBeNull();
    expect(decision.reason).toContain("no eligible host");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("weights summing to 0.9: CLI exits 2 (mutation: drop the sum check)", async () => {
  const sandbox = await makeSandbox(
    '{"batteryFloorPercent": 50, "weights": {"cpu": 0.3, "memory": 0.3, "gpu": 0.3}}',
  );
  try {
    const result = await sandbox.run([
      "--item",
      join(sandbox.dir, "item.json"),
      "--hosts",
      join(sandbox.dir, "hosts.json"),
      "--running",
      join(sandbox.dir, "running.json"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("sum to 1");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("freeMb above totalMb: CLI exits 2 naming the index (mutation: drop the bound check)", async () => {
  const sandbox = await makeSandbox();
  try {
    await Bun.write(
      join(sandbox.dir, "hosts.json"),
      JSON.stringify([
        idleHost("desktop"),
        { ...idleHost("laptop-a"), memory: { totalMb: 32768, freeMb: 99999 } },
      ]),
    );
    const result = await sandbox.run([
      "--item",
      join(sandbox.dir, "item.json"),
      "--hosts",
      join(sandbox.dir, "hosts.json"),
      "--running",
      join(sandbox.dir, "running.json"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("index 1");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("extra top-level config key: CLI exits 2 (mutation: drop the top-level key check)", async () => {
  const sandbox = await makeSandbox(
    '{"batteryFloorPercent": 50, "weights": {"cpu": 0.4, "memory": 0.4, "gpu": 0.2}, "extra": true}',
  );
  try {
    const result = await sandbox.run([
      "--item",
      join(sandbox.dir, "item.json"),
      "--hosts",
      join(sandbox.dir, "hosts.json"),
      "--running",
      join(sandbox.dir, "running.json"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unexpected key "extra"');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("duplicate alias in --hosts: CLI exits 2 (mutation: drop the duplicate check)", async () => {
  const sandbox = await makeSandbox();
  try {
    await Bun.write(
      join(sandbox.dir, "hosts.json"),
      JSON.stringify([idleHost("desktop"), idleHost("desktop")]),
    );
    const result = await sandbox.run([
      "--item",
      join(sandbox.dir, "item.json"),
      "--hosts",
      join(sandbox.dir, "hosts.json"),
      "--running",
      join(sandbox.dir, "running.json"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("duplicate hostAlias");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

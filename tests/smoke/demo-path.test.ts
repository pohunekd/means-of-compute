// Smoke test of the demo path: the CLI audits a clean branch (D1) and a
// branch with an injected defect (D2) through the loopback stub. Each CLI
// run spawns in-process via Bun.spawn with a per-run verdict dir override
// through the config file, so no real network or model is involved.
// Mutations: run the same recording for both branches; drop the SHA/name
// binding between marker and verdict file.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resetProvidersCache } from "../../src/providers/config.js";
import { startLoopback } from "../../src/providers/loopback.js";
import { makeTempRepo, removeTempRepo, type TempRepo } from "../auditor/temp-repo.js";

const CLI = new URL("../../src/auditor/cli.ts", import.meta.url).pathname;

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

// The smoke repo carries its issues next to the branches, so --issue 99
// resolves without a checked-in fixture.
async function writeIssue(repo: TempRepo): Promise<void> {
  const item = {
    schemaVersion: "v1",
    id: "w9-demo",
    repo: "factory/demo",
    title: "Add two numbers",
    goal: "Sum two numbers",
    issue: 99,
    dod: [{ id: "D1", text: "add returns the sum of its arguments", done: false }],
    dependencies: [],
    status: "review",
    statusReason: null,
    assignedHostAlias: "sandbox",
    branch: "demo-good",
    pullNumber: 99,
    modelRouting: {
      preferredModel: "meta/muse-glimmer-30b",
      attempts: 1,
      fallbackUsed: false,
    },
    retryCount: 1,
    stallRounds: 0,
  };
  await Bun.write(join(repo.dir, "issues", "99.json"), `${JSON.stringify(item)}\n`);
}

async function runCli(repo: TempRepo, ref: string, recordingPort: number): Promise<CliRun> {
  const proc = Bun.spawn(
    [
      "bun",
      CLI,
      "--repo-dir",
      repo.dir,
      "--branch",
      ref,
      "--base",
      "main",
      "--issue",
      "99",
      "--ledger",
      join(repo.dir, "ledger.jsonl"),
      "--authors",
      "flags",
      "--author-model",
      "meta/muse-glimmer-30b",
      "--pull",
      "99",
    ],
    {
      env: {
        ...process.env,
        NVIDIA_API_KEY: "test",
        META_API_KEY: "test",
        LOCAL_MODEL_BASE_URL: "http://localhost:1234/v1",
        PROVIDER_NVIDIA_BUILD_BASE_URL: `http://127.0.0.1:${String(recordingPort)}`,
        PROVIDER_META_API_BASE_URL: `http://127.0.0.1:${String(recordingPort)}`,
        PROVIDER_WONDER_BASE_URL: `http://127.0.0.1:${String(recordingPort)}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("demo path: clean branch gets a clean verdict, defect branch gets a high finding", async () => {
  const repo = await makeTempRepo();
  await writeIssue(repo);
  const verdictBase = await mkdtemp(join(tmpdir(), "audit-smoke-"));
  const configPath = new URL("../../config/auditor.json", import.meta.url).pathname;
  const configBackup = await Bun.file(configPath).text();
  try {
    const config = JSON.parse(configBackup) as { verdictDir: string };
    config.verdictDir = join(verdictBase, "verdicts");
    await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await Bun.$`mkdir -p ${config.verdictDir}`;
    resetProvidersCache();
    const cleanServer = await startLoopback("tests/auditor/recordings/clean.json");
    try {
      const good = await runCli(repo, "demo-good", cleanServer.port);
      expect(good.stderr).toBe("");
      expect(good.code).toBe(0);
      const goodLines = good.stdout.trim().split("\n");
      expect(goodLines[1]).toContain("high=0:medium=0");
      const goodHead = await Bun.$`git -C ${repo.dir} rev-parse demo-good`.text();
      expect(goodLines[1]).toContain(goodHead.trim());
      expect(good.stdout).toContain("No findings.");
    } finally {
      void cleanServer.stop();
    }
    resetProvidersCache();
    const defectServer = await startLoopback("tests/auditor/recordings/defect.json");
    try {
      const bad = await runCli(repo, "demo-bad", defectServer.port);
      expect(bad.stderr).toBe("");
      expect(bad.code).toBe(0);
      const badLines = bad.stdout.trim().split("\n");
      expect(badLines[1]).toContain("high=1:medium=0");
      const badHead = await Bun.$`git -C ${repo.dir} rev-parse demo-bad`.text();
      expect(badLines[1]).toContain(badHead.trim());
      expect(bad.stdout).toMatch(/src\/add\.ts:\d+/);
    } finally {
      void defectServer.stop();
    }
    const verdictFiles = await Array.fromAsync(
      new Bun.Glob("**/*.json").scan({ cwd: join(verdictBase, "verdicts") }),
    );
    expect(verdictFiles).toHaveLength(2);
  } finally {
    await Bun.write(configPath, configBackup.endsWith("\n") ? configBackup : `${configBackup}\n`);
    await rm(verdictBase, { recursive: true, force: true });
    delete process.env.PROVIDER_NVIDIA_BUILD_BASE_URL;
    delete process.env.PROVIDER_META_API_BASE_URL;
    delete process.env.PROVIDER_WONDER_BASE_URL;
    resetProvidersCache();
    removeTempRepo(repo.dir);
  }
});

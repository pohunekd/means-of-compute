import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNumbers, renderNumbers } from "../../src/demo/numbers.js";
import type { BudgetConfig } from "../../src/budget/config.js";
import type { DashboardConfig, Baselines } from "../../src/dashboard/config.js";
import type { NanoPricing } from "../../src/budget/pricing.js";
import type { ProviderClasses } from "../../src/demo/numbers.js";

function makeBudget(): BudgetConfig {
  return {
    statePath: "logs/budget-state.json",
    escalationLogPath: "logs/budget-escalation.jsonl",
    dayCapNanoUsd: 1_000_000_000n,
    totalCapNanoUsd: 10_000_000_000n,
    nvidiaDailyRequestLimit: 100,
    nvidiaProviderId: "nvidia-build",
    unmeasuredAuditCall: { inputTokens: 262144, outputTokens: 65536 },
    unmeasuredMeterCall: { inputTokens: 16777216, outputTokens: 65536 },
  };
}

function makeDashboardConfig(): DashboardConfig {
  const baselines = {
    frontierTokens: {
      label: "Claude Opus",
      inputNanoPer1M: 4_000_000_000n,
      outputNanoPer1M: 20_000_000_000n,
      source: "test",
      asOf: "2026-01-01",
    },
    cloudSandboxHour: {
      label: "cloud",
      nanoPerHour: 360_000_000n,
      source: "test",
      asOf: "2026-01-01",
    },
    ownedHostHour: {
      label: "owned",
      nanoPerHour: 45_000_000n,
      source: "test",
      asOf: "2026-01-01",
    },
  } as Baselines;
  return {
    listenEnv: "MOC_DASHBOARD_LISTEN",
    listenAlias: "dashboard",
    logPath: "logs/dashboard.jsonl",
    maxRequestBytes: 1024,
    idleTimeoutSec: 10,
    workRowLimit: 50,
    baselines,
  };
}

test("demo numbers renders expected fixture", () => {
  const records = [
    {
      schemaVersion: "v1" as const,
      workItemId: "w1-alpha",
      finishedAt: "2026-10-27T10:00:00.000Z",
      result: "success" as const,
      retries: 0,
      humanInterventions: 0,
      attempts: [{ model: "muse-glimmer-30b", result: "success" as const }],
      tokens: [
        {
          provider: "local",
          model: "muse-glimmer-30b",
          inputTokens: 3000,
          outputTokens: 1000,
          requests: 1,
          source: "meter",
        },
        {
          provider: "meta-api",
          model: "muse-spark-1.3-contributor",
          inputTokens: 1000,
          outputTokens: 500,
          requests: 1,
          source: "meter",
        },
      ],
      sessionSeconds: [{ hostAlias: "node-a", seconds: 3600, source: "dispatcher-clock" }],
    },
    {
      schemaVersion: "v1" as const,
      workItemId: "w2-beta",
      finishedAt: "2026-10-27T11:00:00.000Z",
      result: "blocked" as const,
      retries: 1,
      humanInterventions: 1,
      attempts: [
        { model: "muse-spark-1.3-contributor", result: "failure" as const },
        { model: "muse-spark-1.3-contributor", result: "failure" as const },
      ],
      tokens: [
        {
          provider: "meta-api",
          model: "muse-spark-1.3-contributor",
          inputTokens: 2000,
          outputTokens: 500,
          requests: 1,
          source: "meter",
        },
      ],
      sessionSeconds: [{ hostAlias: "node-b", seconds: 1800, source: "dispatcher-clock" }],
    },
  ];

  const pending = [
    {
      entryId: "p1",
      kind: "session" as const,
      workItemId: "w3-gamma",
      finishedAt: "2026-10-27T12:00:00.000Z",
      startModel: "test",
      tokens: [
        {
          provider: "nvidia-build",
          model: "meta/muse-glimmer-30b",
          inputTokens: 100,
          outputTokens: 10,
          requests: 1,
          unmeasuredRequests: 1,
          source: "meter",
        },
      ],
      session: {
        hostAlias: "node-b",
        seconds: 60,
        source: "dispatcher-clock",
        result: "lost" as const,
      },
    },
  ];

  const pricing = new Map<string, NanoPricing>([
    ["local", { inputNanoPer1M: 0n, outputNanoPer1M: 0n }],
    ["nvidia-build", { inputNanoPer1M: 0n, outputNanoPer1M: 0n }],
    ["meta-api", { inputNanoPer1M: 1_000_000_000n, outputNanoPer1M: 2_000_000_000n }],
  ]);

  const classes: ProviderClasses = {
    local: new Set(["local"]),
    cloud: new Set(["meta-api", "meta-wonder", "nvidia-build"]),
  };

  const inputs = {
    ledgerPath: "/tmp/ledger.jsonl",
    ledger: { records, pending } as unknown as import("../../src/ledger/types.js").LedgerContents,
    pricing,
    dashboard: makeDashboardConfig(),
    budget: makeBudget(),
    route: ["nvidia-build", "meta-api"],
    classes,
    now: new Date("2026-10-27T12:00:00.000Z"),
  };

  const numbers = buildNumbers(inputs);
  const output = renderNumbers(numbers);

  const expected = `# Benchmark numbers

Ledger: /tmp/ledger.jsonl (records: 2, unfinalized entries: 1)

| figure | value |
| --- | --- |
| Tasks completed | 1 succeeded, 1 blocked |
| Local token share | 0.5000 local (4,000 of 8,000 tokens) |
| Actual token cost | $0.0050 |
| Frontier-token baseline | $0.0640 |
| Cloud sandbox baseline | $0.5400 |
| Owned compute cost | $0.0675 |
| Human interventions | 1 |
| Retries | 1 |
| Unfinalized entries | 1 (in no figure above) |

## Success rate per model

| model | attempts | successes | rate |
| --- | --- | --- | --- |
| muse-glimmer-30b | 1 | 1 | 1.0000 |
| muse-spark-1.3-contributor | 2 | 0 | 0.0000 |
`;
  expect(output).toBe(expected);

  const outputWithSources = renderNumbers(numbers, true);
  expect(outputWithSources).toContain("local: w1-alpha; cloud: w1-alpha, w2-beta");
  expect(outputWithSources).toContain("config/demo-numbers.json");
  expect(outputWithSources).toContain(
    "config/providers/meta-api.json input $1 per 1M, output $2 per 1M",
  );
  expect(outputWithSources).toContain("rows: w1-alpha, w2-beta");
  expect(outputWithSources).toContain("rows: p1");
  expect(outputWithSources).toContain("w2-beta (1)");
  expect(outputWithSources).toContain("config: none (count, no price)");
});

test("demo numbers reports null token counts", () => {
  const records = [
    {
      schemaVersion: "v1" as const,
      workItemId: "w1-alpha",
      finishedAt: "2026-10-27T10:00:00.000Z",
      result: "success" as const,
      retries: 0,
      humanInterventions: 0,
      attempts: [{ model: "muse-glimmer-30b", result: "success" as const }],
      tokens: [
        {
          provider: "local",
          model: "muse-glimmer-30b",
          inputTokens: 3000,
          outputTokens: 1000,
          requests: 1,
          source: "meter",
        },
        {
          provider: "meta-api",
          model: "muse-spark-1.3-contributor",
          inputTokens: 1000,
          outputTokens: 500,
          requests: 1,
          source: "meter",
        },
      ],
      sessionSeconds: [{ hostAlias: "node-a", seconds: 3600, source: "dispatcher-clock" }],
    },
    {
      schemaVersion: "v1" as const,
      workItemId: "w2-beta",
      finishedAt: "2026-10-27T11:00:00.000Z",
      result: "blocked" as const,
      retries: 1,
      humanInterventions: 1,
      attempts: [
        { model: "muse-spark-1.3-contributor", result: "failure" as const },
        { model: "muse-spark-1.3-contributor", result: "failure" as const },
      ],
      tokens: [
        {
          provider: "meta-api",
          model: "muse-spark-1.3-contributor",
          inputTokens: 2000,
          outputTokens: null,
          requests: 1,
          source: "meter",
        },
      ],
      sessionSeconds: [{ hostAlias: "node-b", seconds: 1800, source: "dispatcher-clock" }],
    },
  ];

  const pricing = new Map<string, NanoPricing>([
    ["local", { inputNanoPer1M: 0n, outputNanoPer1M: 0n }],
    ["meta-api", { inputNanoPer1M: 1_000_000_000n, outputNanoPer1M: 2_000_000_000n }],
  ]);

  const classes: ProviderClasses = {
    local: new Set(["local"]),
    cloud: new Set(["meta-api", "meta-wonder", "nvidia-build"]),
  };

  const inputs = {
    ledgerPath: "/tmp/ledger.jsonl",
    ledger: { records, pending: [] },
    pricing,
    dashboard: makeDashboardConfig(),
    budget: makeBudget(),
    route: ["meta-api"],
    classes,
    now: new Date("2026-10-27T12:00:00.000Z"),
  };

  const numbers = buildNumbers(inputs);
  const output = renderNumbers(numbers);

  // Check that share, actual cost, frontier baseline contain no data message
  const localShareRow = numbers.figures.find((r) => r.label === "Local token share");
  const actualCostRow = numbers.figures.find((r) => r.label === "Actual token cost");
  const frontierRow = numbers.figures.find((r) => r.label === "Frontier-token baseline");
  expect(localShareRow?.cells[0]).toContain("no data (token counts not reported for w2-beta)");
  expect(actualCostRow?.cells[0]).toContain("no data (token counts not reported for w2-beta)");
  expect(frontierRow?.cells[0]).toContain("no data (token counts not reported for w2-beta)");
  expect(output).toContain("no data (token counts not reported for w2-beta)");
});

test("demo cli exits 2 on missing ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-missing-"));
  try {
    const absentPath = join(dir, "absent.jsonl");
    const proc = Bun.spawnSync(["bun", "src/demo/cli.ts", "--ledger", absentPath], {
      cwd: process.cwd(),
    });
    const exitCode = proc.exitCode;
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    expect(exitCode).toBe(2);
    expect(stderr).toContain(`demo:numbers: ledger ${absentPath} is missing`);
    expect(stdout).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

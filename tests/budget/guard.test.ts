// Budget guard tests: unit tests for cost, decision, ledger and escalation,
// plus CLI tests that spawn `bun run budget:check` against a temp config
// and ledger. Deterministic only: synthetic records with UTC finishedAt,
// real contract validation.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageRecord } from "../../contracts/v1/types.js";
import { readUsageLedger } from "../../src/budget/ledger.js";
import { costOfRecord, summarizeSpend } from "../../src/budget/cost.js";
import { decideAdmission } from "../../src/budget/decision.js";
import type { BudgetConfig } from "../../src/budget/config.js";
import { maybeEscalate } from "../../src/budget/escalation.js";
import { loadPricing } from "../../src/budget/pricing.js";

const PRICING = new Map([
  ["meta-api", { inputPer1M: 0.1, cachedInputPer1M: 0.002, outputPer1M: 0.2 }],
  ["nvidia-build", { inputPer1M: 0, outputPer1M: 0 }],
]);

const CONFIG: BudgetConfig = {
  ledgerPath: "logs/usage-ledger.jsonl",
  statePath: "logs/budget-state.json",
  escalationLogPath: "logs/budget-escalations.log",
  dayCapUsd: 12,
  totalCapUsd: 140,
  nvidiaDailyRequestLimit: 1000,
  nvidiaProviderId: "nvidia-build",
};

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    schemaVersion: "v1",
    workItemId: "w1-demo",
    finishedAt: "2026-10-26T10:45:00.000Z",
    tokens: [
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        requests: 2,
        source: "provider-usage",
      },
      {
        provider: "nvidia-build",
        model: "meta/muse-glimmer-30b",
        inputTokens: 12000,
        outputTokens: 3400,
        requests: 14,
        source: "provider-usage",
      },
    ],
    sessionSeconds: [{ hostAlias: "desktop", seconds: 540, source: "dispatcher-clock" }],
    attempts: [{ model: "muse-spark-1.3-contributor", result: "success" }],
    retries: 0,
    humanInterventions: 0,
    result: "success",
    ...overrides,
  };
}

test("cost of a record prices input and output tokens per 1M", () => {
  expect(costOfRecord(record(), PRICING)).toBeCloseTo(0.3, 10);
});

test("cost refuses unknown provider instead of guessing zero", () => {
  const broken = record({
    tokens: [
      {
        provider: "unknown-provider",
        model: "m",
        inputTokens: 10,
        outputTokens: 10,
        requests: 1,
        source: "provider-usage",
      },
    ],
  });
  expect(() => costOfRecord(broken, PRICING)).toThrow('unknown provider "unknown-provider"');
});

test("cost reports spend unknown on null tokens from a priced provider", () => {
  const broken = record({
    workItemId: "w2-nulls",
    tokens: [
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: null,
        outputTokens: 5,
        requests: 7,
        source: "provider-usage",
      },
      {
        provider: "nvidia-build",
        model: "meta/muse-glimmer-30b",
        inputTokens: 10,
        outputTokens: 10,
        requests: 3,
        source: "provider-usage",
      },
    ],
  });
  const summary = summarizeSpend(
    [broken],
    PRICING,
    "nvidia-build",
    new Date("2026-10-26T23:00:00.000Z"),
  );
  expect(summary.unknownWorkItemIds).toEqual(["w2-nulls"]);
  // Request counts are tallied before pricing, so the report stays accurate.
  expect(summary.nvidiaRequestsToday).toBe(3);
  const decision = decideAdmission(summary, CONFIG, { route: ["nvidia-build"] });
  expect(decision.admit).toBe(false);
  expect(decision.reason).toBe("spend unknown");
});

test("day is the UTC calendar day of finishedAt", () => {
  const records = [
    record({ workItemId: "w1-demo", finishedAt: "2026-10-26T23:30:00.000Z" }),
    record({ workItemId: "w2-demo", finishedAt: "2026-10-26T00:30:00.000Z" }),
    record({ workItemId: "w3-demo", finishedAt: "2026-10-25T23:59:00.000Z" }),
  ];
  const summary = summarizeSpend(
    records,
    PRICING,
    "nvidia-build",
    new Date("2026-10-26T12:00:00.000Z"),
  );
  expect(summary.spentTodayUsd).toBeCloseTo(0.6, 10);
  expect(summary.spentTotalUsd).toBeCloseTo(0.9, 10);
  expect(summary.nvidiaRequestsToday).toBe(28);
});

test("D1: spend below both caps admits", () => {
  const summary = summarizeSpend(
    [record()],
    PRICING,
    "nvidia-build",
    new Date("2026-10-26T12:00:00.000Z"),
  );
  const decision = decideAdmission(summary, CONFIG, { route: ["nvidia-build"] });
  expect(decision.admit).toBe(true);
  expect(decision.reason).toBe("within budget");
});

test("D2: spend at the day cap refuses all routes and running sessions finish", () => {
  const big = record({
    tokens: [
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        inputTokens: 40_000_000,
        outputTokens: 40_000_000,
        requests: 20,
        source: "provider-usage",
      },
    ],
  });
  const summary = summarizeSpend(
    [big],
    PRICING,
    "nvidia-build",
    new Date("2026-10-26T12:00:00.000Z"),
  );
  expect(summary.spentTodayUsd).toBeCloseTo(12, 10);
  for (const route of [["nvidia-build"], ["meta-api"], []]) {
    const decision = decideAdmission(summary, CONFIG, { route });
    expect(decision.admit).toBe(false);
    expect(decision.reason).toBe("daily cap reached");
  }
});

test("total cap refuses every new session", () => {
  const summary = summarizeSpend(
    [
      record({ workItemId: "w1-demo", finishedAt: "2026-10-20T10:00:00.000Z" }),
      record({ workItemId: "w2-demo", finishedAt: "2026-10-21T10:00:00.000Z" }),
    ],
    new Map([
      ["meta-api", { inputPer1M: 100, outputPer1M: 100 }],
      ["nvidia-build", { inputPer1M: 0, outputPer1M: 0 }],
    ]),
    "nvidia-build",
    new Date("2026-10-26T12:00:00.000Z"),
  );
  expect(summary.spentTotalUsd).toBeGreaterThanOrEqual(140);
  const decision = decideAdmission(summary, CONFIG, { route: ["meta-api"] });
  expect(decision.admit).toBe(false);
  expect(decision.reason).toBe("total cap reached");
});

test("NVIDIA daily request limit refuses only NVIDIA-led routes", () => {
  const hits: UsageRecord[] = [];
  for (let i = 0; i < 100; i += 1) {
    hits.push(
      record({
        workItemId: `w-nvidia-${String(i)}`,
        finishedAt: "2026-10-26T10:00:00.000Z",
        tokens: [
          {
            provider: "nvidia-build",
            model: "meta/muse-glimmer-30b",
            inputTokens: 10,
            outputTokens: 10,
            requests: 10,
            source: "provider-usage",
          },
        ],
      }),
    );
  }
  const summary = summarizeSpend(
    hits,
    PRICING,
    "nvidia-build",
    new Date("2026-10-26T12:00:00.000Z"),
  );
  expect(summary.nvidiaRequestsToday).toBe(1000);
  const refused = decideAdmission(summary, CONFIG, { route: ["nvidia-build", "meta-api"] });
  expect(refused.admit).toBe(false);
  expect(refused.reason).toBe("NVIDIA Build daily request limit reached");
  const admitted = decideAdmission(summary, CONFIG, { route: ["meta-api"] });
  expect(admitted.admit).toBe(true);
});

test("ledger: missing file means zero spend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-ledger-"));
  try {
    const records = await readUsageLedger(join(dir, "no-such-ledger.jsonl"));
    expect(records).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function expectLedgerError(path: string, fragment: string): Promise<void> {
  let message = "";
  try {
    await readUsageLedger(path);
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain(fragment);
}

test("ledger: a directory exits 2 naming the path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-ledger-"));
  try {
    await expectLedgerError(dir, `Budget ledger ${dir}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger: an unreadable parent directory exits 2 naming the error code", async () => {
  const parent = mkdtempSync(join(tmpdir(), "budget-ledger-"));
  const locked = join(parent, "locked");
  await mkdir(locked, { mode: 0o700 });
  const ledgerPath = join(locked, "ledger.jsonl");
  await Bun.write(ledgerPath, "");
  await chmod(locked, 0o000);
  try {
    await expectLedgerError(ledgerPath, "EACCES");
  } finally {
    await chmod(locked, 0o700);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ledger: a dangling symlink exits 2 naming the path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-ledger-"));
  try {
    const link = join(dir, "ledger.jsonl");
    await symlink(join(dir, "no-such-target.jsonl"), link);
    await expectLedgerError(link, `Budget ledger ${link}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger: invalid line names the line number", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-ledger-"));
  try {
    const path = join(dir, "ledger.jsonl");
    await Bun.write(
      path,
      `${JSON.stringify(record({ workItemId: "w1-demo" }))}\n{"not":"a record"}\n`,
    );
    let message = "";
    try {
      await readUsageLedger(path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("line 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D3: exactly one escalation per cap event across repeated refusals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-escalation-"));
  try {
    const statePath = join(dir, "state.json");
    const logPath = join(dir, "escalations.log");
    const stderr: string[] = [];
    const now = new Date("2026-10-26T12:00:00.000Z");
    const refused = {
      admit: false,
      reason: "daily cap reached",
      spentTodayUsd: 12,
      spentTotalUsd: 12,
      nvidiaRequestsToday: 5,
    } as const;
    expect(
      await maybeEscalate(refused, {
        statePath,
        escalationLogPath: logPath,
        now,
        stderr: (line: string): void => {
          stderr.push(line);
        },
      }),
    ).toBe(true);
    expect(
      await maybeEscalate(refused, {
        statePath,
        escalationLogPath: logPath,
        now,
        stderr: (line: string): void => {
          stderr.push(line);
        },
      }),
    ).toBe(false);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("budget escalation");
    const log = await Bun.file(logPath).text();
    expect(log.trim().split("\n")).toHaveLength(1);
    // Next UTC day is a new event.
    expect(
      await maybeEscalate(refused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-27T00:01:00.000Z"),
        stderr: (line: string): void => {
          stderr.push(line);
        },
      }),
    ).toBe(true);
    expect(stderr).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D3: total cap escalates once across days", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-escalation-"));
  try {
    const statePath = join(dir, "state.json");
    const logPath = join(dir, "escalations.log");
    const stderr: string[] = [];
    const refused = {
      admit: false,
      reason: "total cap reached",
      spentTodayUsd: 1,
      spentTotalUsd: 140,
      nvidiaRequestsToday: 5,
    } as const;
    const push = (line: string): void => {
      stderr.push(line);
    };
    expect(
      await maybeEscalate(refused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-26T12:00:00.000Z"),
        stderr: push,
      }),
    ).toBe(true);
    expect(
      await maybeEscalate(refused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-26T18:00:00.000Z"),
        stderr: push,
      }),
    ).toBe(false);
    // Next UTC day is still the same total-cap event.
    expect(
      await maybeEscalate(refused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-27T00:01:00.000Z"),
        stderr: push,
      }),
    ).toBe(false);
    expect(stderr).toHaveLength(1);
    const log = await Bun.file(logPath).text();
    expect(log.trim().split("\n")).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pricing reads Meta prices from config descriptors", async () => {
  const pricing = await loadPricing();
  const meta = pricing.get("meta-api");
  expect(meta?.inputPer1M).toBe(0.1);
  expect(meta?.outputPer1M).toBe(0.2);
  expect(meta?.cachedInputPer1M).toBe(0.002);
  expect(pricing.get("nvidia-build")?.inputPer1M).toBe(0);
});

interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliSandbox {
  readonly dir: string;
  run(args: readonly string[]): Promise<SpawnResult>;
  writeEntry(entry: UsageRecord): Promise<void>;
}

async function makeCliSandbox(): Promise<CliSandbox> {
  const repoRoot = join(import.meta.dir, "..", "..");
  const dir = mkdtempSync(join(tmpdir(), "budget-cli-"));
  const configDir = join(dir, "config");
  const providersDir = join(configDir, "providers");
  await Bun.write(
    join(configDir, "budget.json"),
    JSON.stringify({
      ledgerPath: join(dir, "ledger.jsonl"),
      statePath: join(dir, "state.json"),
      escalationLogPath: join(dir, "escalations.log"),
      dayCapUsd: 12,
      totalCapUsd: 140,
      nvidiaDailyRequestLimit: 1000,
      nvidiaProviderId: "nvidia-build",
    }),
  );
  for (const name of ["meta-api.json", "nvidia-build.json", "local.json", "route.json"]) {
    const source = Bun.file(join(repoRoot, "config", "providers", name));
    await Bun.write(join(providersDir, name), await source.text());
  }
  const script = join(repoRoot, "src", "budget", "check.ts");
  const run = async (args: readonly string[]): Promise<SpawnResult> => {
    const proc = Bun.spawn(["bun", script, ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };
  return {
    dir,
    run,
    writeEntry: async (entry: UsageRecord): Promise<void> => {
      await Bun.write(join(dir, "ledger.jsonl"), `${JSON.stringify(entry)}\n`);
    },
  };
}

test("CLI: cap flag without --spend exits 2", async () => {
  const sandbox = await makeCliSandbox();
  try {
    const result = await sandbox.run(["--day-cap", "12"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("need --spend");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: empty --spend value exits 2", async () => {
  const sandbox = await makeCliSandbox();
  try {
    for (const args of [
      ["--spend", ""],
      ["--spend", "  "],
    ]) {
      const result = await sandbox.run(args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("needs a non-negative decimal number");
    }
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: override refusal writes no state and prints would-escalate", async () => {
  const sandbox = await makeCliSandbox();
  try {
    const result = await sandbox.run(["--spend", "12.00", "--day-cap", "12"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("refused: daily cap reached");
    expect(result.stderr).toContain("would escalate: day:");
    expect(await Bun.file(join(sandbox.dir, "state.json")).exists()).toBe(false);
    expect(await Bun.file(join(sandbox.dir, "escalations.log")).exists()).toBe(false);
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: ledger over the daily cap refuses once per event", async () => {
  const sandbox = await makeCliSandbox();
  try {
    await sandbox.writeEntry(
      record({
        workItemId: "w1-over",
        finishedAt: new Date().toISOString().replace(/\.\d+Z$/, ".000Z"),
        tokens: [
          {
            provider: "meta-api",
            model: "muse-spark-1.3-contributor",
            inputTokens: 40_000_000,
            outputTokens: 40_000_000,
            requests: 20,
            source: "provider-usage",
          },
        ],
      }),
    );
    const first = await sandbox.run([]);
    expect(first.code).toBe(3);
    expect(first.stdout).toContain("refused: daily cap reached");
    expect(first.stderr).toContain("budget escalation:");
    const logLines = (await Bun.file(join(sandbox.dir, "escalations.log")).text())
      .trim()
      .split("\n");
    expect(logLines).toHaveLength(1);
    const second = await sandbox.run([]);
    expect(second.code).toBe(3);
    expect(second.stderr).not.toContain("budget escalation:");
    const logAgain = (await Bun.file(join(sandbox.dir, "escalations.log")).text())
      .trim()
      .split("\n");
    expect(logAgain).toHaveLength(1);
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

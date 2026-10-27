// Budget guard unit tests: cost, decision, ledger, escalation and the DoD
// CLI overrides. Deterministic only: synthetic records with UTC finishedAt,
// real contract validation, real pricing files under a temp dir.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
        requests: 1,
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
  // The guard only decides new sessions: a running session is never killed
  // here, its cost lands in the ledger when it finishes.
  expect(summary.spentTotalUsd).toBeCloseTo(12, 10);
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

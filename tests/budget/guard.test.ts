// Budget guard tests: unit tests for cost, decision, ledger and escalation,
// plus CLI tests that spawn `bun run budget:check` against a temp config
// and ledger. Deterministic only: synthetic records with UTC finishedAt,
// real contract validation.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageRecord } from "../../contracts/v1/types.js";
import { readLedger } from "../../src/ledger/read.js";
import { costOfRecord, summarizeSpend } from "../../src/budget/cost.js";
import type { BudgetDecision } from "../../src/budget/decision.js";
import { decideAdmission } from "../../src/budget/decision.js";
import type { BudgetConfig } from "../../src/budget/config.js";
import { maybeEscalate } from "../../src/budget/escalation.js";
import { loadDescriptor } from "../../src/budget/pricing.js";

const PRICING = new Map([
  [
    "meta-api",
    {
      inputNanoPer1M: 100_000_000n,
      cachedInputNanoPer1M: 2_000_000n,
      outputNanoPer1M: 200_000_000n,
    },
  ],
  ["nvidia-build", { inputNanoPer1M: 0n, outputNanoPer1M: 0n }],
]);

const CONFIG: BudgetConfig = {
  statePath: "logs/budget-state.json",
  escalationLogPath: "logs/budget-escalations.log",
  dayCapNanoUsd: 12_000_000_000n,
  totalCapNanoUsd: 140_000_000_000n,
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
  expect(costOfRecord(record(), PRICING)).toBe(300_000_000n);
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

test("M8: 120 records of 0.10 USD each refuse exactly at the day cap", () => {
  const records: UsageRecord[] = [];
  for (let i = 0; i < 120; i += 1) {
    records.push(
      record({
        workItemId: `w-cap-${String(i)}`,
        finishedAt: "2026-10-26T10:00:00.000Z",
        tokens: [
          {
            provider: "meta-api",
            model: "muse-spark-1.3-contributor",
            inputTokens: 1_000_000,
            outputTokens: 0,
            requests: 1,
            source: "provider-usage",
          },
        ],
      }),
    );
  }
  const summary = summarizeSpend(
    records,
    PRICING,
    "nvidia-build",
    new Date("2026-10-26T12:00:00.000Z"),
  );
  expect(summary.spentTodayNanoUsd).toBe(12_000_000_000n);
  const decision = decideAdmission(summary, CONFIG, { route: ["meta-api", "nvidia-build"] });
  expect(decision.admit).toBe(false);
  expect(decision.reason).toBe("daily cap reached");
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
  expect(summary.spentTodayNanoUsd).toBe(600_000_000n);
  expect(summary.spentTotalNanoUsd).toBe(900_000_000n);
  expect(summary.nvidiaRequestsToday).toBe(28);
});

test("sub-cent entries accumulate: 160,000,001 + 159,999,999 tokens at 0.0375 refuse", () => {
  const pricing = new Map([["tiny-api", { inputNanoPer1M: 37_500_000n, outputNanoPer1M: 0n }]]);
  const sized = (id: string, inputTokens: number): UsageRecord =>
    record({
      workItemId: id,
      tokens: [
        {
          provider: "tiny-api",
          model: "m",
          inputTokens,
          outputTokens: 0,
          requests: 1,
          source: "provider-usage",
        },
      ],
    });
  const summary = summarizeSpend(
    [sized("w-m11-a", 160_000_001), sized("w-m11-b", 159_999_999)],
    pricing,
    "nvidia-build",
    new Date("2026-10-26T12:00:00.000Z"),
  );
  expect(summary.spentTodayNanoTimes1M).toBe(12_000_000_000_000_000n);
  const decision = decideAdmission(summary, CONFIG, { route: ["tiny-api"] });
  expect(decision.admit).toBe(false);
  expect(decision.reason).toBe("daily cap reached");
});

test("boundary below: one token less than exactly 12.00 USD admits", () => {
  const pricing = new Map([["tiny-api", { inputNanoPer1M: 37_500_000n, outputNanoPer1M: 0n }]]);
  const sized = (id: string, inputTokens: number): UsageRecord =>
    record({
      workItemId: id,
      tokens: [
        {
          provider: "tiny-api",
          model: "m",
          inputTokens,
          outputTokens: 0,
          requests: 1,
          source: "provider-usage",
        },
      ],
    });
  const summary = summarizeSpend(
    [sized("w-m11-c", 160_000_000), sized("w-m11-d", 159_999_999)],
    pricing,
    "nvidia-build",
    new Date("2026-10-26T12:00:00.000Z"),
  );
  const decision = decideAdmission(summary, CONFIG, { route: ["tiny-api"] });
  expect(decision.admit).toBe(true);
  expect(decision.reason).toBe("within budget");
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

test("D2: spend at the day cap refuses all routes", () => {
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
  expect(summary.spentTodayNanoUsd).toBe(12_000_000_000n);
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
      ["meta-api", { inputNanoPer1M: 100_000_000_000n, outputNanoPer1M: 100_000_000_000n }],
      ["nvidia-build", { inputNanoPer1M: 0n, outputNanoPer1M: 0n }],
    ]),
    "nvidia-build",
    new Date("2026-10-26T12:00:00.000Z"),
  );
  expect(summary.spentTotalNanoUsd).toBeGreaterThanOrEqual(140_000_000_000n);
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
    const contents = await readLedger("Budget ledger", join(dir, "no-such-ledger.jsonl"));
    expect(contents).toEqual({ records: [], pending: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function expectLedgerError(path: string, fragment: string): Promise<void> {
  let message = "";
  try {
    await readLedger("Budget ledger", path);
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

test("ledger: a dangling parent symlink exits 2 naming the path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-ledger-"));
  try {
    const parent = join(dir, "data");
    await symlink(join(dir, "no-such-volume"), parent);
    const ledgerPath = join(parent, "ledger.jsonl");
    await expectLedgerError(ledgerPath, `Budget ledger ${ledgerPath}`);
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
      await readLedger("Budget ledger", path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("line 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function refusedDecision(
  reason: string,
  spentTodayUsd: number,
  spentTotalUsd: number,
  nvidiaRequestsToday: number,
): BudgetDecision {
  return { admit: false, reason, spentTodayUsd, spentTotalUsd, nvidiaRequestsToday };
}

test("D3: exactly one escalation per cap event across repeated refusals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-escalation-"));
  try {
    const statePath = join(dir, "state.json");
    const logPath = join(dir, "escalations.log");
    const stderr: string[] = [];
    const now = new Date("2026-10-26T12:00:00.000Z");
    const refused = refusedDecision("daily cap reached", 12, 12, 5);
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

test("D3: interleaved cap events escalate total@D, day@D, total@D+1, total@D+1 -> true, true, false, false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-escalation-"));
  try {
    const statePath = join(dir, "state.json");
    const logPath = join(dir, "escalations.log");
    const stderr: string[] = [];
    const push = (line: string): void => {
      stderr.push(line);
    };
    const totalRefused = refusedDecision("total cap reached", 1, 140, 5);
    const dayRefused = refusedDecision("daily cap reached", 12, 152, 5);
    expect(
      await maybeEscalate(totalRefused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-26T12:00:00.000Z"),
        stderr: push,
      }),
    ).toBe(true);
    expect(
      await maybeEscalate(dayRefused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-26T18:00:00.000Z"),
        stderr: push,
      }),
    ).toBe(true);
    expect(
      await maybeEscalate(totalRefused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-27T00:01:00.000Z"),
        stderr: push,
      }),
    ).toBe(false);
    expect(
      await maybeEscalate(totalRefused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-27T06:00:00.000Z"),
        stderr: push,
      }),
    ).toBe(false);
    expect(stderr).toHaveLength(2);
    const log = await Bun.file(logPath).text();
    expect(log.trim().split("\n")).toHaveLength(2);
    const state = JSON.parse(await Bun.file(statePath).text()) as { escalated: string[] };
    expect(state.escalated).toEqual(["total", "day:2026-10-26"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D3: spend unknown escalates again on the next UTC day", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-escalation-"));
  try {
    const statePath = join(dir, "state.json");
    const logPath = join(dir, "escalations.log");
    const stderr: string[] = [];
    const push = (line: string): void => {
      stderr.push(line);
    };
    const refused = refusedDecision("spend unknown", 0, 0, 0);
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
    expect(
      await maybeEscalate(refused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-27T00:01:00.000Z"),
        stderr: push,
      }),
    ).toBe(true);
    expect(stderr).toHaveLength(2);
    const state = JSON.parse(await Bun.file(statePath).text()) as { escalated: string[] };
    expect(state.escalated).toEqual(["spend-unknown:2026-10-26", "spend-unknown:2026-10-27"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D3: a read-only state file exits 2 with nothing written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-escalation-"));
  try {
    const statePath = join(dir, "state.json");
    const logPath = join(dir, "escalations.log");
    await Bun.write(statePath, '{"escalated":[]}');
    await chmod(statePath, 0o444);
    const refused = refusedDecision("daily cap reached", 12, 12, 5);
    let message = "";
    try {
      await maybeEscalate(refused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-26T12:00:00.000Z"),
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      await chmod(statePath, 0o600);
    }
    expect(message).toContain("not writable");
    expect(await Bun.file(logPath).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D3: a directory as state exits 2 before any log line is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-escalation-"));
  try {
    const statePath = join(dir, "state-dir");
    await mkdir(statePath);
    const logPath = join(dir, "escalations.log");
    const refused = refusedDecision("daily cap reached", 12, 12, 0);
    let message = "";
    try {
      await maybeEscalate(refused, {
        statePath,
        escalationLogPath: logPath,
        now: new Date("2026-10-26T12:00:00.000Z"),
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("not a regular file");
    expect(await Bun.file(logPath).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pricing reads Meta prices by id", async () => {
  const meta = await loadDescriptor("config/providers", "meta-api");
  expect(meta.inputNanoPer1M).toBe(100_000_000n);
  expect(meta.outputNanoPer1M).toBe(200_000_000n);
  expect(meta.cachedInputNanoPer1M).toBe(2_000_000n);
  expect((await loadDescriptor("config/providers", "nvidia-build")).inputNanoPer1M).toBe(0n);
});

test("pricing: stale same-id copy next to the descriptor has no effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-pricing-"));
  try {
    const live = {
      id: "live-api",
      name: "Live",
      baseUrl: "https://live.example",
      model: "muse-glimmer-30b",
      timeoutMs: 10000,
      pricing: { inputPer1M: 1, outputPer1M: 2 },
    };
    const stale = {
      id: "live-api",
      name: "Stale",
      baseUrl: "https://stale.example",
      model: "muse-glimmer-30b",
      timeoutMs: 10000,
      pricing: { inputPer1M: 0, outputPer1M: 0 },
    };
    await Bun.write(join(dir, "live-api.json"), JSON.stringify(live));
    await Bun.write(join(dir, "live-api.stale.json"), JSON.stringify(stale));
    const pricing = await loadDescriptor(dir, "live-api");
    expect(pricing.inputNanoPer1M).toBe(1_000_000_000n);
    expect(pricing.outputNanoPer1M).toBe(2_000_000_000n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pricing: symlink to a shared descriptor is read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-pricing-"));
  const shared = mkdtempSync(join(tmpdir(), "budget-shared-"));
  try {
    const live = {
      id: "linked-api",
      name: "Linked",
      baseUrl: "https://linked.example",
      model: "muse-glimmer-30b",
      timeoutMs: 10000,
      pricing: { inputPer1M: 3, outputPer1M: 4 },
    };
    await Bun.write(join(shared, "shared.json"), JSON.stringify(live));
    symlinkSync(join(shared, "shared.json"), join(dir, "linked-api.json"));
    const pricing = await loadDescriptor(dir, "linked-api");
    expect(pricing.inputNanoPer1M).toBe(3_000_000_000n);
    expect(pricing.outputNanoPer1M).toBe(4_000_000_000n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("pricing: null or array pricing block exits 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-pricing-"));
  try {
    const base = {
      id: "null-api",
      name: "Null",
      baseUrl: "https://null.example",
      model: "muse-glimmer-30b",
      timeoutMs: 10000,
    };
    await Bun.write(join(dir, "null-api.json"), JSON.stringify({ ...base, pricing: null }));
    await Bun.write(
      join(dir, "arr-api.json"),
      JSON.stringify({ ...base, id: "arr-api", pricing: [] }),
    );
    for (const id of ["null-api", "arr-api"]) {
      let message = "";
      try {
        await loadDescriptor(dir, id);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("Budget pricing");
      expect(message).toContain(`${id}.json`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pricing: price key outside pricing does not fill a missing price", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-pricing-"));
  try {
    const descriptor = {
      id: "outer-api",
      name: "Outer",
      baseUrl: "https://outer.example",
      model: "muse-glimmer-30b",
      timeoutMs: 10000,
      pricing: { outputPer1M: 0.2 },
      legacy: { inputPer1M: 0 },
    };
    await Bun.write(join(dir, "outer-api.json"), JSON.stringify(descriptor));
    let message = "";
    try {
      await loadDescriptor(dir, "outer-api");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("outer-api.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pricing: 1e-7 price exits 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-pricing-"));
  try {
    const descriptor = {
      id: "tiny-api",
      name: "Tiny",
      baseUrl: "https://tiny.example",
      model: "muse-glimmer-30b",
      timeoutMs: 10000,
      pricing: { inputPer1M: 1e-7, outputPer1M: 0 },
    };
    await Bun.write(join(dir, "tiny-api.json"), JSON.stringify(descriptor));
    let message = "";
    try {
      await loadDescriptor(dir, "tiny-api");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("tiny-api.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pricing: dangling descriptor symlink exits with an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-pricing-"));
  try {
    symlinkSync(join(dir, "missing.json"), join(dir, "dangling-api.json"));
    let message = "";
    try {
      await loadDescriptor(dir, "dangling-api");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Budget pricing");
    expect(message).toContain("dangling-api.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pricing: descriptor id must match the file name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-pricing-"));
  try {
    const mismatched = {
      id: "other-api",
      name: "Other",
      baseUrl: "https://other.example",
      model: "muse-glimmer-30b",
      timeoutMs: 10000,
      pricing: { inputPer1M: 1, outputPer1M: 2 },
    };
    await Bun.write(join(dir, "claimed-api.json"), JSON.stringify(mismatched));
    let message = "";
    try {
      await loadDescriptor(dir, "claimed-api");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("claimed-api.json");
    expect(message).toContain("does not match file name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliSandbox {
  readonly dir: string;
  run(args: readonly string[], env?: Record<string, string>): Promise<SpawnResult>;
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
      statePath: join(dir, "state.json"),
      escalationLogPath: join(dir, "escalations.log"),
      dayCapUsd: 12,
      totalCapUsd: 140,
      nvidiaDailyRequestLimit: 1000,
      nvidiaProviderId: "nvidia-build",
    }),
  );
  await Bun.write(
    join(configDir, "ledger.json"),
    JSON.stringify({ ledgerPath: join(dir, "ledger.jsonl") }),
  );
  for (const name of [
    "meta-api.json",
    "nvidia-build.json",
    "local.json",
    "route.json",
    "schema.json",
  ]) {
    const source = Bun.file(join(repoRoot, "config", "providers", name));
    await Bun.write(join(providersDir, name), await source.text());
  }
  const script = join(repoRoot, "src", "budget", "check.ts");
  const run = async (
    args: readonly string[],
    extraEnv: Record<string, string> = {},
  ): Promise<SpawnResult> => {
    const proc = Bun.spawn(["bun", script, ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...extraEnv },
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

test("CLI: missing schema exits 2 naming the file", async () => {
  const sandbox = await makeCliSandbox();
  try {
    rmSync(join(sandbox.dir, "config", "providers", "schema.json"));
    const result = await sandbox.run(["--spend", "3.20"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("config/providers/schema.json");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: schema null exits 2 naming the file", async () => {
  const sandbox = await makeCliSandbox();
  try {
    await Bun.write(join(sandbox.dir, "config", "providers", "schema.json"), "null");
    const result = await sandbox.run(["--spend", "3.20"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("config/providers/schema.json");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: invalid schema exits 2 naming the file", async () => {
  const sandbox = await makeCliSandbox();
  try {
    const schema = (await Bun.file(
      join(sandbox.dir, "config", "providers", "schema.json"),
    ).json()) as { properties: { pricing: { type: string } } };
    schema.properties.pricing.type = "objekt";
    await Bun.write(
      join(sandbox.dir, "config", "providers", "schema.json"),
      JSON.stringify(schema),
    );
    const result = await sandbox.run(["--spend", "3.20"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("config/providers/schema.json");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: schema timeoutMs.maximum above the setTimeout limit exits 2 naming the file (mutation: pricing compiles its own schema copy)", async () => {
  const sandbox = await makeCliSandbox();
  try {
    const schemaPath = join(sandbox.dir, "config", "providers", "schema.json");
    const schema = (await Bun.file(schemaPath).json()) as unknown as {
      properties: { timeoutMs: { maximum: number } };
    };
    schema.properties.timeoutMs.maximum = 2147483648;
    await Bun.write(schemaPath, JSON.stringify(schema));
    const result = await sandbox.run(["--spend", "3.20"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("config/providers/schema.json");
    expect(result.stderr).toContain("timeoutMs.maximum");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: invalid MOC_BUDGET_NOW exits 2", async () => {
  const sandbox = await makeCliSandbox();
  try {
    for (const value of ["not-a-date", "2026-10-26T12:00:00.0000Z", "2026-13-40T99:99:99Z"]) {
      const result = await sandbox.run([], { MOC_BUDGET_NOW: value });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("MOC_BUDGET_NOW");
    }
    const rolledOver = await sandbox.run([], { MOC_BUDGET_NOW: "2026-02-30T12:00:00Z" });
    expect(rolledOver.code).toBe(2);
    expect(rolledOver.stderr).toContain("MOC_BUDGET_NOW");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: pinned time prints a stderr line and pins today", async () => {
  const sandbox = await makeCliSandbox();
  const day = "2026-10-26";
  try {
    await sandbox.writeEntry(
      record({
        workItemId: "w1-pinned",
        finishedAt: `${day}T12:00:00.000Z`,
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
    const env = { MOC_BUDGET_NOW: `${day}T23:00:00Z` };
    const result = await sandbox.run([], env);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("refused: daily cap reached");
    expect(result.stderr).toContain(
      `evaluation time pinned by MOC_BUDGET_NOW: ${day}T23:00:00.000Z`,
    );
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: ledger over the daily cap refuses once per event", async () => {
  const sandbox = await makeCliSandbox();
  const day = "2026-10-26";
  try {
    await sandbox.writeEntry(
      record({
        workItemId: "w1-over",
        finishedAt: `${day}T12:00:00.000Z`,
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
    const env = { MOC_BUDGET_NOW: `${day}T23:00:00.000Z` };
    const first = await sandbox.run([], env);
    expect(first.code).toBe(3);
    expect(first.stdout).toContain("refused: daily cap reached");
    expect(first.stderr).toContain("budget escalation:");
    const logLines = (await Bun.file(join(sandbox.dir, "escalations.log")).text())
      .trim()
      .split("\n");
    expect(logLines).toHaveLength(1);
    const second = await sandbox.run([], env);
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

test("CLI: pending meta-api spend counts toward the daily cap", async () => {
  const sandbox = await makeCliSandbox();
  const day = "2026-10-26";
  try {
    const pendingLine = JSON.stringify({
      pending: {
        entryId: "e1-pending",
        kind: "session",
        workItemId: "w1-pending",
        finishedAt: `${day}T12:00:00.000Z`,
        startModel: "muse-spark-1.3-contributor",
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
        session: {
          hostAlias: "desktop",
          seconds: 540,
          source: "dispatcher-clock",
          result: "success",
        },
      },
    });
    await Bun.write(join(sandbox.dir, "ledger.jsonl"), `${pendingLine}\n`);
    const env = { MOC_BUDGET_NOW: `${day}T23:00:00.000Z` };
    const result = await sandbox.run([], env);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("refused: daily cap reached");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: pending nvidia null requests refuses as spend unknown", async () => {
  const sandbox = await makeCliSandbox();
  const day = "2026-10-26";
  try {
    const pendingLine = JSON.stringify({
      pending: {
        entryId: "e1-unknown",
        kind: "session",
        workItemId: "w1-unknown",
        finishedAt: `${day}T12:00:00.000Z`,
        startModel: "meta/muse-glimmer-30b",
        tokens: [
          {
            provider: "nvidia-build",
            model: "meta/muse-glimmer-30b",
            inputTokens: 10,
            outputTokens: 10,
            requests: null,
            source: "dispatcher-usage",
          },
        ],
        session: {
          hostAlias: "desktop",
          seconds: 60,
          source: "dispatcher-clock",
          result: "success",
        },
      },
    });
    await Bun.write(join(sandbox.dir, "ledger.jsonl"), `${pendingLine}\n`);
    const env = { MOC_BUDGET_NOW: `${day}T23:00:00.000Z` };
    const result = await sandbox.run([], env);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("refused: spend unknown");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: typo in nvidiaProviderId exits 2", async () => {
  const sandbox = await makeCliSandbox();
  try {
    const configPath = join(sandbox.dir, "config", "budget.json");
    const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
    config.nvidiaProviderId = "nvidia_build";
    await Bun.write(configPath, JSON.stringify(config));
    const result = await sandbox.run([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("nvidia_build");
    expect(result.stderr).toContain("is not in the route");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test("CLI: missing config file and missing providers dir exit 2", async () => {
  const sandbox = await makeCliSandbox();
  try {
    const configPath = join(sandbox.dir, "config", "budget.json");
    const backup = await Bun.file(configPath).text();
    rmSync(configPath);
    const missing = await sandbox.run([]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Budget config");
    await Bun.write(configPath, backup);
    rmSync(join(sandbox.dir, "config", "providers", "meta-api.json"));
    const noProviders = await sandbox.run([]);
    expect(noProviders.code).toBe(2);
    expect(noProviders.stderr).toContain("Budget pricing");
    expect(noProviders.stderr).toContain("meta-api.json");
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

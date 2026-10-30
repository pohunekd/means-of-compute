// Models panel tests (#115): counts and rate from a synthetic results
// fixture, the empty state for an absent file, and the data error for an
// invalid middle line. No snapshot of the whole page.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultLine } from "../../src/loop/results.js";
import {
  gatherInputs,
  type DashboardSources,
  type FixedInputs,
} from "../../src/dashboard/inputs.js";
import { buildDashboard, modelRowsOf, modelSuccessRate } from "../../src/dashboard/model.js";
import type { BudgetConfig } from "../../src/budget/config.js";
import type { Baselines } from "../../src/dashboard/config.js";

function line(overrides: Partial<ResultLine> & { key: string }): ResultLine {
  return {
    schemaVersion: "v1",
    at: "2026-10-28T10:00:00.000Z",
    workItemId: "w1-demo",
    repo: "example/demo",
    round: 0,
    retry: 0,
    model: "meta/muse-glimmer-30b",
    providerId: "nvidia-build",
    hostAlias: null,
    outcome: "merged",
    routingResult: "success",
    ...overrides,
  };
}

function sources(dir: string): DashboardSources {
  return {
    ledgerPath: join(dir, "ledger.jsonl"),
    verdictDir: join(dir, "verdicts"),
    hostState: null,
    registryPath: join(dir, "registry.json"),
    resultsPath: join(dir, "results.jsonl"),
  };
}

function fixed(): FixedInputs {
  const budget: BudgetConfig = {
    statePath: "logs/budget-state.json",
    escalationLogPath: "logs/budget-escalation.jsonl",
    dayCapNanoUsd: 1_000_000_000n,
    totalCapNanoUsd: 10_000_000_000n,
    nvidiaDailyRequestLimit: 100,
    nvidiaProviderId: "nvidia-build",
  };
  const baselines = {
    frontierTokens: null,
    cloudSandboxHour: null,
    ownedHostHour: null,
  } as Baselines;
  return {
    budget,
    route: [],
    baselines,
    workRowLimit: 50,
    logPath: join("logs", "dashboard.jsonl"),
  };
}

function logged(): { entries: { input: string; code: string; message: string }[] } {
  return { entries: [] };
}

test("models panel counts outcomes per model and sorts by rounds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "models-panel-"));
  try {
    await mkdir(join(dir, "verdicts"), { recursive: true });
    const lines: ResultLine[] = [
      line({ key: "w1-demo:0", workItemId: "w1-demo", round: 0 }),
      line({
        key: "w1-demo:1",
        workItemId: "w1-demo",
        round: 1,
        outcome: "findings",
        routingResult: "failure",
      }),
      line({
        key: "w2-demo:0",
        workItemId: "w2-demo",
        round: 0,
        model: "muse-spark-1.3-contributor",
        providerId: "meta-api",
      }),
      line({
        key: "w2-demo:1",
        workItemId: "w2-demo",
        round: 1,
        model: "muse-spark-1.3-contributor",
        providerId: "meta-api",
        outcome: "ci-timeout",
        routingResult: "excluded",
      }),
      line({
        key: "w2-demo:2",
        workItemId: "w2-demo",
        round: 2,
        model: "muse-spark-1.3-contributor",
        providerId: "meta-api",
        outcome: "lost",
        routingResult: "excluded",
      }),
      line({
        key: "w3-demo:0",
        workItemId: "w3-demo",
        round: 0,
        model: "example/all-excluded-1",
        providerId: "meta-api",
        outcome: "ci-timeout",
        routingResult: "excluded",
      }),
    ];
    await writeFile(
      join(dir, "results.jsonl"),
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const log = logged();
    const inputs = await gatherInputs(
      sources(dir),
      fixed(),
      new Date("2026-10-28T12:00:00.000Z"),
      (entry) => {
        log.entries.push({ input: entry.input, code: entry.code, message: entry.message });
      },
    );
    if (!inputs.results.ok) {
      throw new Error("expected results to read");
    }
    const rows = modelRowsOf(inputs.results.value);
    expect(rows.map((row) => row.model)).toEqual([
      "muse-spark-1.3-contributor",
      "meta/muse-glimmer-30b",
      "example/all-excluded-1",
    ]);
    const spark = rows[0];
    const glimmer = rows[1];
    const excludedOnly = rows[2];
    if (spark === undefined || glimmer === undefined || excludedOnly === undefined) {
      throw new Error("expected three model rows");
    }
    expect(spark.rounds).toBe(3);
    expect(spark.successes).toBe(1);
    expect(spark.failures).toBe(0);
    expect(spark.excluded).toBe(2);
    expect(modelSuccessRate(spark)).toBe("1.0000");
    expect(glimmer.rounds).toBe(2);
    expect(glimmer.successes).toBe(1);
    expect(glimmer.failures).toBe(1);
    expect(glimmer.excluded).toBe(0);
    expect(modelSuccessRate(glimmer)).toBe("0.5000");
    expect(excludedOnly.rounds).toBe(1);
    expect(excludedOnly.successes).toBe(0);
    expect(excludedOnly.failures).toBe(0);
    expect(excludedOnly.excluded).toBe(1);
    expect(modelSuccessRate(excludedOnly)).toBeNull();
    const model = buildDashboard(inputs);
    const panel = model.panels.find((candidate) => candidate.id === "models");
    if (panel === undefined) {
      throw new Error("expected a models panel");
    }
    expect(panel.tables).toHaveLength(1);
    const table = panel.tables[0];
    if (table === undefined) {
      throw new Error("expected a models table");
    }
    expect(table.caption).toBe("Models");
    expect(table.columns).toEqual([
      "model",
      "rounds",
      "successes",
      "failures",
      "excluded",
      "success rate",
    ]);
    expect(table.rows).toHaveLength(3);
    expect(table.note).toBeNull();
    const cellTexts = (index: number): readonly string[] => {
      const row = table.rows[index];
      if (row === undefined) {
        throw new Error(`expected table row ${String(index)}`);
      }
      return row.map((cell) => {
        if (cell.kind === "text") {
          return cell.text;
        }
        throw new Error(`expected a text cell in row ${String(index)}`);
      });
    };
    expect(cellTexts(0)).toEqual(["muse-spark-1.3-contributor", "3", "1", "0", "2", "1.0000"]);
    expect(cellTexts(1)).toEqual(["meta/muse-glimmer-30b", "2", "1", "1", "0", "0.5000"]);
    expect(cellTexts(2)).toEqual(["example/all-excluded-1", "1", "0", "0", "1", "n/a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("models panel shows an explicit empty state for an absent file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "models-panel-"));
  try {
    await mkdir(join(dir, "verdicts"), { recursive: true });
    const log = logged();
    const inputs = await gatherInputs(
      sources(dir),
      fixed(),
      new Date("2026-10-28T12:00:00.000Z"),
      (entry) => {
        log.entries.push({ input: entry.input, code: entry.code, message: entry.message });
      },
    );
    expect(inputs.results.ok).toBe(true);
    const model = buildDashboard(inputs);
    const panel = model.panels.find((candidate) => candidate.id === "models");
    if (panel === undefined) {
      throw new Error("expected a models panel");
    }
    const table = panel.tables[0];
    if (table === undefined) {
      throw new Error("expected a models table");
    }
    expect(table.rows).toEqual([]);
    expect(table.note).toBe("no closed rounds yet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("models panel reports an invalid middle line as a data error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "models-panel-"));
  try {
    await mkdir(join(dir, "verdicts"), { recursive: true });
    const good = line({ key: "w1-demo:0", workItemId: "w1-demo", round: 0 });
    await writeFile(
      join(dir, "results.jsonl"),
      `${JSON.stringify(good)}\nnot json\n${JSON.stringify(good).replace("w1-demo:0", "w1-demo:1")}`,
    );
    const log = logged();
    const inputs = await gatherInputs(
      sources(dir),
      fixed(),
      new Date("2026-10-28T12:00:00.000Z"),
      (entry) => {
        log.entries.push({ input: entry.input, code: entry.code, message: entry.message });
      },
    );
    expect(inputs.results.ok).toBe(false);
    if (inputs.results.ok) {
      throw new Error("expected results to fail");
    }
    expect(inputs.results.failure).toEqual({ kind: "error", code: "results-invalid" });
    expect(
      log.entries.some((entry) => entry.input === "results" && entry.code === "results-invalid"),
    ).toBe(true);
    const model = buildDashboard(inputs);
    const panel = model.panels.find((candidate) => candidate.id === "models");
    if (panel === undefined) {
      throw new Error("expected a models panel");
    }
    const table = panel.tables[0];
    if (table === undefined) {
      throw new Error("expected a models table");
    }
    expect(table.rows).toHaveLength(1);
    expect(table.note).toBeNull();
    const row = table.rows[0];
    if (row === undefined) {
      throw new Error("expected one error row");
    }
    expect(row).toHaveLength(6);
    for (const cell of row) {
      expect(cell).toEqual({ kind: "error", code: "results-invalid" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

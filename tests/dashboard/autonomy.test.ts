// Autonomy panel tests: the per-model ledger table counts sessions and shows
// no rate, so the Models success rate is the only rate on the page, and
// Parked tasks names the unread work store instead of inventing a count.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetConfig } from "../../src/budget/config.js";
import type { Baselines } from "../../src/dashboard/config.js";
import { gatherInputs, type DashboardInputs } from "../../src/dashboard/inputs.js";
import { buildDashboard, type Panel } from "../../src/dashboard/model.js";
import { appendPending, finalizeUsage } from "../../src/ledger/store.js";

const GLIMMER = "meta/muse-glimmer-30b";

async function sessionEntry(
  ledgerPath: string,
  entryId: string,
  result: "success" | "failure",
): Promise<void> {
  await appendPending(ledgerPath, {
    entryId,
    kind: "session",
    workItemId: "w1-demo",
    finishedAt: "2026-10-28T10:40:00.000Z",
    startModel: GLIMMER,
    tokens: [
      {
        provider: "nvidia-build",
        model: GLIMMER,
        inputTokens: 1000,
        outputTokens: 500,
        requests: 2,
        source: "provider-usage",
      },
    ],
    session: { hostAlias: "desktop", seconds: 540, source: "dispatcher-clock", result },
  });
}

async function inputsWithTwoSessions(dir: string): Promise<DashboardInputs> {
  const ledgerPath = join(dir, "ledger.jsonl");
  await sessionEntry(ledgerPath, "e1-session", "failure");
  await sessionEntry(ledgerPath, "e2-session", "success");
  await finalizeUsage(ledgerPath, {
    workItemId: "w1-demo",
    result: "success",
    retries: 1,
    humanInterventions: 0,
  });
  const budget: BudgetConfig = {
    statePath: "logs/budget-state.json",
    escalationLogPath: "logs/budget-escalation.jsonl",
    dayCapNanoUsd: 1_000_000_000n,
    totalCapNanoUsd: 10_000_000_000n,
    nvidiaDailyRequestLimit: 100,
    nvidiaProviderId: "nvidia-build",
    unmeasuredAuditCall: { inputTokens: 262144, outputTokens: 65536 },
    unmeasuredMeterCall: { inputTokens: 16777216, outputTokens: 65536 },
  };
  const baselines: Baselines = {
    frontierTokens: null,
    cloudSandboxHour: null,
    ownedHostHour: null,
  };
  return gatherInputs(
    {
      ledgerPath,
      verdictDir: join(dir, "verdicts"),
      hostState: null,
      registryPath: join(dir, "registry.json"),
      resultsPath: join(dir, "results.jsonl"),
    },
    {
      budget,
      route: ["nvidia-build"],
      baselines,
      workRowLimit: 50,
      logPath: join(dir, "dashboard.jsonl"),
    },
    new Date("2026-10-28T12:00:00.000Z"),
    (entry) => {
      throw new Error(`unexpected input error ${entry.input} ${entry.code}`);
    },
  );
}

function autonomyOf(panels: readonly Panel[]): Panel {
  const panel = panels.find((candidate) => candidate.id === "autonomy");
  if (panel === undefined) {
    throw new Error("expected an autonomy panel");
  }
  return panel;
}

test("the autonomy table counts sessions per model and the only rate column is in Models", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-panel-"));
  try {
    const model = buildDashboard(await inputsWithTwoSessions(dir));
    expect(autonomyOf(model.panels).tables).toEqual([
      {
        caption: "Sessions per model (finished tasks)",
        columns: ["model", "sessions", "ended ok"],
        rows: [
          [
            { kind: "text", text: GLIMMER },
            { kind: "text", text: "2" },
            { kind: "text", text: "1" },
          ],
        ],
        source:
          "ledger records attempts[], one per dispatcher session entry, ledgered start rejections included; ended ok: attempt result success (docs/ledger.md)",
        note: null,
      },
    ]);
    const rateColumns = model.panels.flatMap((panel) =>
      panel.tables.flatMap((table) =>
        table.columns.filter((column) => column.includes("rate")).map(() => panel.id),
      ),
    );
    expect(rateColumns).toEqual(["models"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parked tasks names the unread work store when no work items are wired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-panel-"));
  try {
    const model = buildDashboard(await inputsWithTwoSessions(dir));
    const parked = autonomyOf(model.panels).figures.find(
      (figure) => figure.label === "Parked tasks",
    );
    expect(parked).toEqual({
      label: "Parked tasks",
      cell: { kind: "no-data", reason: "work store not wired" },
      source: "work items with status parked (work store, storePath of config/work.json)",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Autonomy panel tests: the per-model ledger table counts sessions and shows
// no rate, so the Models success rate is the only rate on the page; Parked
// tasks and the Work status of a parked item come from one work store read.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

type InputLog = Parameters<typeof gatherInputs>[3];

const failOnInputError: InputLog = (entry) => {
  throw new Error(`unexpected input error ${entry.input} ${entry.code}`);
};

async function inputsWithTwoSessions(
  dir: string,
  log: InputLog = failOnInputError,
): Promise<DashboardInputs> {
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
      workStorePath: join(dir, "work-items.json"),
    },
    {
      budget,
      route: ["nvidia-build"],
      baselines,
      workRowLimit: 50,
      logPath: join(dir, "dashboard.jsonl"),
    },
    new Date("2026-10-28T12:00:00.000Z"),
    log,
  );
}

function fixtureItem(name: string, id: string): Record<string, unknown> {
  const item = JSON.parse(
    readFileSync(join("contracts", "v1", "fixtures", name), "utf8"),
  ) as Record<string, unknown>;
  return { ...item, id, dependencies: [] };
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

test("parked tasks shows no data when the work store file is absent", async () => {
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

test("a parked work store item counts in Parked tasks and shows its reason in Work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-panel-"));
  try {
    writeFileSync(
      join(dir, "work-items.json"),
      JSON.stringify({
        schemaVersion: "v1",
        revision: 2,
        items: [
          { ...fixtureItem("work-item.json", "w1-demo"), status: "done" },
          fixtureItem("work-item-parked.json", "w2-parked"),
        ],
        submissions: [],
      }),
    );
    const model = buildDashboard(await inputsWithTwoSessions(dir));
    const parked = autonomyOf(model.panels).figures.find(
      (figure) => figure.label === "Parked tasks",
    );
    expect(parked?.cell).toEqual({ kind: "text", text: "1" });
    const work = model.panels.find((panel) => panel.id === "work")?.tables[0];
    expect(work?.rows.map((row) => [row[0], row[1]])).toEqual([
      [
        { kind: "text", text: "w1-demo" },
        { kind: "text", text: "done" },
      ],
      [
        { kind: "text", text: "w2-parked" },
        { kind: "text", text: "parked (no newly met DoD item for 3 rounds)" },
      ],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid work store is a logged input error on Parked tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-panel-"));
  try {
    writeFileSync(join(dir, "work-items.json"), JSON.stringify({ items: [] }));
    const logged: string[] = [];
    const model = buildDashboard(
      await inputsWithTwoSessions(dir, (entry) => {
        logged.push(`${entry.input} ${entry.code}`);
      }),
    );
    const parked = autonomyOf(model.panels).figures.find(
      (figure) => figure.label === "Parked tasks",
    );
    expect(parked?.cell).toEqual({ kind: "error", code: "work-store-invalid" });
    expect(logged).toEqual(["work store work-store-invalid"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Savings coverage and figure notes: the token figures cover the records
// with full token counts and name the excluded ones in a note, and every
// qualifier renders as its own element under the value.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherInputs } from "../../src/dashboard/inputs.js";
import { buildDashboard, type Figure } from "../../src/dashboard/model.js";
import { renderDashboard } from "../../src/dashboard/render.js";

const NOW = new Date("2026-10-28T12:00:00.000Z");

function record(
  workItemId: string,
  audit: { inputTokens: number | null; outputTokens: number | null },
  seconds: number,
): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId,
    finishedAt: "2026-10-28T10:00:00.000Z",
    result: "success",
    retries: 0,
    humanInterventions: 0,
    attempts: [{ model: "meta/muse-glimmer-30b", result: "success" }],
    tokens: [
      {
        provider: "nvidia-build",
        model: "meta/muse-glimmer-30b",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        requests: 10,
        source: "meter-proxy",
      },
      {
        provider: "meta-api",
        model: "muse-spark-1.3-contributor",
        ...audit,
        requests: 2,
        source: "auditor-usage",
      },
    ],
    sessionSeconds: [{ hostAlias: "desktop", seconds, source: "dispatcher-clock" }],
  };
}

test("token savings cover the measured records and every qualifier is a note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "savings-panel-"));
  try {
    await mkdir(join(dir, "verdicts"), { recursive: true });
    const lines = [
      record("w1-demo", { inputTokens: 100_000, outputTokens: 10_000 }, 3600),
      record("w2-demo", { inputTokens: null, outputTokens: null }, 1800),
    ];
    await writeFile(
      join(dir, "ledger.jsonl"),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    const inputs = await gatherInputs(
      {
        ledgerPath: join(dir, "ledger.jsonl"),
        verdictDir: join(dir, "verdicts"),
        hostState: null,
        registryPath: join(dir, "registry.json"),
        resultsPath: join(dir, "results.jsonl"),
        workStorePath: join(dir, "work-items.json"),
      },
      {
        budget: {
          statePath: "logs/budget-state.json",
          escalationLogPath: "logs/budget-escalation.jsonl",
          dayCapNanoUsd: 1_000_000_000n,
          totalCapNanoUsd: 10_000_000_000n,
          nvidiaDailyRequestLimit: 100,
          nvidiaProviderId: "nvidia-build",
          unmeasuredAuditCall: { inputTokens: 262144, outputTokens: 65536 },
          unmeasuredMeterCall: { inputTokens: 16777216, outputTokens: 65536 },
        },
        route: ["meta-api"],
        baselines: {
          frontierTokens: {
            label: "frontier",
            inputNanoPer1M: 4_000_000_000n,
            outputNanoPer1M: 20_000_000_000n,
            source: "test",
            asOf: "2026-10-28",
          },
          cloudSandboxHour: {
            label: "cloud",
            nanoPerHour: 360_000_000n,
            source: "test",
            asOf: "2026-10-28",
          },
          ownedHostHour: {
            label: "owned",
            nanoPerHour: 45_000_000n,
            source: "test",
            asOf: "2026-10-28",
          },
        },
        workRowLimit: 50,
        logPath: join("logs", "dashboard.jsonl"),
      },
      NOW,
      () => {
        throw new Error("expected no input error");
      },
    );
    const model = buildDashboard(inputs);
    const figure = (panelId: string, label: string): Figure => {
      const found = model.panels
        .find((panel) => panel.id === panelId)
        ?.figures.find((candidate) => candidate.label === label);
      if (found === undefined) {
        throw new Error(`expected figure ${label}`);
      }
      return found;
    };
    const coverage = "over 1 of 2 records; w2-demo has no token counts";
    const shown = (label: string): readonly [Figure["cell"], string | null] => [
      figure("savings", label).cell,
      figure("savings", label).note,
    ];
    expect(shown("Frontier-token baseline")).toEqual([{ kind: "text", text: "$6.6000" }, coverage]);
    expect(shown("Actual token cost")).toEqual([{ kind: "text", text: "$0.0120" }, coverage]);
    expect(shown("Token savings")).toEqual([{ kind: "text", text: "$6.5880" }, coverage]);
    expect(shown("Compute-hour savings")).toEqual([{ kind: "text", text: "$0.4725" }, null]);
    expect(shown("Total savings")).toEqual([
      { kind: "text", text: "$7.0605" },
      `token savings ${coverage}; compute-hour savings over all 2 records`,
    ]);
    expect(figure("savings", "Frontier-token baseline").source).toStartWith(
      "ledger records with full token counts (input 1,100,000, output 110,000); ",
    );
    const spent = figure("usage", "Spent total");
    expect(spent.cell.kind === "text" && /^\$\d+\.\d{4}$/.test(spent.cell.text)).toBe(true);
    expect(spent.note).toBe("includes the upper bound for unmeasured calls of w2-demo");
    const page = renderDashboard(model);
    expect(page).toContain(
      `<span class="value">$6.6000</span>\n    <p class="note">${coverage}</p>\n    <p class="cite">source: ledger records with full token counts`,
    );
    expect(page).toContain(
      '<p class="note">includes the upper bound for unmeasured calls of w2-demo</p>',
    );
    expect(page).not.toContain("(includes the upper bound");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Placement on the Work row (#229): the dispatcher records the decision a
// start was given on its registry entry, and Work shows it from there with
// the host-reported not-idle detail cut at its colon. An entry recorded
// without one shows no data.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetConfig } from "../../src/budget/config.js";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { Baselines } from "../../src/dashboard/config.js";
import { gatherInputs } from "../../src/dashboard/inputs.js";
import { buildDashboard, type Cell } from "../../src/dashboard/model.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import { readRegistry } from "../../src/dispatcher/registry.js";

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

const DECISION = {
  schemaVersion: "v1",
  workItemId: "w229-place",
  chosenHostAlias: "laptop-b",
  reason:
    "laptop-b is idle, on AC power, no battery, CPU 90% free, memory 60% free, inside its policy window, 0/2 agents running",
  candidates: [
    {
      hostAlias: "desktop",
      score: 0,
      reason:
        "excluded: not idle (power unknown: ENOENT: no such file or directory, open '/sys/class/power_supply/AC/online')",
      excluded: true,
    },
    {
      hostAlias: "laptop-a",
      score: 0.41,
      reason: "idle, on AC power, battery 80%, CPU 50% free, memory 30% free",
      excluded: false,
    },
    {
      hostAlias: "laptop-b",
      score: 0.81,
      reason: "idle, on AC power, no battery, CPU 90% free, memory 60% free",
      excluded: false,
    },
  ],
};

async function startOnce(dir: string): Promise<string> {
  const registryPath = join(dir, "registry.json");
  const dispatcher = createDispatcher({
    port: createMemoryPort().port,
    budget: GATE,
    ledgerPath: join(dir, "ledger.jsonl"),
    config: {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      nonTerminalPauseMs: 0,
      registryPath,
    },
    now: () => new Date("2026-10-28T10:00:00.000Z"),
    sleep: () => Promise.resolve(),
    log: () => undefined,
    settleUsage: () => Promise.resolve(null),
  });
  const item = {
    schemaVersion: "v1",
    id: "w229-place",
    repo: "example/demo",
    title: "Place a demo item",
    goal: "Record why the host was chosen",
    issue: 229,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: {
      preferredModel: "muse-spark-1.3-contributor",
      attempts: 0,
      fallbackUsed: false,
    },
    retryCount: 0,
    stallRounds: 0,
  };
  const outcome = await dispatcher.start(
    item as never,
    DECISION as never,
    { providerId: "meta-api", model: "muse-spark-1.3-contributor" },
    "Do the work.",
  );
  if (outcome.kind !== "started") {
    throw new Error(`expected a started session, got ${outcome.kind}`);
  }
  return registryPath;
}

async function placementOf(dir: string, registryPath: string): Promise<Cell | undefined> {
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
  const inputs = await gatherInputs(
    {
      ledgerPath: join(dir, "ledger.jsonl"),
      verdictDir: join(dir, "verdicts"),
      hostState: null,
      registryPath,
      resultsPath: join(dir, "results.jsonl"),
      workStorePath: join(dir, "work-items.json"),
    },
    { budget, route: ["nvidia-build"], baselines, workRowLimit: 50, logPath: "logs/dash.jsonl" },
    new Date("2026-10-28T12:00:00.000Z"),
    (entry) => {
      throw new Error(`unexpected input error ${entry.input} ${entry.code}`);
    },
  );
  const work = buildDashboard(inputs).panels.find((panel) => panel.id === "work")?.tables[0];
  const column = work?.columns.indexOf("placement") ?? -1;
  return work?.rows.find((row) => row[0]?.kind === "text" && row[0].text === "w229-place")?.[
    column
  ];
}

test("a started round records its placement and Work shows it without the error detail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-placement-"));
  try {
    const registryPath = await startOnce(dir);
    const [entry] = await readRegistry(registryPath);
    expect(entry?.placement).toEqual({ reason: DECISION.reason, candidates: DECISION.candidates });
    expect(await placementOf(dir, registryPath)).toEqual({
      kind: "text",
      text:
        "laptop-b is idle, on AC power, no battery, CPU 90% free, memory 60% free, inside its policy window, 0/2 agents running, score 0.81; " +
        "desktop: excluded: not idle (power unknown); laptop-a: eligible, score 0.41",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a registry entry recorded without a placement shows no data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-placement-"));
  try {
    const registryPath = await startOnce(dir);
    const document = JSON.parse(readFileSync(registryPath, "utf8")) as {
      sessions: Record<string, unknown>[];
    };
    for (const session of document.sessions) {
      delete session["placement"];
    }
    writeFileSync(registryPath, JSON.stringify(document));
    expect(await placementOf(dir, registryPath)).toEqual({
      kind: "no-data",
      reason: "not recorded",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

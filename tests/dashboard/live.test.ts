// Live view tests: three rows covering all audit mutations.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetConfig } from "../../src/budget/config.js";
import type { Baselines, DashboardConfig } from "../../src/dashboard/config.js";
import { gatherInputs, type DashboardInputs } from "../../src/dashboard/inputs.js";
import { buildLive, gatherLiveInputs, type LiveSources } from "../../src/dashboard/live.js";
import { renderLive } from "../../src/dashboard/live-render.js";
import { buildDashboard } from "../../src/dashboard/model.js";
import { startDashboard } from "../../src/dashboard/server.js";

const NOW = new Date("2026-11-03T18:00:00.000Z");

const BUDGET: BudgetConfig = {
  statePath: "logs/budget-state.json",
  escalationLogPath: "logs/budget-escalation.jsonl",
  poolId: "meta",
  pools: [],
  dayCapNanoUsd: 1_000_000_000n,
  totalCapNanoUsd: 10_000_000_000n,
  nvidiaDailyRequestLimit: 100,
  nvidiaProviderId: "nvidia-build",
  unmeasuredAuditCall: { inputTokens: 262144, outputTokens: 65536 },
  unmeasuredMeterCall: { inputTokens: 16777216, outputTokens: 65536 },
};

const BASELINES: Baselines = {
  frontierTokens: null,
  cloudSandboxHour: null,
  ownedHostHour: null,
};

function hostLine(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "host",
    simulated: true,
    atMinute: 0,
    at: "2026-11-03T17:00:00.000Z",
    alias: "desk-001",
    hostKind: "desk",
    site: "hq-floor-2",
    state: "eligible",
    eligible: true,
    excludeReason: null,
    running: 0,
    maxAgents: 2,
    batteryPercent: null,
    task: null,
    ...overrides,
  };
}

function traceText(hosts: readonly Record<string, unknown>[]): string {
  const lines: Record<string, unknown>[] = [
    {
      kind: "header",
      schemaVersion: "sim-trace-v1",
      simulated: true,
      timeline: "fixture-evening",
      seed: 7,
      startAt: "2026-11-03T17:00:00.000Z",
      speed: 60,
      durationMinutes: 240,
      hostCount: hosts.filter((host) => host["atMinute"] === 0).length,
      kinds: [{ kind: "desk", count: hosts.length }],
    },
    ...hosts,
    {
      kind: "event",
      simulated: true,
      atMinute: 30,
      at: "2026-11-03T17:30:00.000Z",
      alias: "desk-001",
      event: "leave",
      text: "desk-001 became idle",
    },
    {
      kind: "placement",
      simulated: true,
      atMinute: 40,
      at: "2026-11-03T17:40:00.000Z",
      workItemId: "sim-w-001",
      chosenHostAlias: "desk-001",
      reason:
        "desk-001 is idle, on AC power, no battery, inside its policy window, 0/2 agents running",
      task: { kind: "code", title: "Fix login" },
      eligibleCount: 1,
      candidates: hosts.length,
    },
    {
      kind: "work-end",
      simulated: true,
      atMinute: 50,
      at: "2026-11-03T17:50:00.000Z",
      workItemId: "sim-w-001",
      hostAlias: "desk-001",
    },
    {
      kind: "summary",
      simulated: true,
      placements: 1,
      chosen: 1,
      unplaced: 0,
      workEnds: 0,
      hostChanges: 0,
    },
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function fixtureTrace(): string {
  return traceText([
    hostLine({}),
    hostLine({ atMinute: 40, at: "2026-11-03T17:40:00.000Z", state: "running", running: 1 }),
    hostLine({
      alias: "laptop-007",
      hostKind: "laptop",
      state: "blocked",
      eligible: false,
      excludeReason: "excluded: battery at 40 percent, at or below the 50 percent floor",
      batteryPercent: 40,
      maxAgents: 1,
    }),
    hostLine({
      alias: "laptop-007",
      hostKind: "laptop",
      atMinute: 40,
      at: "2026-11-03T17:40:00.000Z",
      state: "running",
      running: 1,
      eligible: false,
      excludeReason: "excluded: battery at 40 percent, at or below the 50 percent floor",
      batteryPercent: 40,
      maxAgents: 1,
    }),
    hostLine({ alias: "desk-002" }),
    hostLine({
      alias: "desk-002",
      atMinute: 40,
      at: "2026-11-03T17:40:00.000Z",
      state: "running",
      running: 2,
      maxAgents: 2,
      eligible: false,
      excludeReason: "excluded: at agent limit (2/2)",
    }),
    hostLine({
      alias: "desk-142",
      state: "busy",
      eligible: false,
      excludeReason: "excluded: not idle (user input 0 seconds ago)",
    }),
  ]);
}

function meterLogText(): string {
  const lines: Record<string, unknown>[] = [
    {
      kind: "grant-open",
      at: "2026-11-03T17:48:00.000Z",
      requestId: "w1-real:0",
      workItemId: "w1-real",
      hostAlias: "desktop",
      providerId: "baseten",
      model: "meta-models/muse-spark-open-1026",
    },
    {
      kind: "grant-bind",
      at: "2026-11-03T17:48:00.000Z",
      requestId: "w1-real:0",
      sessionId: "s-real-1",
    },
    {
      kind: "call-start",
      at: "2026-11-03T17:59:01.000Z",
      callId: "c1",
      requestId: "w1-real:0",
      providerId: "baseten",
      model: "meta-models/muse-spark-open-1026",
      stream: false,
    },
    {
      kind: "call-end",
      at: "2026-11-03T17:59:02.000Z",
      callId: "c1",
      requestId: "w1-real:0",
      outcome: "ok",
      billed: true,
      status: 200,
      inputTokens: 84210,
      outputTokens: 1930,
      clientGone: false,
      ms: 2144,
      bytesIn: 100,
      bytesOut: 200,
    },
    {
      kind: "call-start",
      at: "2026-11-03T17:59:03.000Z",
      callId: "c1b",
      requestId: "w1-real:0",
      providerId: "baseten",
      model: "meta-models/muse-spark-open-1026",
      stream: false,
    },
    {
      kind: "call-end",
      at: "2026-11-03T17:59:04.000Z",
      callId: "c1b",
      requestId: "w1-real:0",
      outcome: "ok",
      billed: true,
      status: 200,
      inputTokens: 1000,
      outputTokens: 500,
      clientGone: false,
      ms: 250,
      bytesIn: 100,
      bytesOut: 200,
    },
    {
      kind: "grant-close",
      at: "2026-11-03T17:59:04.000Z",
      requestId: "w1-real:0",
      state: "finished",
    },
    {
      kind: "grant-open",
      at: "2026-11-03T17:45:00.000Z",
      requestId: "w2-audit:0",
      workItemId: "w2-audit",
      hostAlias: "laptop-a",
      providerId: "baseten",
      model: "meta-models/muse-spark-open-1026",
    },
    {
      kind: "call-start",
      at: "2026-11-03T17:45:01.000Z",
      callId: "c2",
      requestId: "w2-audit:0",
      providerId: "baseten",
      model: "meta-models/muse-spark-open-1026",
      stream: false,
    },
    {
      kind: "call-end",
      at: "2026-11-03T17:45:02.000Z",
      callId: "c2",
      requestId: "w2-audit:0",
      outcome: "ok",
      billed: true,
      status: 200,
      inputTokens: 1300000,
      outputTokens: 48000,
      clientGone: false,
      ms: 1500,
      bytesIn: 100,
      bytesOut: 200,
    },
    {
      kind: "grant-close",
      at: "2026-11-03T17:45:02.000Z",
      requestId: "w2-audit:0",
      state: "finished",
    },
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function registryText(): string {
  return JSON.stringify({
    sessions: [
      {
        requestId: "w1-real:0",
        workItemId: "w1-real",
        repo: "example/demo-repo",
        hostAlias: "desktop",
        branch: "feature/w1-real",
        baseRef: "main",
        resume: false,
        model: { providerId: "baseten", model: "meta-models/muse-spark-open-1026" },
        briefSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sessionId: "s-real-1",
        worktree: "/tmp/wt",
        baseCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        startedAt: "2026-11-03T17:48:00.000Z",
        cursor: null,
        unreachableCount: 0,
        lastSeenState: "running",
        lastSeenAt: "2026-11-03T17:59:00.000Z",
        cancelReason: null,
        terminal: null,
        resolvedAt: null,
        revision: 0,
      },
    ],
  });
}

const LONG_GOAL = "A".repeat(300);

function workItemsText(): string {
  return JSON.stringify({
    schemaVersion: "v1",
    revision: 1,
    items: [
      {
        schemaVersion: "v1",
        id: "w1-real",
        repo: "example/demo-repo",
        title: "Real task title",
        goal: LONG_GOAL,
        issue: 42,
        dod: [{ id: "d1", text: "first DoD item", done: false }],
        dependencies: [],
        status: "running",
        statusReason: null,
        assignedHostAlias: "desktop",
        branch: "feature/w1-real",
        pullNumber: 101,
        modelRouting: {
          preferredModel: "meta-models/muse-spark-open-1026",
          attempts: 1,
          fallbackUsed: false,
        },
        retryCount: 1,
        stallRounds: 0,
      },
      {
        schemaVersion: "v1",
        id: "w2-audit",
        repo: "example/demo-repo",
        title: "Report: how this factory built itself (readable version)",
        goal: LONG_GOAL,
        issue: 288,
        dod: [{ id: "d1", text: "do", done: false }],
        dependencies: [],
        status: "running",
        statusReason: null,
        assignedHostAlias: "laptop-a",
        branch: "feature/w2-audit",
        pullNumber: 294,
        modelRouting: {
          preferredModel: "meta/muse-glimmer-30b",
          attempts: 1,
          fallbackUsed: false,
        },
        retryCount: 0,
        stallRounds: 0,
      },
      {
        schemaVersion: "v1",
        id: "w3-kiosk",
        repo: "example/demo-repo",
        title: "Add login fix",
        goal: LONG_GOAL,
        issue: 10,
        dod: [{ id: "d1", text: "do", done: true }],
        dependencies: [],
        status: "done",
        statusReason: null,
        assignedHostAlias: "kiosk-a",
        branch: "feature/w3",
        pullNumber: 11,
        modelRouting: { preferredModel: "muse-spark-open-1026", attempts: 1, fallbackUsed: false },
        retryCount: 0,
        stallRounds: 0,
      },
      {
        schemaVersion: "v1",
        id: "w4-laptopb",
        repo: "example/demo-repo",
        title: "Docs update",
        goal: LONG_GOAL,
        issue: 20,
        dod: [{ id: "d1", text: "do", done: true }],
        dependencies: [],
        status: "done",
        statusReason: null,
        assignedHostAlias: "laptop-b",
        branch: "feature/w4",
        pullNumber: 21,
        modelRouting: { preferredModel: "muse-spark-open-1026", attempts: 1, fallbackUsed: false },
        retryCount: 0,
        stallRounds: 0,
      },
    ],
    submissions: [],
  });
}

function resultsText(): string {
  const lines = [
    {
      schemaVersion: "v1" as const,
      key: "w2-audit:0",
      at: "2026-11-03T17:45:00.000Z",
      workItemId: "w2-audit",
      repo: "example/demo-repo",
      round: 0,
      retry: 0,
      model: "meta/muse-glimmer-30b",
      providerId: "nvidia-build",
      hostAlias: "laptop-a",
      outcome: "findings" as const,
      routingResult: "failure" as const,
    },
    {
      schemaVersion: "v1" as const,
      key: "w1-old:0",
      at: "2026-11-03T17:51:00.000Z",
      workItemId: "w1-old",
      repo: "example/demo-repo",
      round: 0,
      retry: 0,
      model: "meta/muse-glimmer-30b",
      providerId: "nvidia-build",
      hostAlias: "kiosk-a",
      outcome: "merged" as const,
      routingResult: "success" as const,
    },
    {
      schemaVersion: "v1" as const,
      key: "w3-kiosk:0",
      at: "2026-11-03T17:53:00.000Z",
      workItemId: "w3-kiosk",
      repo: "example/demo-repo",
      round: 0,
      retry: 0,
      model: "meta/muse-glimmer-30b",
      providerId: "nvidia-build",
      hostAlias: "kiosk-a",
      outcome: "merged" as const,
      routingResult: "success" as const,
    },
    {
      schemaVersion: "v1" as const,
      key: "w4-laptopb:0",
      at: "2026-11-03T17:55:00.000Z",
      workItemId: "w4-laptopb",
      repo: "example/demo-repo",
      round: 0,
      retry: 0,
      model: "meta/muse-glimmer-30b",
      providerId: "nvidia-build",
      hostAlias: "laptop-b",
      outcome: "merged" as const,
      routingResult: "success" as const,
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function verdictText(counts?: { high: number; medium: number; low: number }): string {
  const c = counts ?? { high: 1, medium: 0, low: 0 };
  return JSON.stringify({
    schemaVersion: "v1",
    workItemId: "w1-real",
    pullNumber: 101,
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repo: "example/demo-repo",
    auditorModel: "meta-api/muse-spark-1.3-contributor",
    authorModels: ["meta-models/muse-spark-open-1026"],
    counts: c,
    findings: [
      { severity: "high", location: "src/a.ts:1", defect: "x", scenario: "s", fixDirection: "f" },
    ],
  });
}

function ledgerText(): string {
  const records = [
    {
      schemaVersion: "v1",
      workItemId: "w1-real",
      finishedAt: "2026-11-03T17:59:00.000Z",
      tokens: [
        {
          provider: "baseten",
          model: "meta-models/muse-spark-open-1026",
          inputTokens: 84210,
          outputTokens: 1930,
          requests: 1,
          source: "meter",
        },
      ],
      sessionSeconds: [{ hostAlias: "desktop", seconds: 120, source: "registry" }],
      attempts: [{ model: "meta-models/muse-spark-open-1026", result: "success" }],
      retries: 0,
      humanInterventions: 0,
      result: "success",
    },
    {
      schemaVersion: "v1",
      workItemId: "w3-kiosk",
      finishedAt: "2026-11-03T17:53:00.000Z",
      tokens: [
        {
          provider: "baseten",
          model: "meta-models/muse-spark-open-1026",
          inputTokens: 1000,
          outputTokens: 500,
          requests: 1,
          source: "meter",
        },
      ],
      sessionSeconds: [{ hostAlias: "kiosk-a", seconds: 120, source: "registry" }],
      attempts: [{ model: "muse-glimmer-30b", result: "success" }],
      retries: 0,
      humanInterventions: 0,
      result: "success",
    },
    {
      schemaVersion: "v1",
      workItemId: "w4-laptopb",
      finishedAt: "2026-11-03T17:55:00.000Z",
      tokens: [
        {
          provider: "baseten",
          model: "meta-models/muse-spark-open-1026",
          inputTokens: 1200,
          outputTokens: 800,
          requests: 1,
          source: "meter",
        },
      ],
      sessionSeconds: [{ hostAlias: "laptop-b", seconds: 120, source: "registry" }],
      attempts: [{ model: "muse-glimmer-30b", result: "success" }],
      retries: 0,
      humanInterventions: 0,
      result: "success",
    },
    {
      schemaVersion: "v1",
      workItemId: "w1-old",
      finishedAt: "2026-11-03T17:51:00.000Z",
      tokens: [
        {
          provider: "baseten",
          model: "meta-models/muse-spark-open-1026",
          inputTokens: 1100,
          outputTokens: 600,
          requests: 1,
          source: "meter",
        },
      ],
      sessionSeconds: [{ hostAlias: "kiosk-a", seconds: 100, source: "registry" }],
      attempts: [{ model: "muse-glimmer-30b", result: "success" }],
      retries: 0,
      humanInterventions: 0,
      result: "success",
    },
  ];
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function writeFixtures(dir: string, trace: string): void {
  const simTracePath = join(dir, "trace.jsonl");
  writeFileSync(simTracePath, trace);
  writeFileSync(join(dir, "meter-usage.jsonl"), meterLogText());
  const probes = [
    {
      source: "host-state",
      ts: "2026-11-03T17:59:41.000Z",
      hostAlias: "desktop",
      kind: "reported",
      cause: null,
    },
    {
      source: "host-state",
      ts: "2026-11-03T17:59:00.000Z",
      hostAlias: "laptop-a",
      kind: "reported",
      cause: null,
    },
    {
      source: "host-state",
      ts: "2026-11-03T17:58:00.000Z",
      hostAlias: "kiosk-a",
      kind: "reported",
      cause: null,
    },
    {
      source: "host-state",
      ts: "2026-11-03T17:58:03.000Z",
      hostAlias: "laptop-b",
      kind: "unavailable",
      cause: "plugin-busy",
    },
  ];
  writeFileSync(
    join(dir, "loop-ports.jsonl"),
    probes.map((p) => JSON.stringify(p)).join("\n") + "\n",
  );
  writeFileSync(join(dir, "registry.json"), registryText());
  writeFileSync(join(dir, "results.jsonl"), resultsText());
  writeFileSync(join(dir, "ledger.jsonl"), ledgerText());
  writeFileSync(join(dir, "work-items.json"), workItemsText());
  const verdictDir = join(dir, "verdicts");
  mkdirSync(verdictDir, { recursive: true });
  for (const { id, sha, counts } of [
    {
      id: "w3-kiosk",
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      counts: { high: 0, medium: 0, low: 0 },
    },
    {
      id: "w4-laptopb",
      sha: "cccccccccccccccccccccccccccccccccccccccc",
      counts: { high: 0, medium: 0, low: 0 },
    },
    {
      id: "w1-old",
      sha: "dddddddddddddddddddddddddddddddddddddddd",
      counts: { high: 0, medium: 0, low: 0 },
    },
    {
      id: "w1-real",
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      counts: { high: 1, medium: 0, low: 0 },
    },
  ] as const) {
    mkdirSync(join(verdictDir, id), { recursive: true });
    writeFileSync(
      join(verdictDir, id, `${sha}.json`),
      JSON.stringify({
        schemaVersion: "v1",
        workItemId: id,
        pullNumber: id === "w1-real" ? 101 : id === "w3-kiosk" ? 11 : id === "w4-laptopb" ? 21 : 9,
        headSha: sha,
        repo: "example/demo-repo",
        auditorModel: "muse-spark-1.3-contributor",
        authorModels: ["meta-models/muse-spark-open-1026"],
        counts,
        findings:
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          counts.high === 0 && counts.medium === 0 && counts.low === 0
            ? []
            : [
                {
                  severity: "high",
                  location: "src/a.ts:1",
                  defect: "x",
                  scenario: "s",
                  fixDirection: "f",
                },
              ],
      }),
    );
  }
  writeFileSync(join(dir, "dashboard.jsonl"), "");
}

interface FixtureDir {
  readonly dir: string;
  readonly sources: LiveSources;
  readonly dashboardSources: Parameters<typeof gatherInputs>[0];
  readonly fixed: Parameters<typeof gatherInputs>[1];
}

function makeFixture(trace: string): FixtureDir {
  const dir = mkdtempSync(join(tmpdir(), "live-view-"));
  writeFixtures(dir, trace);
  return {
    dir,
    sources: {
      simTracePath: join(dir, "trace.jsonl"),
      meterUsagePath: join(dir, "meter-usage.jsonl"),
      portsPath: join(dir, "loop-ports.jsonl"),
    },
    dashboardSources: {
      ledgerPath: join(dir, "ledger.jsonl"),
      verdictDir: join(dir, "verdicts"),
      hostState: null,
      registryPath: join(dir, "registry.json"),
      resultsPath: join(dir, "results.jsonl"),
      workStorePath: join(dir, "work-items.json"),
    },
    fixed: {
      budget: BUDGET,
      route: ["meta-api"],
      baselines: BASELINES,
      workRowLimit: 50,
      logPath: join(dir, "dashboard.jsonl"),
    },
  };
}

async function dashboardInputs(fixture: FixtureDir): Promise<DashboardInputs> {
  return gatherInputs(fixture.dashboardSources, fixture.fixed, NOW, () => {});
}

test("unified fleet uses one tile renderer with markers and flagged logic", async () => {
  const fixture = makeFixture(fixtureTrace());
  try {
    const dashboard = await dashboardInputs(fixture);
    const live = buildLive(await gatherLiveInputs(fixture.sources, dashboard, 60, () => {}), {
      view: "overview",
      t: 60,
      paused: false,
      host: null,
    });
    const page = renderLive(live);
    expect(page).toContain('id="real-work"');
    expect(page).toContain("Real work now");
    expect(page).toContain("what the real machines are doing at this moment");
    expect(page).not.toContain("Real fleet");
    // running card details
    expect(page).toContain("desktop");
    expect(page).toContain("implement");
    expect(page).toContain("Real task title");
    expect(page).toContain("#42");
    expect(page).toContain("PR #101");
    expect(page).toContain("muse-spark-open-1026");
    expect(page).toContain("baseten");
    expect(page).toContain("elapsed");
    expect(page).toContain("85,210");
    expect(page).toContain("2,430");
    expect(page).toContain("$");
    expect(page).toContain("latest call");
    expect(page).toContain("17:59:04");
    expect(page).toContain("2,144");
    // audit card
    expect(page).toContain("laptop-a");
    expect(page).toContain("audit");
    expect(page).toContain("Report: how this factory built itself");
    // idle cards with reason
    expect(page).toContain("kiosk-a");
    expect(page).toContain("laptop-b");
    expect(page).toContain("no work queued");
    expect(page).toContain("person at the desk");
    expect(page).toContain("reported");
    expect(page).toContain("last finished");
    expect(page).toContain("today (UTC):");
    // Just finished strip
    expect(page).toContain('id="just-finished"');
    expect(page).toContain("Just finished");
    expect(page).toContain("w4-laptopb");
    expect(page).toContain("w3-kiosk");
    expect(page).toContain("merged");
    expect(page).toContain("0/0/0");
    expect(page).toContain('class="tile tile-sim');
    expect(page).toContain("REAL");
    expect(page).toContain('<span class="simtag">SIMULATED</span>');
    const live95 = buildLive(await gatherLiveInputs(fixture.sources, dashboard, 95, () => {}), {
      view: "overview",
      t: 95,
      paused: false,
      host: null,
    });
    const page95 = renderLive(live95);
    expect(page95).toContain('class="load">1/1<span class="flag">!</span>');
    if (live.simFleet.kind !== "ok") throw new Error("expected simulated fleet groups");
    const flaggedTile = live.simFleet.value
      .flatMap((g) => g.tiles)
      .find((t) => t.alias === "laptop-007");
    expect(flaggedTile?.flagged).toBe(true);
    const atLimitTile = live.simFleet.value
      .flatMap((g) => g.tiles)
      .find((t) => t.alias === "desk-002");
    expect(atLimitTile?.flagged).toBe(false);
    expect(page).toContain("tile-flagged");
    const live45 = buildLive(await gatherLiveInputs(fixture.sources, dashboard, 45, () => {}), {
      view: "overview",
      t: 45,
      paused: false,
      host: "desk-001",
    });
    if (live45.hostPanel === null || live45.hostPanel.kind !== "sim")
      throw new Error("expected sim host panel for desk-001 at t=45");
    expect(live45.hostPanel.runningTasks).toHaveLength(1);
    expect(live45.hostPanel.runningTasks[0]?.workItemId).toBe("sim-w-001");
    const liveWithHost = buildLive(
      await gatherLiveInputs(fixture.sources, dashboard, 60, () => {}),
      {
        view: "overview",
        t: 60,
        paused: false,
        host: "desk-001",
      },
    );
    if (liveWithHost.hostPanel === null || liveWithHost.hostPanel.kind !== "sim")
      throw new Error("expected sim host panel for desk-001");
    expect(liveWithHost.hostPanel.runningTasks).toHaveLength(0);
    const taskLive = buildLive(await gatherLiveInputs(fixture.sources, dashboard, 45, () => {}), {
      view: "overview",
      t: 45,
      paused: false,
      host: null,
      task: "sim-w-001",
    });
    if (taskLive.taskPanel === null || taskLive.taskPanel.kind !== "sim")
      throw new Error("expected sim task panel for sim-w-001");
    expect(taskLive.taskPanel.task.kind).toBe("code");
    expect(taskLive.taskPanel.task.title).toBe("Fix login");
    expect(taskLive.taskPanel.brief).toBe(
      "Change the code as the ticket describes, run the project checks, and open a pull request for review.",
    );
    const { TASK_BRIEFS } = await import("../../src/dashboard/live.js");
    expect(TASK_BRIEFS.get("research")).toBe(
      "Read the listed sources, compare the options in a short table, and end with a recommendation.",
    );
    expect(taskLive.taskPanel.reason).toBe(
      "desk-001 is idle, on AC power, no battery, inside its policy window, 0/2 agents running",
    );
    expect(taskLive.taskPanel.eligibleCount).toBe(1);
    const taskPage = renderLive(taskLive);
    expect(taskPage).toContain("Fix login");
    expect(taskPage).toContain('href="/?view=overview&amp;t=45&amp;host=desk-001"');
    expect(taskPage).toContain("desk-001 is idle, on AC power");
    const config: DashboardConfig = {
      listenEnv: "MOC_DASHBOARD_LISTEN",
      listenAlias: "dashboard",
      logPath: join(fixture.dir, "dashboard.jsonl"),
      maxRequestBytes: 1024,
      idleTimeoutSec: 10,
      workRowLimit: 50,
      baselines: BASELINES,
    };
    const server = await startDashboard({
      config,
      listen: { host: "127.0.0.1", port: 0 },
      fixed: fixture.fixed,
      sources: fixture.dashboardSources,
      live: fixture.sources,
      now: () => NOW,
      log: () => {},
    });
    try {
      const get = async (path: string): Promise<Response> =>
        fetch(`http://localhost:${String(server.port)}${path}`, {
          headers: { host: `localhost:${String(server.port)}` },
        });
      const t0 = await get("/?view=overview&t=0&task=sim-w-001");
      expect(t0.status).toBe(404);
    } finally {
      await server.stop();
    }
    expect(JSON.stringify(buildDashboard(dashboard))).not.toContain("desk-001");
    expect(JSON.stringify(buildDashboard(dashboard))).not.toContain("sim-w-001");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("tab links keep t and drop selection, pause drops refresh and mid frame preserves host, /live redirects and no live has no overview", async () => {
  const fixture = makeFixture(fixtureTrace());
  const config: DashboardConfig = {
    listenEnv: "MOC_DASHBOARD_LISTEN",
    listenAlias: "dashboard",
    logPath: join(fixture.dir, "dashboard.jsonl"),
    maxRequestBytes: 1024,
    idleTimeoutSec: 10,
    workRowLimit: 50,
    baselines: BASELINES,
  };
  const server = await startDashboard({
    config,
    listen: { host: "127.0.0.1", port: 0 },
    fixed: fixture.fixed,
    sources: fixture.dashboardSources,
    live: fixture.sources,
    now: () => NOW,
    log: () => {},
  });
  try {
    const get = async (
      path: string,
      opts?: { redirect?: RequestInit["redirect"] },
    ): Promise<Response> => {
      const url = `http://localhost:${String(server.port)}${path}`;
      return fetch(url, {
        headers: { host: `localhost:${String(server.port)}` },
        redirect: opts?.redirect ?? "follow",
      });
    };
    const overview = await get("/?view=overview&t=60");
    const overviewBody = await overview.text();
    expect(overviewBody).toContain('class="tab active"');
    expect(overviewBody).toContain('href="/?view=overview&amp;t=60"');
    expect(overviewBody).toContain('href="/?view=fleet&amp;t=60"');
    expect(overviewBody).toContain("host=desk-001");
    const withHostOverview = await get("/?view=overview&t=60&host=desk-001");
    const withHostOverviewBody = await withHostOverview.text();
    const tabHrefMatch = /href="\/\?view=fleet[^"]*"/.exec(withHostOverviewBody);
    expect(tabHrefMatch?.[0]).not.toContain("host=");
    const both = await get("/?view=overview&t=60&host=desk-001&task=sim-w-001");
    const bothBody = await both.text();
    expect(bothBody).toContain("desk-001");
    expect(bothBody).toContain('id="host-panel"');
    expect(bothBody).not.toContain('id="task-panel"');
    const withTask = await get("/?view=overview&t=60&task=sim-w-001");
    const withTaskBody = await withTask.text();
    expect(withTaskBody).toContain('content="5;url=/?view=overview&amp;t=65&amp;task=sim-w-001"');
    expect(withHostOverviewBody).toContain(
      'content="5;url=/?view=overview&amp;t=65&amp;host=desk-001"',
    );
    const paused = await get("/?view=overview&t=60&pause=1");
    const pausedBody = await paused.text();
    expect(pausedBody).not.toContain('http-equiv="refresh"');
    expect(pausedBody).toContain("paused");
    expect(pausedBody).toContain('href="/?view=overview&amp;t=60">resume');
    const withHost = await get("/?view=overview&t=60&host=desk-001");
    const withHostBody = await withHost.text();
    expect(withHostBody).toContain('http-equiv="refresh"');
    expect(withHostBody).toContain("host=desk-001");
    const liveRedirect = await get("/live?t=60", { redirect: "manual" });
    expect(liveRedirect.status).toBe(301);
    expect(liveRedirect.headers.get("location")).toBe("/?t=60");
    const bad = await get("/live?t=abc", { redirect: "manual" });
    expect(bad.status).toBe(404);
    const past = await get("/?view=overview&t=241");
    expect(past.status).toBe(404);
    const unknown = await get("/?view=unknown");
    expect(unknown.status).toBe(404);
    const badHost = await get("/?view=overview&host=Bad_Alias");
    expect(badHost.status).toBe(404);
    const unknownHost = await get("/?view=overview&host=unknown-host-xyz");
    expect(unknownHost.status).toBe(404);
    const badTask = await get("/?view=overview&task=Bad_Task");
    expect(badTask.status).toBe(404);
    expect(await badTask.text()).not.toContain("Bad_Task");
    const unknownTask = await get("/?view=overview&task=unknown-task-xyz");
    expect(unknownTask.status).toBe(404);
    const badCall = await get("/?view=overview&call=badcall");
    expect(badCall.status).toBe(404);
    const unknownCall = await get("/?view=overview&call=2026-11-03T17%3A59%3A02.000Z%7Cunknown-w");
    expect(unknownCall.status).toBe(404);
    const badAudit = await get("/?view=overview&audit=badaudit");
    expect(badAudit.status).toBe(404);
    const malformedAudit = await get("/?view=overview&audit=w1-real%40zz");
    expect(malformedAudit.status).toBe(404);
    const unknownAudit = await get(
      "/?view=overview&audit=w1-real%40ffffffffffffffffffffffffffffffffffffffff",
    );
    expect(unknownAudit.status).toBe(404);
    // M12/M13: meter/audit pattern checks (call and audit) must be 404 for malformed values even with good fixtures
    const badCallPattern = await get("/?view=overview&call=not-a-time%7Cw1-real");
    expect(badCallPattern.status).toBe(404);
    const badAuditPattern = await get("/?view=overview&audit=w1-real%40zz");
    expect(badAuditPattern.status).toBe(404);
    const both2 = await get("/?view=overview&t=60&host=desktop&task=w1-real");
    expect(both2.status).toBe(200);
    expect(await both2.text()).toContain('id="host-panel"');
    {
      const vdir = join(fixture.dir, "verdicts", "w1-real");
      const brokenFile = join(vdir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json");
      const origBroken = readFileSync(brokenFile, "utf8");
      writeFileSync(brokenFile, "{ invalid }");
      const malformedWithBroken = await get("/?view=overview&audit=badaudit");
      expect(malformedWithBroken.status).toBe(404);
      writeFileSync(brokenFile, origBroken);
    }
    {
      const mPath = join(fixture.dir, "meter-usage.jsonl");
      const mOrig = readFileSync(mPath, "utf8");
      writeFileSync(mPath, "{ invalid }");
      const malformedCallBroken = await get("/?view=overview&call=badcall");
      expect(malformedCallBroken.status).toBe(404);
      writeFileSync(mPath, mOrig);
    }
    {
      const taskLiveForLink = buildLive(
        await gatherLiveInputs(fixture.sources, await dashboardInputs(fixture), 60, () => {}),
        {
          view: "overview",
          t: 60,
          paused: false,
          host: null,
          task: "w1-real",
        },
      );
      const taskLinkPage = renderLive(taskLiveForLink);
      expect(taskLinkPage).toContain("audit=w1-real%40");
      expect(taskLinkPage).not.toContain("task=w1-real%40");
    }
    {
      const tLive = buildLive(
        await gatherLiveInputs(fixture.sources, await dashboardInputs(fixture), 60, () => {}),
        {
          view: "overview",
          t: 60,
          paused: false,
          host: null,
          task: "w1-real",
        },
      );
      const tPage = renderLive(tLive);
      expect(tPage).toContain('content="5;url=/?view=overview&amp;t=65&amp;task=w1-real"');
    }
    {
      const missingLive = buildLive(
        await gatherLiveInputs(fixture.sources, await dashboardInputs(fixture), 60, () => {}),
        {
          view: "overview",
          t: 60,
          paused: false,
          host: null,
          task: "w1-real",
        },
      );
      const missingPage = renderLive(missingLive);
      expect(missingPage).toContain("Verdicts:");
    }
    const vPath = join(
      fixture.dir,
      "verdicts",
      "w1-real",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
    );
    const vOrig = readFileSync(vPath, "utf8");
    writeFileSync(vPath, "{ invalid json }");
    const brokenDash = await dashboardInputs(fixture);
    const brokenLive = buildLive(
      await gatherLiveInputs(fixture.sources, brokenDash, 60, () => {}),
      {
        view: "overview",
        t: 60,
        paused: false,
        host: null,
        task: "w1-real",
      },
    );
    const brokenPage = renderLive(brokenLive);
    expect(brokenPage).toContain("Verdicts:</p>");
    expect(brokenPage).toContain("error (");
    expect(brokenPage).toContain("Goal:");
    writeFileSync(vPath, vOrig);
    writeFileSync(join(fixture.dir, "registry.json"), "{ invalid json }");
    const dashBroken = await dashboardInputs(fixture);
    const liveBroken = buildLive(
      await gatherLiveInputs(fixture.sources, dashBroken, 60, () => {}),
      {
        view: "overview",
        t: 60,
        paused: false,
        host: null,
      },
    );
    const pageBroken = renderLive(liveBroken);
    expect(pageBroken).toContain('id="real-work"');
    expect(pageBroken).toContain("error (");
    const brokenPanel = buildLive(
      await gatherLiveInputs(fixture.sources, dashBroken, 60, () => {}),
      {
        view: "overview",
        t: 60,
        paused: false,
        host: "desktop",
      },
    );
    expect(brokenPanel.hostPanel).not.toBeNull();
    const brokenPage2 = renderLive(brokenPanel);
    expect(brokenPage2).toContain("error (");
  } finally {
    await server.stop();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
  const plainFixture = makeFixture(fixtureTrace());
  const plainConfig: DashboardConfig = {
    listenEnv: "MOC_DASHBOARD_LISTEN",
    listenAlias: "dashboard",
    logPath: join(plainFixture.dir, "dashboard.jsonl"),
    maxRequestBytes: 1024,
    idleTimeoutSec: 10,
    workRowLimit: 50,
    baselines: BASELINES,
  };
  const plain = await startDashboard({
    config: plainConfig,
    listen: { host: "127.0.0.1", port: 0 },
    fixed: plainFixture.fixed,
    sources: plainFixture.dashboardSources,
    live: { ...plainFixture.sources, simTracePath: null },
    now: () => NOW,
    log: () => {},
  });
  try {
    const res = await fetch(`http://localhost:${String(plain.port)}/`, {
      headers: { host: `localhost:${String(plain.port)}` },
    });
    const body = await res.text();
    expect(body).not.toContain(">overview<");
    expect(body).not.toContain("simulated");
    const workRes = await fetch(`http://localhost:${String(plain.port)}/?view=work`, {
      headers: { host: `localhost:${String(plain.port)}` },
    });
    const workBody = await workRes.text();
    expect(workBody).not.toContain(">overview<");
    const taskStack = await fetch(`http://localhost:${String(plain.port)}/?task=w1-real`, {
      headers: { host: `localhost:${String(plain.port)}` },
    });
    expect(taskStack.status).toBe(404);
  } finally {
    await plain.stop();
    rmSync(plainFixture.dir, { recursive: true, force: true });
  }
});

test("a call-end joins its start and grant into a priced activity row, and a null token count renders no data", async () => {
  const fixture = makeFixture(fixtureTrace());
  try {
    const dashboard = await dashboardInputs(fixture);
    const live = buildLive(await gatherLiveInputs(fixture.sources, dashboard, 60, () => {}), {
      view: "overview",
      t: 60,
      paused: false,
      host: null,
    });
    if (live.activity.kind !== "ok") throw new Error("expected activity rows");
    // activity now includes 3 rows (w1-real two calls + w2-audit)
    expect(live.activity.value.length).toBeGreaterThanOrEqual(2);
    const priced = live.activity.value.find((row) => row.inputTokens === 84210);
    if (priced === undefined) throw new Error("expected the priced row");
    expect(priced.model).toBe("muse-spark-open-1026");
    expect(priced.providerId).toBe("baseten");
    expect(priced.role).toBe("session");
    expect(priced.workItemId).toBe("w1-real");
    expect(priced.hostAlias).toBe("desktop");
    expect(priced.ms).toBe(2144);
    if (priced.cost.kind !== "text") throw new Error("expected priced cost text");
    expect(priced.cost.text).toMatch(/\$/);
    const page = renderLive(live);
    expect(page).toContain("<td>baseten</td>");
    const callPriced = buildLive(await gatherLiveInputs(fixture.sources, dashboard, 60, () => {}), {
      view: "overview",
      t: 60,
      paused: false,
      host: null,
      call: "2026-11-03T17:59:02.000Z|w1-real",
    });
    if (callPriced.callPanel === null) throw new Error("expected call panel");
    if (callPriced.callPanel.detail.kind !== "ok") throw new Error("expected ok detail");
    expect(callPriced.callPanel.detail.value.model).toBe("muse-spark-open-1026");
    expect(callPriced.callPanel.detail.value.rawModel).toBe("meta-models/muse-spark-open-1026");
    expect(callPriced.callPanel.detail.value.providerId).toBe("baseten");
    const callPage = renderLive(callPriced);
    expect(callPage).toContain("muse-spark-open-1026");
    expect(callPage).toContain("muse-spark-open-1026 (baseten)");
    const realTask = buildLive(await gatherLiveInputs(fixture.sources, dashboard, 60, () => {}), {
      view: "overview",
      t: 60,
      paused: false,
      host: null,
      task: "w1-real",
    });
    if (realTask.taskPanel === null || realTask.taskPanel.kind !== "real")
      throw new Error("expected real task panel");
    const realPage = renderLive(realTask);
    expect(realPage).toContain("…");
    expect(realPage).toContain('title="AAAAAAAAAAAAAAAA');
    expect(realPage).toContain("DoD:</p>");
    expect(realPage).toContain("first DoD item");
    expect(realPage).toContain("muse-spark-open-1026");
    expect(realPage).not.toContain("meta-models/muse-spark-open-1026");
    expect(realPage).toContain("audit=w1-real%40aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const vPath2 = join(
      fixture.dir,
      "verdicts",
      "w1-real",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
    );
    const vOrig2 = readFileSync(vPath2, "utf8");
    writeFileSync(vPath2, verdictText({ high: 0, medium: 0, low: 0 }));
    const dashTampered = await dashboardInputs(fixture);
    const tamperedLive = buildLive(
      await gatherLiveInputs(fixture.sources, dashTampered, 60, () => {}),
      {
        view: "overview",
        t: 60,
        paused: false,
        host: null,
        task: "w1-real",
      },
    );
    const tamperedPage = renderLive(tamperedLive);
    expect(tamperedPage).toContain("invalid (counts disagree)");
    writeFileSync(vPath2, vOrig2);
    const auditLive = buildLive(await gatherLiveInputs(fixture.sources, dashboard, 60, () => {}), {
      view: "overview",
      t: 60,
      paused: false,
      host: null,
      audit: "w1-real@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    if (auditLive.auditPanel === null) throw new Error("expected audit panel");
    const auditPage = renderLive(auditLive);
    expect(auditPage).toContain("high 1 medium 0 low 0");
    expect(auditPage).toContain("Repo: example/demo-repo");
    expect(auditPage).toContain("Auditor: muse-spark-1.3-contributor");
    expect(auditPage).toContain("Authors: muse-spark-open-1026");
    expect(auditPage).toContain('href="https://github.com/example/demo-repo/pull/101"');
    {
      const vOrigRepo = readFileSync(vPath2, "utf8");
      const diffRepo = JSON.parse(vOrigRepo) as Record<string, unknown>;
      diffRepo["repo"] = "other-org/other-repo";
      writeFileSync(vPath2, JSON.stringify(diffRepo));
      const dashDiffRepo = await dashboardInputs(fixture);
      const diffAudit = buildLive(
        await gatherLiveInputs(fixture.sources, dashDiffRepo, 60, () => {}),
        {
          view: "overview",
          t: 60,
          paused: false,
          host: null,
          audit: "w1-real@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      );
      const diffPage = renderLive(diffAudit);
      expect(diffPage).toContain("(repo differs)");
      writeFileSync(vPath2, vOrigRepo);
    }
    expect(realPage).toContain("84,210");
    expect(realPage).toContain("muse-spark-open-1026 (baseten)");
    writeFileSync(join(fixture.dir, "ledger.jsonl"), "{ invalid json }\n");
    const dashBrokenLedger = await dashboardInputs(fixture);
    const ledgerLive = buildLive(
      await gatherLiveInputs(fixture.sources, dashBrokenLedger, 60, () => {}),
      {
        view: "overview",
        t: 60,
        paused: false,
        host: null,
        task: "w1-real",
      },
    );
    const ledgerPage = renderLive(ledgerLive);
    expect(ledgerPage).toContain("Ledger: error (");
    expect((ledgerPage.match(/Ledger: error/g) ?? []).length).toBe(1);
    writeFileSync(join(fixture.dir, "ledger.jsonl"), ledgerText());
    writeFileSync(vPath2, verdictText({ high: 0, medium: 0, low: 0 }));
    const dashTampered2 = await dashboardInputs(fixture);
    const tamperedAudit = buildLive(
      await gatherLiveInputs(fixture.sources, dashTampered2, 60, () => {}),
      {
        view: "overview",
        t: 60,
        paused: false,
        host: null,
        audit: "w1-real@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    );
    const tamperedAuditPage = renderLive(tamperedAudit);
    expect(tamperedAuditPage).toContain("invalid (counts disagree)");
    writeFileSync(vPath2, vOrig2);
    {
      const vOrigBroken = readFileSync(vPath2, "utf8");
      writeFileSync(vPath2, "{ invalid json }");
      const dashBrokenVerdict = await dashboardInputs(fixture);
      const brokenAudit = buildLive(
        await gatherLiveInputs(fixture.sources, dashBrokenVerdict, 60, () => {}),
        {
          view: "overview",
          t: 60,
          paused: false,
          host: null,
          audit: "w1-real@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      );
      const brokenAuditPage = renderLive(brokenAudit);
      expect(brokenAuditPage).toContain("error (");
      writeFileSync(vPath2, vOrigBroken);
    }
    const resultsPath = join(fixture.dir, "results.jsonl");
    const resultsOrig = readFileSync(resultsPath, "utf8");
    writeFileSync(resultsPath, "{ invalid json }\n");
    const dashBrokenResults = await dashboardInputs(fixture);
    const roundsBroken = buildLive(
      await gatherLiveInputs(fixture.sources, dashBrokenResults, 60, () => {}),
      {
        view: "overview",
        t: 60,
        paused: false,
        host: null,
        task: "w1-real",
      },
    );
    const roundsPage = renderLive(roundsBroken);
    expect(roundsPage).toContain("Rounds:");
    expect(roundsPage).toContain("error (");
    writeFileSync(resultsPath, resultsOrig);
    const workConfig: DashboardConfig = {
      listenEnv: "MOC_DASHBOARD_LISTEN",
      listenAlias: "dashboard",
      logPath: join(fixture.dir, "dashboard.jsonl"),
      maxRequestBytes: 1024,
      idleTimeoutSec: 10,
      workRowLimit: 50,
      baselines: BASELINES,
    };
    const workServer = await startDashboard({
      config: workConfig,
      listen: { host: "127.0.0.1", port: 0 },
      fixed: fixture.fixed,
      sources: fixture.dashboardSources,
      live: fixture.sources,
      now: () => NOW,
      log: () => {},
    });
    try {
      const workRes = await fetch(`http://localhost:${String(workServer.port)}/?view=work`, {
        headers: { host: `localhost:${String(workServer.port)}` },
      });
      const workBody = await workRes.text();
      expect(workBody).toContain("task=w1-real");
      expect(workBody).toContain("/?view=overview");
    } finally {
      await workServer.stop();
    }
    const meterPath = join(fixture.dir, "meter-usage.jsonl");
    const meterOrig2 = readFileSync(meterPath, "utf8");
    writeFileSync(meterPath, "{ invalid json }\n");
    const dashBrokenMeter = await dashboardInputs(fixture);
    const brokenMeterLive = buildLive(
      await gatherLiveInputs(fixture.sources, dashBrokenMeter, 60, () => {}),
      {
        view: "overview",
        t: 60,
        paused: false,
        host: null,
        call: "2026-11-03T17:59:02.000Z|w1-real",
      },
    );
    if (brokenMeterLive.callPanel === null) throw new Error("expected broken meter call panel");
    const brokenMeterPage = renderLive(brokenMeterLive);
    expect(brokenMeterPage).toContain("Call 2026-11-03T17:59:02.000Z");
    expect(brokenMeterPage).toContain("error (");
    {
      const start = brokenMeterPage.indexOf('id="call-panel"');
      const panelSlice =
        start === -1 ? brokenMeterPage : brokenMeterPage.slice(start, start + 2000);
      expect(panelSlice).not.toContain("ms");
    }
    const brokenMeterConfig: DashboardConfig = {
      listenEnv: "MOC_DASHBOARD_LISTEN",
      listenAlias: "dashboard",
      logPath: join(fixture.dir, "dashboard.jsonl"),
      maxRequestBytes: 1024,
      idleTimeoutSec: 10,
      workRowLimit: 50,
      baselines: BASELINES,
    };
    const brokenMeterServer = await startDashboard({
      config: brokenMeterConfig,
      listen: { host: "127.0.0.1", port: 0 },
      fixed: fixture.fixed,
      sources: fixture.dashboardSources,
      live: fixture.sources,
      now: () => NOW,
      log: () => {},
    });
    try {
      const badCall2 = await fetch(
        `http://localhost:${String(brokenMeterServer.port)}/?view=overview&call=2026-11-03T18%3A00%3A00.000Z%7Cnosuch`,
        { headers: { host: `localhost:${String(brokenMeterServer.port)}` } },
      );
      expect(badCall2.status).toBe(404);
      const badIdCall = await fetch(
        `http://localhost:${String(brokenMeterServer.port)}/?view=overview&call=2026-11-03T17%3A59%3A02.000Z%7CBad_ID`,
        { headers: { host: `localhost:${String(brokenMeterServer.port)}` } },
      );
      expect(badIdCall.status).toBe(404);
      const pipeCall = await fetch(
        `http://localhost:${String(brokenMeterServer.port)}/?view=overview&call=%7Cnosuch`,
        { headers: { host: `localhost:${String(brokenMeterServer.port)}` } },
      );
      expect(pipeCall.status).toBe(404);
    } finally {
      await brokenMeterServer.stop();
    }
    writeFileSync(meterPath, meterOrig2);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

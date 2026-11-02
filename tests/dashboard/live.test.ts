// Live view tests: the three rows of the live-view issue. Fixture data only:
// a small hand-written sim-trace-v1 file, a fixture meter usage log and a
// recorded probe line, all with synthetic aliases in a temp directory.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetConfig } from "../../src/budget/config.js";
import type { Baselines, DashboardConfig } from "../../src/dashboard/config.js";
import { gatherInputs, type DashboardInputs } from "../../src/dashboard/inputs.js";
import { buildLive, gatherLiveInputs, type LiveSources } from "../../src/dashboard/live.js";
import { LIVE_CSS_HASH, renderLive } from "../../src/dashboard/live-render.js";
import { buildDashboard } from "../../src/dashboard/model.js";
import { CSS_HASH } from "../../src/dashboard/render.js";
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
      task: null,
      eligibleCount: 1,
      candidates: hosts.length,
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

function traceTextLabeled(
  hosts: readonly Record<string, unknown>[],
  placements: readonly Record<string, unknown>[],
): string {
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
    ...placements,
    {
      kind: "summary",
      simulated: true,
      placements: placements.length,
      chosen: placements.length,
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
      at: "2026-11-03T17:59:00.000Z",
      requestId: "w1-demo:0",
      workItemId: "w1-demo",
      hostAlias: "desktop",
      providerId: "meta-api",
      model: "muse-spark-1.3-contributor",
    },
    {
      kind: "call-start",
      at: "2026-11-03T17:59:01.000Z",
      callId: "c1",
      requestId: "w1-demo:0",
      providerId: "meta-api",
      model: "muse-spark-1.3-contributor",
      stream: false,
    },
    {
      kind: "call-end",
      at: "2026-11-03T17:59:02.000Z",
      callId: "c1",
      requestId: "w1-demo:0",
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
      kind: "call-start",
      at: "2026-11-03T17:59:03.000Z",
      callId: "c2",
      requestId: "w1-demo:0",
      providerId: "meta-api",
      model: "muse-spark-1.3-contributor",
      stream: false,
    },
    {
      kind: "call-end",
      at: "2026-11-03T17:59:04.000Z",
      callId: "c2",
      requestId: "w1-demo:0",
      outcome: "no-usage",
      billed: true,
      status: 200,
      inputTokens: null,
      outputTokens: null,
      clientGone: false,
      ms: 90,
      bytesIn: 100,
      bytesOut: 0,
    },
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

interface FixtureDir {
  readonly dir: string;
  readonly sources: LiveSources;
  readonly dashboardSources: Parameters<typeof gatherInputs>[0];
  readonly fixed: Parameters<typeof gatherInputs>[1];
}

function makeFixture(trace: string): FixtureDir {
  const dir = mkdtempSync(join(tmpdir(), "live-view-"));
  const simTracePath = join(dir, "trace.jsonl");
  writeFileSync(simTracePath, trace);
  writeFileSync(join(dir, "meter-usage.jsonl"), meterLogText());
  writeFileSync(
    join(dir, "loop-ports.jsonl"),
    JSON.stringify({
      source: "host-state",
      ts: "2026-11-03T17:58:00.000Z",
      hostAlias: "desktop",
      kind: "reported",
      cause: null,
    }) + "\n",
  );
  return {
    dir,
    sources: {
      simTracePath,
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

test("live renders real and simulated tiles with markers, keeps sim aliases out of buildDashboard, and an invalid sim alias degrades only the sim sections", async () => {
  const fixture = makeFixture(fixtureTrace());
  try {
    const dashboard = await dashboardInputs(fixture);
    const live = buildLive(await gatherLiveInputs(fixture.sources, dashboard, 60, () => {}));
    const page = renderLive(live);
    expect(page).toContain("desk-001");
    expect(page).toContain("laptop-007");
    expect(page).toContain("SIMULATED");
    expect(page).toContain("REAL");
    expect(page).toContain("desktop");
    expect(page).toContain("placed sim-w-001 on desk-001 because desk-001 is idle");
    expect(page).toContain("1 of 4");
    expect(page).toContain("desk-001: running");
    if (live.simFleet.kind !== "ok") {
      throw new Error("expected simulated fleet groups");
    }
    const runningTile = live.simFleet.value
      .flatMap((group) => group.tiles)
      .find((tile) => tile.alias === "desk-001");
    expect(runningTile?.state).toBe("running");
    expect(runningTile?.running).toBe(1);
    const runningCounter = live.counters.find(
      (counter) => counter.label === "Simulated work running",
    );
    expect(runningCounter?.cell).toEqual({ kind: "text", text: "4" });
    const flaggedTile = live.simFleet.value
      .flatMap((group) => group.tiles)
      .find((tile) => tile.alias === "laptop-007");
    expect(flaggedTile?.state).toBe("running");
    expect(flaggedTile?.eligible).toBe(false);
    expect(flaggedTile?.flagged).toBe(true);
    const atLimitTile = live.simFleet.value
      .flatMap((group) => group.tiles)
      .find((tile) => tile.alias === "desk-002");
    expect(atLimitTile?.state).toBe("running");
    expect(atLimitTile?.running).toBe(2);
    expect(atLimitTile?.flagged).toBe(false);
    expect(page).toContain("tile-flagged");
    expect(page).toContain("running, now excluded for a reason other than its agent limit");
    expect(JSON.stringify(buildDashboard(dashboard))).not.toContain("desk-001");
    expect(JSON.stringify(buildDashboard(dashboard))).not.toContain("sim-w-001");

    const broken = makeFixture(
      traceText([
        hostLine({ alias: "Desk_001" }),
        hostLine({ alias: "desk-002" }),
        hostLine({ alias: "desk-003" }),
      ]),
    );
    try {
      const brokenDashboard = await dashboardInputs(broken);
      const brokenPage = renderLive(
        buildLive(await gatherLiveInputs(broken.sources, brokenDashboard, 60, () => {})),
      );
      expect(brokenPage).toContain("error (sim-trace-invalid)");
      expect(brokenPage).not.toContain("Desk_001");
      expect(brokenPage).toContain("desktop");
      expect(brokenPage).toContain("Model activity (real)");
      expect(brokenPage).toContain("muse-spark-1.3-contributor");
    } finally {
      rmSync(broken.dir, { recursive: true, force: true });
    }
    const labeled = makeFixture(
      traceTextLabeled(
        [
          hostLine({}),
          hostLine({
            atMinute: 40,
            at: "2026-11-03T17:40:00.000Z",
            state: "running",
            running: 1,
            task: { kind: "support", title: "Support queue triage 001" },
          }),
          hostLine({ alias: "desk-002" }),
          hostLine({ alias: "desk-003" }),
        ],
        [
          {
            kind: "placement",
            simulated: true,
            atMinute: 40,
            at: "2026-11-03T17:40:00.000Z",
            workItemId: "sim-w-001",
            chosenHostAlias: "desk-001",
            reason:
              "desk-001 is idle, on AC power, no battery, inside its policy window, 0/2 agents running",
            task: { kind: "support", title: "Support queue triage 001" },
            eligibleCount: 1,
            candidates: 3,
          },
          {
            kind: "placement",
            simulated: true,
            atMinute: 41,
            at: "2026-11-03T17:41:00.000Z",
            workItemId: "sim-w-002",
            chosenHostAlias: "desk-002",
            reason:
              "desk-002 is idle, on AC power, no battery, inside its policy window, 0/2 agents running",
            task: null,
            eligibleCount: 1,
            candidates: 3,
          },
        ],
      ),
    );
    try {
      const labeledDashboard = await dashboardInputs(labeled);
      const labeledLive = buildLive(
        await gatherLiveInputs(labeled.sources, labeledDashboard, 60, () => {}),
      );
      const labeledPage = renderLive(labeledLive);
      expect(labeledPage).toContain(
        "support: Support queue triage 001 placed on desk-001 because desk-001 is idle",
      );
      expect(labeledPage).toContain("placed sim-w-002 on desk-002 because desk-002 is idle");
      expect(labeledPage).not.toContain("{n}");
      if (labeledLive.simFleet.kind !== "ok") {
        throw new Error("expected simulated fleet groups");
      }
      const labeledRunning = labeledLive.simFleet.value
        .flatMap((g) => g.tiles)
        .find((t) => t.alias === "desk-001");
      expect(labeledRunning?.detail).toContain("support: Support queue triage 001");
      expect(labeledRunning?.detail.startsWith("support: Support queue triage 001")).toBe(true);
      const invalidTask = makeFixture(
        traceTextLabeled(
          [hostLine({}), hostLine({ alias: "desk-002" })],
          [
            {
              kind: "placement",
              simulated: true,
              atMinute: 40,
              at: "2026-11-03T17:40:00.000Z",
              workItemId: "sim-w-001",
              chosenHostAlias: "desk-001",
              reason: "desk-001 is idle",
              task: { kind: "bogus", title: "Bad" },
              eligibleCount: 1,
              candidates: 1,
            },
          ],
        ),
      );
      try {
        const badTaskDashboard = await dashboardInputs(invalidTask);
        const badTaskLive = buildLive(
          await gatherLiveInputs(invalidTask.sources, badTaskDashboard, 60, () => {}),
        );
        expect(badTaskLive.simFleet.kind).toBe("error");
        if (badTaskLive.simFleet.kind === "error") {
          expect(badTaskLive.simFleet.code).toBe("sim-trace-invalid");
        }
      } finally {
        rmSync(invalidTask.dir, { recursive: true, force: true });
      }
      const missingTask = makeFixture(
        traceTextLabeled(
          [hostLine({}), hostLine({ alias: "desk-002" })],
          [
            {
              kind: "placement",
              simulated: true,
              atMinute: 40,
              at: "2026-11-03T17:40:00.000Z",
              workItemId: "sim-w-001",
              chosenHostAlias: "desk-001",
              reason: "desk-001 is idle",
              eligibleCount: 1,
              candidates: 1,
            },
          ],
        ),
      );
      try {
        const missingDashboard = await dashboardInputs(missingTask);
        const missingLive = buildLive(
          await gatherLiveInputs(missingTask.sources, missingDashboard, 60, () => {}),
        );
        expect(missingLive.simFleet.kind).toBe("error");
        if (missingLive.simFleet.kind === "error") {
          expect(missingLive.simFleet.code).toBe("sim-trace-invalid");
        }
      } finally {
        rmSync(missingTask.dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(labeled.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the /live CSP header matches the live style hash, the page has no script element, a mid-replay frame carries the refresh meta to the next minute and the final frame carries none", async () => {
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
    const get = async (path: string): Promise<Response> =>
      fetch(`http://localhost:${String(server.port)}${path}`, {
        headers: { host: `localhost:${String(server.port)}` },
      });
    const mid = await get("/live?t=60");
    expect(mid.status).toBe(200);
    expect(mid.headers.get("content-security-policy")).toBe(
      `default-src 'none'; style-src '${LIVE_CSS_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    const midBody = await mid.text();
    expect(midBody).not.toContain("<script");
    expect(midBody).toContain('http-equiv="refresh"');
    expect(midBody).toContain('content="5;url=/live?t=65"');
    expect(midBody).toContain('<a href="/live?t=65">next frame</a>');
    const final = await get("/live?t=240");
    const finalBody = await final.text();
    expect(finalBody).not.toContain('http-equiv="refresh"');
    expect(finalBody).not.toContain("<script");
    const root = await get("/");
    expect(root.headers.get("content-security-policy")).toBe(
      `default-src 'none'; style-src '${CSS_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    const noLivePath = await get("/live?t=abc");
    expect(noLivePath.status).toBe(404);
    const pastEnd = await get("/live?t=241");
    expect(pastEnd.status).toBe(404);
    const plain = await startDashboard({
      config,
      listen: { host: "127.0.0.1", port: 0 },
      fixed: fixture.fixed,
      sources: fixture.dashboardSources,
      now: () => NOW,
      log: () => {},
    });
    try {
      const plainRoot = await fetch(`http://localhost:${String(plain.port)}/`, {
        headers: { host: `localhost:${String(plain.port)}` },
      });
      expect(await plainRoot.text()).toBe(await root.text());
    } finally {
      await plain.stop();
    }
  } finally {
    await server.stop();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a call-end joins its start and grant into a priced activity row, and a null token count renders no data", async () => {
  const fixture = makeFixture(fixtureTrace());
  try {
    const dashboard = await dashboardInputs(fixture);
    const live = buildLive(await gatherLiveInputs(fixture.sources, dashboard, 60, () => {}));
    if (live.activity.kind !== "ok") {
      throw new Error("expected activity rows");
    }
    expect(live.activity.value).toHaveLength(2);
    const priced = live.activity.value.find((row) => row.inputTokens === 1000);
    if (priced === undefined) {
      throw new Error("expected the priced row");
    }
    expect(priced.model).toBe("muse-spark-1.3-contributor");
    expect(priced.providerId).toBe("meta-api");
    expect(priced.role).toBe("session");
    expect(priced.workItemId).toBe("w1-demo");
    expect(priced.hostAlias).toBe("desktop");
    expect(priced.ms).toBe(250);
    expect(priced.cost).toEqual({ kind: "text", text: "$0.0002" });
    const unmeasured = live.activity.value.find((row) => row.inputTokens === null);
    if (unmeasured === undefined) {
      throw new Error("expected the unmeasured row");
    }
    expect(unmeasured.cost).toEqual({ kind: "no-data", reason: "usage not reported" });
    const page = renderLive(live);
    expect(page).toContain("$0.0002");
    expect(page).toContain('title="usage not reported">no data</td>');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

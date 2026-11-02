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
      task: null,
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
      at: "2026-11-03T17:59:00.000Z",
      requestId: "w1-demo:0",
      workItemId: "w1-demo",
      hostAlias: "desktop",
      providerId: "meta-api",
      model: "meta-models/muse-spark-open-1026",
    },
    {
      kind: "call-start",
      at: "2026-11-03T17:59:01.000Z",
      callId: "c1",
      requestId: "w1-demo:0",
      providerId: "meta-api",
      model: "meta-models/muse-spark-open-1026",
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
      model: "meta-models/muse-spark-open-1026",
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
    // Real and simulated tiles share one renderer: same tile class, different markers.
    expect(page).toContain('class="tile tile-real');
    expect(page).toContain('class="tile tile-sim');
    expect(page).toContain("REAL");
    expect(page).toContain('<span class="simtag">SIMULATED</span>');
    // Fleet order: real group first.
    expect(page.indexOf("Real fleet")).toBeLessThan(
      page.indexOf('<span class="simtag">SIMULATED</span>'),
    );
    // Flagged logic: running while excluded for non-agent-limit shows flagged.
    if (live.simFleet.kind !== "ok") {
      throw new Error("expected simulated fleet groups");
    }
    const flaggedTile = live.simFleet.value
      .flatMap((group) => group.tiles)
      .find((tile) => tile.alias === "laptop-007");
    expect(flaggedTile?.flagged).toBe(true);
    const atLimitTile = live.simFleet.value
      .flatMap((group) => group.tiles)
      .find((tile) => tile.alias === "desk-002");
    expect(atLimitTile?.flagged).toBe(false);
    expect(page).toContain("tile-flagged");
    // Simulated running tasks must exclude work that ended before t (work-end at 50 excludes sim-w-001 at t=60).
    const liveWithHost = buildLive(
      await gatherLiveInputs(fixture.sources, dashboard, 60, () => {}),
      {
        view: "overview",
        t: 60,
        paused: false,
        host: "desk-001",
      },
    );
    if (liveWithHost.hostPanel === null || liveWithHost.hostPanel.kind !== "sim") {
      throw new Error("expected sim host panel for desk-001");
    }
    expect(liveWithHost.hostPanel.runningTasks).toHaveLength(0);
    // Sim aliases never leak into buildDashboard.
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
    // Tab links: overview view should have tabs and keep t, dropping host.
    const overview = await get("/?view=overview&t=60");
    const overviewBody = await overview.text();
    expect(overviewBody).toContain('class="tab active"');
    expect(overviewBody).toContain('href="/?view=overview&amp;t=60"');
    expect(overviewBody).toContain('href="/?view=fleet&amp;t=60"');
    // Tile link sets host, keeping view and t.
    expect(overviewBody).toContain("host=desk-001");
    // Tab links must NOT keep host: when host is selected, tabs drop it.
    const withHostOverview = await get("/?view=overview&t=60&host=desk-001");
    const withHostOverviewBody = await withHostOverview.text();
    // Tabs on host page should not contain host param
    const tabHrefMatch = /href="\/\?view=fleet[^"]*"/.exec(withHostOverviewBody);
    expect(tabHrefMatch?.[0]).not.toContain("host=");
    // Exact refresh must preserve host and advance to t=65
    expect(withHostOverviewBody).toContain(
      'content="5;url=/?view=overview&amp;t=65&amp;host=desk-001"',
    );
    // Paused page has no refresh meta and shows paused badge.
    const paused = await get("/?view=overview&t=60&pause=1");
    const pausedBody = await paused.text();
    expect(pausedBody).not.toContain('http-equiv="refresh"');
    expect(pausedBody).toContain("paused");
    expect(pausedBody).toContain('href="/?view=overview&amp;t=60">resume');
    // Mid frame refresh preserves host.
    const withHost = await get("/?view=overview&t=60&host=desk-001");
    const withHostBody = await withHost.text();
    expect(withHostBody).toContain('http-equiv="refresh"');
    expect(withHostBody).toContain("host=desk-001");
    // /live 301 to /?t=60
    const liveRedirect = await get("/live?t=60", { redirect: "manual" });
    expect(liveRedirect.status).toBe(301);
    expect(liveRedirect.headers.get("location")).toBe("/?t=60");
    // Bad t is 404.
    const bad = await get("/live?t=abc", { redirect: "manual" });
    expect(bad.status).toBe(404);
    // Past end is 404.
    const past = await get("/?view=overview&t=241");
    expect(past.status).toBe(404);
    // Unknown view is 404.
    const unknown = await get("/?view=unknown");
    expect(unknown.status).toBe(404);
    // Bad host alias is 404.
    const badHost = await get("/?view=overview&host=Bad_Alias");
    expect(badHost.status).toBe(404);
    // Well-formed unknown host is 404.
    const unknownHost = await get("/?view=overview&host=unknown-host-xyz");
    expect(unknownHost.status).toBe(404);
  } finally {
    await server.stop();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
  // Without live sources, / has no Overview tab and no simulated text.
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
    if (live.activity.kind !== "ok") {
      throw new Error("expected activity rows");
    }
    expect(live.activity.value).toHaveLength(2);
    const priced = live.activity.value.find((row) => row.inputTokens === 1000);
    if (priced === undefined) {
      throw new Error("expected the priced row");
    }
    expect(priced.model).toBe("muse-spark-open-1026");
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
    expect(page).toContain("<td>meta-api</td>");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

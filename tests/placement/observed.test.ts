import { describe, expect, test } from "bun:test";
import type { HostCapacity, WorkItem } from "../../contracts/v1/types.js";
import type { HostStateConfig } from "../../src/hoststate/config.js";
import type { HostObservation, UnavailableCause } from "../../src/hoststate/collector.js";
import type { PlacementConfig } from "../../src/placement/config.js";
import { placeObserved } from "../../src/placement/observed.js";

const PACKAGE_CONFIG: HostStateConfig["package"] = {
  id: "moc.host-state",
  version: "0.1.0",
  sourceDigest: `sha256:${"a".repeat(64)}`,
  command: "host-state",
};

const PLACEMENT: PlacementConfig = {
  weights: { cpu: 0.4, memory: 0.4, gpu: 0.2 },
  batteryFloorPercent: 50,
  minInputIdleSeconds: 900,
};

function item(): WorkItem {
  return {
    schemaVersion: "v1",
    id: "w1-demo",
    repo: "pohunekd/means-of-compute",
    title: "Demo placement run",
    goal: "Demo placement on the synthetic fleet",
    issue: 11,
    dod: [{ id: "D1", text: "Placement chooses the idle desktop", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: {
      preferredModel: "meta/muse-glimmer-30b",
      attempts: 0,
      fallbackUsed: false,
    },
    retryCount: 0,
    stallRounds: 0,
  };
}

function capacity(hostAlias: string): HostCapacity {
  return {
    schemaVersion: "v1",
    hostAlias,
    timestamp: "2026-10-26T10:00:00.000Z",
    idle: true,
    idleReason: "no user input for 42 minutes, on AC power",
    secondsSinceInput: 2520,
    acPower: true,
    batteryPercent: null,
    cpu: { cores: 8, load1m: 0.7 },
    memory: { totalMb: 32768, freeMb: 21000 },
    gpu: { present: false, name: null, freeMb: null },
    localModels: { reachable: false, models: [] },
    policy: {
      allowedWindow: { start: "08:00", end: "22:00" },
      insideWindow: true,
      maxConcurrentAgents: 2,
    },
  };
}

function reported(hostAlias: string): HostObservation {
  return {
    kind: "reported",
    hostAlias,
    observedAt: "2026-10-26T10:00:01.000Z",
    plugin: { packageId: PACKAGE_CONFIG.id, version: "0.1.0", digest: PACKAGE_CONFIG.sourceDigest },
    capacity: capacity(hostAlias),
  };
}

function unavailable(
  hostAlias: string,
  cause: UnavailableCause = "host-unreachable",
): HostObservation {
  return {
    kind: "unavailable",
    hostAlias,
    observedAt: "2026-10-26T10:00:01.000Z",
    cause,
    detail: cause,
  };
}

describe("observed placement", () => {
  test("mixed observations keep reported order first, then unavailable in input order (mutation: unshift)", () => {
    const decision = placeObserved(
      item(),
      [reported("laptop-a"), unavailable("laptop-b"), unavailable("desktop")],
      [],
      PLACEMENT,
    );
    expect(decision.chosenHostAlias).toBe("laptop-a");
    expect(decision.candidates).toHaveLength(3);
    expect(decision.candidates[0]?.hostAlias).toBe("laptop-a");
    expect(decision.candidates[0]?.excluded).toBe(false);
    expect(decision.candidates[1]).toEqual({
      hostAlias: "laptop-b",
      score: 0,
      reason: "excluded: host state unavailable (host-unreachable)",
      excluded: true,
    });
    expect(decision.candidates[2]).toEqual({
      hostAlias: "desktop",
      score: 0,
      reason: "excluded: host state unavailable (host-unreachable)",
      excluded: true,
    });
  });

  test("no reported host keeps a counted reason (mutation: keep place() reason)", () => {
    const decision = placeObserved(
      item(),
      [unavailable("laptop-a"), unavailable("laptop-b")],
      [],
      PLACEMENT,
    );
    expect(decision.chosenHostAlias).toBeNull();
    expect(decision.reason).toBe("no eligible host: 2 of 2 excluded");
  });

  test("duplicate alias throws (mutation: silently dedupe)", () => {
    expect(() =>
      placeObserved(item(), [reported("laptop-a"), unavailable("laptop-a")], [], PLACEMENT),
    ).toThrow("Duplicate host alias laptop-a");
  });
});

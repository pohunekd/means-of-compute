// #324: the per-host assessment takes no work item and gives every observed
// host the candidate placement gives it, unavailable hosts last.
import { expect, test } from "bun:test";
import type { HostCapacity, WorkItem } from "../../contracts/v1/types.js";
import type { HostObservation } from "../../src/hoststate/collector.js";
import type { PlacementConfig } from "../../src/placement/config.js";
import { assessObserved, placeObserved } from "../../src/placement/observed.js";

const PLACEMENT: PlacementConfig = {
  weights: { cpu: 0.4, memory: 0.4, gpu: 0.2 },
  batteryFloorPercent: 50,
  minInputIdleSeconds: 900,
};

function capacity(hostAlias: string, overrides: Partial<HostCapacity> = {}): HostCapacity {
  return {
    schemaVersion: "v1",
    hostAlias,
    timestamp: "2026-11-03T12:00:00.000Z",
    idle: true,
    idleReason: "no user input for 42 minutes, on AC power",
    secondsSinceInput: 2520,
    acPower: true,
    batteryPercent: null,
    cpu: { cores: 8, load1m: 0.8 },
    memory: { totalMb: 32768, freeMb: 16384 },
    gpu: { present: false, name: null, freeMb: null },
    localModels: { reachable: false, models: [] },
    policy: {
      allowedWindow: { start: "00:00", end: "00:00" },
      insideWindow: true,
      maxConcurrentAgents: 1,
    },
    ...overrides,
  };
}

function reported(cap: HostCapacity): HostObservation {
  return {
    kind: "reported",
    hostAlias: cap.hostAlias,
    observedAt: "2026-11-03T12:00:01.000Z",
    plugin: { packageId: "moc.host-state", version: "0.1.0", digest: `sha256:${"a".repeat(64)}` },
    capacity: cap,
  };
}

const ITEM: WorkItem = {
  schemaVersion: "v1",
  id: "w1-demo",
  repo: "example/demo",
  title: "Demo",
  goal: "Demo",
  issue: null,
  dod: [{ id: "D1", text: "Done", done: false }],
  dependencies: [],
  status: "queued",
  statusReason: null,
  assignedHostAlias: null,
  branch: null,
  pullNumber: null,
  modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
  retryCount: 0,
  stallRounds: 0,
};

test("assessObserved gives each host its placement candidate without a work item", () => {
  const observations: HostObservation[] = [
    {
      kind: "unavailable",
      hostAlias: "laptop-b",
      observedAt: "2026-11-03T12:00:01.000Z",
      cause: "host-unreachable",
      detail: "host-unreachable",
    },
    reported(capacity("laptop-a", { idle: false, idleReason: "not on AC power", acPower: false })),
    reported(capacity("desktop")),
  ];
  const assessed = assessObserved(observations, [], PLACEMENT);
  expect(assessed).toEqual([
    {
      hostAlias: "laptop-a",
      score: 0,
      reason: "excluded: not idle (not on AC power)",
      excluded: true,
    },
    {
      hostAlias: "desktop",
      score: 0.56,
      reason: "idle, on AC power, no battery, CPU 90% free, memory 50% free",
      excluded: false,
    },
    {
      hostAlias: "laptop-b",
      score: 0,
      reason: "excluded: host state unavailable (host-unreachable)",
      excluded: true,
    },
  ]);
  expect(placeObserved(ITEM, observations, [], PLACEMENT).candidates).toEqual(assessed);
});

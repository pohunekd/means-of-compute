// Placement tests: one row per case of the issue #11 test matrix. Each test
// names the mutation that must make it fail. Deterministic only: synthetic
// hosts and items, the pure place() function, no clock, no I/O.
import { expect, test } from "bun:test";
import type { HostCapacity, WorkItem } from "../../contracts/v1/types.js";
import { isPlacementDecision } from "../../contracts/v1/validate.js";
import type { PlacementWeights } from "../../src/placement/config.js";
import { place } from "../../src/placement/place.js";

const WEIGHTS: PlacementWeights = { cpu: 0.4, memory: 0.4, gpu: 0.2 };

function item(overrides: Partial<WorkItem> = {}): WorkItem {
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
    ...overrides,
  };
}

interface HostOverrides {
  readonly hostAlias?: string;
  readonly idle?: boolean;
  readonly idleReason?: string;
  readonly acPower?: boolean;
  readonly batteryPercent?: number | null;
  readonly cores?: number;
  readonly load1m?: number;
  readonly totalMb?: number;
  readonly freeMb?: number;
  readonly gpuPresent?: boolean;
  readonly insideWindow?: boolean;
  readonly maxConcurrentAgents?: number;
}

function host(overrides: HostOverrides = {}): HostCapacity {
  return {
    schemaVersion: "v1",
    hostAlias: overrides.hostAlias ?? "desktop",
    timestamp: "2026-10-26T10:00:00.000Z",
    idle: overrides.idle ?? true,
    idleReason: overrides.idleReason ?? "no user input for 42 minutes, on AC power",
    secondsSinceInput: 2520,
    acPower: overrides.acPower ?? true,
    batteryPercent: overrides.batteryPercent ?? null,
    cpu: { cores: overrides.cores ?? 8, load1m: overrides.load1m ?? 0.7 },
    memory: { totalMb: overrides.totalMb ?? 32768, freeMb: overrides.freeMb ?? 21000 },
    gpu: { present: overrides.gpuPresent ?? false, name: null, freeMb: null },
    localModels: { reachable: false, models: [] },
    policy: {
      allowedWindow: { start: "08:00", end: "22:00" },
      insideWindow: overrides.insideWindow ?? true,
      maxConcurrentAgents: overrides.maxConcurrentAgents ?? 2,
    },
  };
}

test("an active-user host with the most free capacity is never chosen (mutation: drop exclusion 1)", () => {
  const hosts = [
    host({ hostAlias: "desktop" }),
    host({
      hostAlias: "laptop-a",
      idle: false,
      idleReason: "user input 40 seconds ago",
      cores: 32,
      load1m: 0.1,
      totalMb: 131072,
      freeMb: 120000,
      gpuPresent: true,
    }),
  ];
  const decision = place(item(), hosts, [], WEIGHTS);
  expect(isPlacementDecision(decision)).toBe(true);
  expect(decision.chosenHostAlias).toBe("desktop");
  expect(decision.candidates.find((entry) => entry.hostAlias === "laptop-a")?.excluded).toBe(true);
});

test("a low-battery host with the most capacity is never chosen (mutation: drop exclusion 1)", () => {
  const hosts = [
    host({ hostAlias: "desktop" }),
    host({
      hostAlias: "laptop-b",
      idle: false,
      idleReason: "battery at 34 percent, below the 50 percent floor",
      cores: 32,
      load1m: 0.1,
      totalMb: 131072,
      freeMb: 120000,
      gpuPresent: true,
    }),
  ];
  const decision = place(item(), hosts, [], WEIGHTS);
  expect(isPlacementDecision(decision)).toBe(true);
  expect(decision.chosenHostAlias).toBe("desktop");
  expect(decision.candidates.find((entry) => entry.hostAlias === "laptop-b")?.excluded).toBe(true);
});

test("insideWindow:false with idle:true is excluded (mutation: drop exclusion 2)", () => {
  const hosts = [
    host({ hostAlias: "desktop", idle: true, insideWindow: false }),
    host({ hostAlias: "laptop-a" }),
  ];
  const decision = place(item(), hosts, [], WEIGHTS);
  expect(isPlacementDecision(decision)).toBe(true);
  expect(decision.chosenHostAlias).toBe("laptop-a");
  const candidate = decision.candidates.find((entry) => entry.hostAlias === "desktop");
  expect(candidate?.excluded).toBe(true);
  expect(candidate?.reason).toBe("excluded: outside policy window");
});

test("2 of 2 agents running on the best host excludes it (mutation: use > instead of >=)", () => {
  const hosts = [host({ hostAlias: "desktop" }), host({ hostAlias: "laptop-a" })];
  const running = [
    item({ id: "w1-running", status: "running", assignedHostAlias: "desktop" }),
    item({ id: "w2-running", status: "running", assignedHostAlias: "desktop" }),
  ];
  const decision = place(item(), hosts, running, WEIGHTS);
  expect(isPlacementDecision(decision)).toBe(true);
  expect(decision.chosenHostAlias).toBe("laptop-a");
  const candidate = decision.candidates.find((entry) => entry.hostAlias === "desktop");
  expect(candidate?.excluded).toBe(true);
  expect(candidate?.reason).toBe("excluded: at agent limit (2/2)");
});

test("equal score: lower load wins, then alias order (mutation: remove one tie-break)", () => {
  const lowLoad = host({
    hostAlias: "laptop-b",
    cores: 8,
    load1m: 0.8,
    totalMb: 10000,
    freeMb: 5000,
  });
  const highLoad = host({
    hostAlias: "laptop-a",
    cores: 8,
    load1m: 1.6,
    totalMb: 10000,
    freeMb: 6000,
  });
  const byLoad = place(item(), [lowLoad, highLoad], [], WEIGHTS);
  expect(byLoad.candidates[0]?.score).toBe(byLoad.candidates[1]?.score);
  expect(byLoad.chosenHostAlias).toBe("laptop-b");
  const twinA = host({ hostAlias: "laptop-b", cores: 8, load1m: 0.8 });
  const twinB = host({ hostAlias: "laptop-a", cores: 8, load1m: 0.8 });
  const byAlias = place(item(), [twinA, twinB], [], WEIGHTS);
  expect(byAlias.candidates[0]?.score).toBe(byAlias.candidates[1]?.score);
  expect(byAlias.chosenHostAlias).toBe("laptop-a");
});

test("all hosts excluded gives null, and the CLI exits 3 (mutation: return the first host)", () => {
  const hosts = [
    host({ hostAlias: "desktop", idle: false, idleReason: "user input 10 seconds ago" }),
    host({
      hostAlias: "laptop-a",
      idle: false,
      idleReason: "battery at 20 percent, below the 50 percent floor",
    }),
  ];
  const decision = place(item(), hosts, [], WEIGHTS);
  expect(isPlacementDecision(decision)).toBe(true);
  expect(decision.chosenHostAlias).toBeNull();
  expect(decision.reason).toBe("no eligible host: 2 of 2 excluded");
});

test("a running item with status review on a host does not count (mutation: count every item)", () => {
  const hosts = [
    host({ hostAlias: "desktop", maxConcurrentAgents: 1 }),
    host({ hostAlias: "laptop-a" }),
  ];
  const running = [item({ id: "w1-review", status: "review", assignedHostAlias: "desktop" })];
  const decision = place(item(), hosts, running, WEIGHTS);
  expect(isPlacementDecision(decision)).toBe(true);
  expect(decision.chosenHostAlias).toBe("desktop");
});

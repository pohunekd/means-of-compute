import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isHostCapacity } from "../../contracts/v1/validate.js";
import type { HostCapacity, WorkItem } from "../../contracts/v1/types.js";
import type { HostStateConfig } from "../../src/hoststate/config.js";
import {
  createCollector,
  observe,
  type CollectorDeps,
  type HostObservation,
  type HostStateLogEvent,
} from "../../src/hoststate/collector.js";
import { createMemoryHostStatePort } from "../../src/hoststate/memory-port.js";
import type { PlacementConfig } from "../../src/placement/config.js";
import { placeObserved } from "../../src/placement/observed.js";
import {
  HOST_STATE_FAILURES,
  HostStateError,
  type HostStateReply,
} from "../../src/hoststate/port.js";

const PACKAGE_ID = "moc.host-state";
const DIGEST = `sha256:${"b".repeat(64)}`;

const CONFIG: HostStateConfig = {
  package: {
    id: PACKAGE_ID,
    version: "0.1.0",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    targets: ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64", "bun-darwin-x64"],
  },
  collector: {
    acceptedVersions: ["0.1.0"],
    pluginTimeoutMs: 10000,
    transportMarginMs: 2000,
    maxOutputBytes: 16384,
    maxClockSkewMs: 120000,
  },
};

const GUARD_MS = 10000 + 2 * 2000;

const PLACEMENT: PlacementConfig = {
  weights: { cpu: 0.4, memory: 0.4, gpu: 0.2 },
  batteryFloorPercent: 50,
  minInputIdleSeconds: 900,
};

function workItem(): WorkItem {
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

function fixtureCapacity(): HostCapacity {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "fixtures", "probe", "scenarios", "desktop-mains.json"),
      "utf-8",
    ),
  ) as unknown;
  if (!isHostCapacity(raw)) {
    throw new Error("desktop-mains fixture is not a HostCapacity");
  }
  return raw;
}

function replyFor(capacity: HostCapacity, version = "0.1.0"): HostStateReply {
  return {
    identity: { packageId: PACKAGE_ID, version, digest: DIGEST },
    stdout: JSON.stringify(capacity),
  };
}

function depsFor(aliases: readonly string[]): {
  deps: CollectorDeps;
  control: ReturnType<typeof createMemoryHostStatePort>;
  events: HostStateLogEvent[];
  nowValue: { current: Date };
} {
  const control = createMemoryHostStatePort(aliases);
  const events: HostStateLogEvent[] = [];
  const nowValue = { current: new Date("2026-10-27T12:00:01.000Z") };
  const deps: CollectorDeps = {
    port: control.port,
    config: CONFIG,
    now: () => new Date(nowValue.current.getTime()),
    sleep: () => new Promise<void>(() => {}),
    log: (event) => {
      events.push(event);
    },
  };
  return { deps, control, events, nowValue };
}

describe("collector reported", () => {
  test("valid stdout reports the fixture capacity (mutation: reject valid input)", () => {
    const capacity = fixtureCapacity();
    const reply = replyFor(capacity);
    const now = new Date(new Date(capacity.timestamp).getTime() + 1000);
    const observation = observe("desktop", reply, CONFIG, now);
    expect(observation.kind).toBe("reported");
    if (observation.kind !== "reported") throw new Error("expected reported");
    expect(observation.capacity).toEqual(capacity);
    expect(observation.plugin).toEqual(reply.identity);
    expect(observation.observedAt).toBe(now.toISOString());
  });
});

describe("collector port failures", () => {
  for (const failure of HOST_STATE_FAILURES) {
    test(`${failure} maps to unavailable with that cause (mutation: collapse causes)`, async () => {
      const { deps, control } = depsFor(["laptop-a"]);
      control.set("laptop-a", { kind: "fail", failure, code: null });
      const observations = await createCollector(deps).collect();
      expect(observations).toHaveLength(1);
      const first = observations[0] as HostObservation;
      expect(first.kind).toBe("unavailable");
      if (first.kind !== "unavailable") throw new Error("expected unavailable");
      expect(first.cause).toBe(failure);
      expect(first.detail).toBe(failure);
    });
  }

  test("daemon code is carried in the detail (mutation: drop the code)", async () => {
    const { deps, control } = depsFor(["laptop-a"]);
    control.set("laptop-a", { kind: "fail", failure: "daemon-rejected", code: "gone" });
    const observations = await createCollector(deps).collect();
    const first = observations[0] as HostObservation;
    if (first.kind !== "unavailable") throw new Error("expected unavailable");
    expect(first.detail).toBe("daemon-rejected (gone)");
  });

  test("a synchronously thrown HostStateError maps to its cause (mutation: read outside the guard)", async () => {
    const { deps, control } = depsFor(["laptop-a"]);
    const syncDeps: CollectorDeps = {
      ...deps,
      port: {
        ...control.port,
        read: (): Promise<HostStateReply> => {
          throw new HostStateError("host-unreachable", null);
        },
      },
    };
    const observations = await createCollector(syncDeps).collect();
    const first = observations[0] as HostObservation;
    if (first.kind !== "unavailable") throw new Error("expected unavailable");
    expect(first.cause).toBe("host-unreachable");
    expect(first.detail).toBe("host-unreachable");
  });

  test("the 11 causes are distinct (mutation: reuse one cause)", () => {
    expect(new Set(HOST_STATE_FAILURES).size).toBe(11);
  });
});

describe("collector guard", () => {
  test("a hanging port yields request-timeout once sleep settles (mutation: no guard)", async () => {
    const { deps, control, nowValue } = depsFor(["laptop-a"]);
    control.set("laptop-a", { kind: "hang" });
    let sleepMs = -1;
    const guardDeps: CollectorDeps = {
      ...deps,
      sleep: (ms) => {
        sleepMs = ms;
        return Promise.resolve();
      },
    };
    const observations = await createCollector(guardDeps).collect();
    expect(observations).toHaveLength(1);
    const first = observations[0] as HostObservation;
    expect(first.kind).toBe("unavailable");
    if (first.kind !== "unavailable") throw new Error("expected unavailable");
    expect(first.cause).toBe("request-timeout");
    expect(first.detail).toBe(`no reply within ${String(GUARD_MS)} ms`);
    expect(sleepMs).toBe(GUARD_MS);
    expect(nowValue.current).toBeDefined();
  });

  test("calls carry the derived limits (mutation: hard-coded limits)", async () => {
    const { deps, control } = depsFor(["laptop-a"]);
    control.set("laptop-a", { kind: "hang" });
    const guardDeps: CollectorDeps = {
      ...deps,
      config: {
        ...CONFIG,
        collector: {
          ...CONFIG.collector,
          pluginTimeoutMs: 20000,
          transportMarginMs: 3000,
          maxOutputBytes: 8192,
        },
      },
      sleep: () => Promise.resolve(),
    };
    await createCollector(guardDeps).collect();
    expect(control.calls()).toHaveLength(1);
    expect(control.calls()[0]).toEqual({
      hostAlias: "laptop-a",
      packageId: PACKAGE_ID,
      limits: {
        pluginTimeoutMs: 20000,
        requestTimeoutMs: 23000,
        maxOutputBytes: 8192,
      },
    });
  });

  test("the guard signal is aborted once the reply wins (mutation: remove controller.abort())", async () => {
    const { deps, control } = depsFor(["laptop-a"]);
    control.set("laptop-a", { kind: "reply", reply: replyFor(fixtureCapacity()) });
    let signal: AbortSignal | undefined;
    const replyDeps: CollectorDeps = {
      ...deps,
      sleep: (ms: number, candidate: AbortSignal) => {
        signal = candidate;
        expect(ms).toBe(GUARD_MS);
        return new Promise<void>(() => {});
      },
    };
    await createCollector(replyDeps).collect();
    expect(signal?.aborted).toBe(true);
  });
});

describe("collector reply rules", () => {
  test("wrong package id gives package-mismatch (mutation: skip step 2)", () => {
    const capacity = fixtureCapacity();
    const reply: HostStateReply = {
      identity: { packageId: "other.package", version: "0.1.0", digest: DIGEST },
      stdout: JSON.stringify(capacity),
    };
    const observation = observe("desktop", reply, CONFIG, new Date(capacity.timestamp));
    if (observation.kind !== "unavailable") throw new Error("expected unavailable");
    expect(observation.cause).toBe("package-mismatch");
    expect(observation.detail).toBe("package id differs");
  });

  test("unaccepted version gives version-not-accepted (mutation: skip step 4)", () => {
    const capacity = fixtureCapacity();
    const observation = observe(
      "desktop",
      replyFor(capacity, "0.0.9"),
      CONFIG,
      new Date(capacity.timestamp),
    );
    if (observation.kind !== "unavailable") throw new Error("expected unavailable");
    expect(observation.cause).toBe("version-not-accepted");
    expect(observation.detail).toBe("version 0.0.9");
  });

  test("unparseable version gives version unparseable (mutation: skip step 4)", () => {
    const capacity = fixtureCapacity();
    const observation = observe(
      "desktop",
      replyFor(capacity, "latest"),
      CONFIG,
      new Date(capacity.timestamp),
    );
    if (observation.kind !== "unavailable") throw new Error("expected unavailable");
    expect(observation.cause).toBe("version-not-accepted");
    expect(observation.detail).toBe("version unparseable");
  });

  test("plain text stdout gives not-json (mutation: skip step 5)", () => {
    const capacity = fixtureCapacity();
    const observation = observe(
      "desktop",
      {
        identity: { packageId: PACKAGE_ID, version: "0.1.0", digest: DIGEST },
        stdout: "not json",
      },
      CONFIG,
      new Date(capacity.timestamp),
    );
    if (observation.kind !== "unavailable") throw new Error("expected unavailable");
    expect(observation.cause).toBe("not-json");
    expect(observation.detail).toBe("stdout is not one JSON document");
  });

  test("two documents give not-json (mutation: parse the prefix)", () => {
    const capacity = fixtureCapacity();
    const observation = observe(
      "desktop",
      {
        identity: { packageId: PACKAGE_ID, version: "0.1.0", digest: DIGEST },
        stdout: "{}\n{}",
      },
      CONFIG,
      new Date(capacity.timestamp),
    );
    if (observation.kind !== "unavailable") throw new Error("expected unavailable");
    expect(observation.cause).toBe("not-json");
  });

  test("idle removed gives contract-invalid (mutation: skip step 6)", () => {
    const capacity = fixtureCapacity();
    const stripped = JSON.parse(JSON.stringify(capacity)) as Record<string, unknown>;
    delete stripped["idle"];
    const observation = observe(
      "desktop",
      {
        identity: { packageId: PACKAGE_ID, version: "0.1.0", digest: DIGEST },
        stdout: JSON.stringify(stripped),
      },
      CONFIG,
      new Date(capacity.timestamp),
    );
    if (observation.kind !== "unavailable") throw new Error("expected unavailable");
    expect(observation.cause).toBe("contract-invalid");
    expect(observation.detail).toContain("/");
  });

  test("freeMb above totalMb gives contract-invalid (mutation: skip step 6)", () => {
    const capacity = fixtureCapacity();
    const over = {
      ...capacity,
      memory: { totalMb: capacity.memory.totalMb, freeMb: capacity.memory.totalMb + 1 },
    };
    const observation = observe("desktop", replyFor(over), CONFIG, new Date(capacity.timestamp));
    if (observation.kind !== "unavailable") throw new Error("expected unavailable");
    expect(observation.cause).toBe("contract-invalid");
    expect(observation.detail).toBe("memory.freeMb above memory.totalMb");
  });

  test("reported alias mismatch gives alias-mismatch (mutation: skip step 7)", () => {
    const capacity = fixtureCapacity();
    const observation = observe(
      "laptop-a",
      replyFor(capacity),
      CONFIG,
      new Date(capacity.timestamp),
    );
    if (observation.kind !== "unavailable") throw new Error("expected unavailable");
    expect(observation.cause).toBe("alias-mismatch");
    expect(observation.detail).toBe(`reported ${capacity.hostAlias}`);
  });

  test("stdout over the cap gives output-too-large (mutation: skip step 3)", () => {
    const capacity = fixtureCapacity();
    const small: HostStateConfig = {
      ...CONFIG,
      collector: { ...CONFIG.collector, maxOutputBytes: 100 },
    };
    const reply = replyFor(capacity);
    const bytes = Buffer.byteLength(reply.stdout, "utf8");
    expect(bytes).toBeGreaterThan(100);
    const observation = observe("desktop", reply, small, new Date(capacity.timestamp));
    if (observation.kind !== "unavailable") throw new Error("expected unavailable");
    expect(observation.cause).toBe("output-too-large");
    expect(observation.detail).toBe(`${String(bytes)} bytes`);
  });
});

describe("collector time bounds", () => {
  test("boundary ages report, one millisecond more is stale or future (mutation: >= instead of >)", () => {
    const capacity = fixtureCapacity();
    const stamp = new Date(capacity.timestamp).getTime();
    const skew = CONFIG.collector.maxClockSkewMs;
    const atOldEdge = new Date(stamp + GUARD_MS + skew);
    expect(observe("desktop", replyFor(capacity), CONFIG, atOldEdge).kind).toBe("reported");
    const atStale = new Date(stamp + GUARD_MS + skew + 1);
    const stale = observe("desktop", replyFor(capacity), CONFIG, atStale);
    if (stale.kind !== "unavailable") throw new Error("expected unavailable");
    expect(stale.cause).toBe("stale");
    expect(stale.detail).toBe(`age ${String(GUARD_MS + skew + 1)} ms`);
    const atNewEdge = new Date(stamp - skew);
    expect(observe("desktop", replyFor(capacity), CONFIG, atNewEdge).kind).toBe("reported");
    const atFuture = new Date(stamp - skew - 1);
    const future = observe("desktop", replyFor(capacity), CONFIG, atFuture);
    if (future.kind !== "unavailable") throw new Error("expected unavailable");
    expect(future.cause).toBe("future-timestamp");
    expect(future.detail).toBe(`ahead ${String(skew + 1)} ms`);
  });

  test("leap-second timestamp is contract-invalid and never placed (mutation: drop the finite check)", async () => {
    const capacity = fixtureCapacity();
    const leap = { ...capacity, timestamp: "2020-01-01T23:59:60Z" };
    const direct = observe(
      "desktop",
      replyFor(leap),
      CONFIG,
      new Date("2026-10-27T12:00:01.000Z"),
    );
    if (direct.kind !== "unavailable") throw new Error("expected unavailable");
    expect(direct.cause).toBe("contract-invalid");
    expect(direct.detail).toBe("timestamp unparseable");
    const { deps, control } = depsFor(["desktop", "laptop-a"]);
    control.set("desktop", { kind: "reply", reply: replyFor(leap) });
    control.set("laptop-a", { kind: "fail", failure: "host-unreachable", code: null });
    const observations = await createCollector(deps).collect();
    const decision = placeObserved(workItem(), observations, [], PLACEMENT);
    expect(decision.chosenHostAlias).toBeNull();
  });
});

describe("collector round rules", () => {
  test("three hosts keep order and only the first reports (mutation: abort or reorder)", async () => {
    const { deps, control } = depsFor(["desktop", "laptop-a", "laptop-b"]);
    control.set("desktop", { kind: "reply", reply: replyFor(fixtureCapacity()) });
    control.set("laptop-a", { kind: "fail", failure: "host-unreachable", code: null });
    const broken = {
      ...(fixtureCapacity() as unknown as Record<string, unknown>),
    } as Record<string, unknown>;
    delete broken["idle"];
    control.set("laptop-b", {
      kind: "reply",
      reply: {
        identity: { packageId: PACKAGE_ID, version: "0.1.0", digest: DIGEST },
        stdout: JSON.stringify(broken),
      },
    });
    const observations = await createCollector(deps).collect();
    expect(observations.map((entry) => entry.hostAlias)).toEqual([
      "desktop",
      "laptop-a",
      "laptop-b",
    ]);
    expect(observations[0]?.kind).toBe("reported");
    expect((observations[1] as { kind: string }).kind).toBe("unavailable");
    expect((observations[2] as { kind: string }).kind).toBe("unavailable");
  });

  test("a non-port error rejects the round (mutation: catch-all mapping)", async () => {
    const { deps, control } = depsFor(["laptop-a"]);
    const boom = new Error("socket exploded");
    control.set("laptop-a", { kind: "throw", error: boom });
    const failure = await createCollector(deps)
      .collect()
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBe(boom);
  });

  test("two concurrent collects make one read per host (mutation: start a second round)", async () => {
    const { deps, control } = depsFor(["laptop-a"]);
    control.set("laptop-a", { kind: "hang" });
    const collector = createCollector({ ...deps, sleep: () => Promise.resolve() });
    const [first, second] = await Promise.all([collector.collect(), collector.collect()]);
    expect(first).toBe(second);
    expect(control.calls().length).toBe(1);
  });

  test("sequential collects re-read and return the fresh round (mutation: delete inFlight = null)", async () => {
    const { deps, control } = depsFor(["laptop-a"]);
    control.set("laptop-a", { kind: "fail", failure: "host-unreachable", code: null });
    const collector = createCollector(deps);
    const first = await collector.collect();
    control.set("laptop-a", { kind: "fail", failure: "plugin-busy", code: null });
    const second = await collector.collect();
    expect(control.calls()).toHaveLength(2);
    expect(first).not.toBe(second);
    const firstEntry = first[0] as HostObservation;
    const secondEntry = second[0] as HostObservation;
    if (firstEntry.kind !== "unavailable" || secondEntry.kind !== "unavailable") {
      throw new Error("expected unavailable");
    }
    expect(firstEntry.cause).toBe("host-unreachable");
    expect(secondEntry.cause).toBe("plugin-busy");
  });

  test("a rejected round is not cached (mutation: delete inFlight = null)", async () => {
    const { deps, control } = depsFor(["laptop-a"]);
    const boom = new Error("socket exploded");
    control.set("laptop-a", { kind: "throw", error: boom });
    const collector = createCollector(deps);
    const failure = await collector.collect().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBe(boom);
    control.set("laptop-a", { kind: "fail", failure: "host-unreachable", code: null });
    const second = await collector.collect();
    expect(control.calls()).toHaveLength(2);
    const entry = second[0] as HostObservation;
    if (entry.kind !== "unavailable") throw new Error("expected unavailable");
    expect(entry.cause).toBe("host-unreachable");
  });
});

describe("collector logs", () => {
  test("contract-invalid event carries hashes, never the stdout text (mutation: log stdout)", async () => {
    const { deps, control, events } = depsFor(["desktop"]);
    const broken = JSON.parse(JSON.stringify(fixtureCapacity())) as Record<string, unknown>;
    delete broken["idle"];
    const stdout = JSON.stringify(broken);
    control.set("desktop", {
      kind: "reply",
      reply: {
        identity: { packageId: PACKAGE_ID, version: "0.1.0", digest: DIGEST },
        stdout,
      },
    });
    await createCollector(deps).collect();
    expect(events).toHaveLength(1);
    const event = events[0] as HostStateLogEvent;
    expect(event.event).toBe("host-state");
    expect(event.hostAlias).toBe("desktop");
    expect(event.kind).toBe("unavailable");
    expect(event.cause).toBe("contract-invalid");
    expect(event.stdoutBytes).toBe(Buffer.byteLength(stdout, "utf8"));
    expect(typeof event.stdoutSha256).toBe("string");
    for (const value of Object.values(event)) {
      if (typeof value === "string") {
        expect(value).not.toContain(stdout);
        expect(value).not.toContain("overlay");
        expect(value).not.toContain("host.example");
      }
    }
  });

  test("route-shaped failure text never reaches events (mutation: copy the code into detail)", async () => {
    const { deps, control, events } = depsFor(["laptop-a"]);
    control.set("laptop-a", {
      kind: "fail",
      failure: "daemon-rejected",
      code: "host.example:7443",
    });
    const observations = await createCollector(deps).collect();
    const first = observations[0] as HostObservation;
    if (first.kind !== "unavailable") throw new Error("expected unavailable");
    expect(first.cause).toBe("daemon-rejected");
    expect(first.detail).toBe("daemon-rejected");
    expect(events).toHaveLength(1);
    for (const logged of events) {
      for (const value of Object.values(logged)) {
        if (typeof value === "string") {
          expect(value).not.toContain("host.example:7443");
          expect(value).not.toContain("host.example");
        }
      }
    }
  });

  test("a thrown route-shaped message leaves no event (mutation: log non-port errors)", async () => {
    const { deps, control, events } = depsFor(["laptop-a"]);
    const boom = new Error("dial laptop-a.overlay.example:7443 failed");
    control.set("laptop-a", { kind: "throw", error: boom });
    const failure = await createCollector(deps)
      .collect()
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBe(boom);
    expect(events).toHaveLength(0);
  });

  test("three hosts log one event per host with reported fields (mutation: drop an event)", async () => {
    const { deps, control, events } = depsFor(["desktop", "laptop-a", "laptop-b"]);
    const stdout = JSON.stringify(fixtureCapacity());
    control.set("desktop", {
      kind: "reply",
      reply: {
        identity: { packageId: PACKAGE_ID, version: "0.1.0", digest: DIGEST },
        stdout,
      },
    });
    control.set("laptop-a", { kind: "fail", failure: "host-unreachable", code: null });
    control.set("laptop-b", { kind: "fail", failure: "plugin-busy", code: null });
    const observations = await createCollector(deps).collect();
    expect(observations).toHaveLength(3);
    expect(events).toHaveLength(3);
    expect(events.map((entry) => entry.hostAlias)).toEqual(["desktop", "laptop-a", "laptop-b"]);
    const reported = events[0] as HostStateLogEvent;
    expect(reported.kind).toBe("reported");
    expect(reported.cause).toBeNull();
    expect(reported.detail).toBeNull();
    expect(reported.packageVersion).toBe("0.1.0");
    expect(reported.packageDigest).toBe(DIGEST);
    expect(reported.stdoutBytes).toBe(Buffer.byteLength(stdout, "utf8"));
    expect(reported.stdoutSha256).toBe(
      createHash("sha256").update(stdout, "utf8").digest("hex"),
    );
  });
});

describe("collector error hygiene", () => {
  test("unexpected code text never reaches the message (mutation: pass .message)", () => {
    const error = new HostStateError("daemon-rejected", "route: north !!!");
    expect(error.code).toBeNull();
    expect(error.message).toBe("daemon-rejected");
  });
});

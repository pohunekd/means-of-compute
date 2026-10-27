import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isHostCapacity } from "../../contracts/v1/validate.js";
import type { HostCapacity } from "../../contracts/v1/types.js";
import type { HostStateConfig } from "../../src/hoststate/config.js";
import {
  createCollector,
  observe,
  type CollectorDeps,
  type HostObservation,
  type HostStateLogEvent,
} from "../../src/hoststate/collector.js";
import { createMemoryHostStatePort } from "../../src/hoststate/memory-port.js";
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

  test("the 11 causes are distinct (mutation: reuse one cause)", () => {
    expect(new Set(HOST_STATE_FAILURES).size).toBe(11);
  });
});

describe("collector guard", () => {
  test("a hanging port yields request-timeout once sleep settles (mutation: no guard)", async () => {
    const { deps, control, nowValue } = depsFor(["laptop-a"]);
    control.set("laptop-a", { kind: "hang" });
    const guardDeps: CollectorDeps = {
      ...deps,
      sleep: () => Promise.resolve(),
    };
    const observations = await createCollector(guardDeps).collect();
    expect(observations).toHaveLength(1);
    const first = observations[0] as HostObservation;
    expect(first.kind).toBe("unavailable");
    if (first.kind !== "unavailable") throw new Error("expected unavailable");
    expect(first.cause).toBe("request-timeout");
    expect(first.detail).toBe(`no reply within ${String(GUARD_MS)} ms`);
    expect(nowValue.current).toBeDefined();
  });

  test("calls carry the derived limits (mutation: hard-coded limits)", async () => {
    const { deps, control } = depsFor(["laptop-a"]);
    control.set("laptop-a", { kind: "hang" });
    const guardDeps: CollectorDeps = {
      ...deps,
      sleep: () => Promise.resolve(),
    };
    await createCollector(guardDeps).collect();
    expect(control.calls()).toHaveLength(1);
    expect(control.calls()[0]).toEqual({
      hostAlias: "laptop-a",
      packageId: PACKAGE_ID,
      limits: {
        pluginTimeoutMs: 10000,
        requestTimeoutMs: 12000,
        maxOutputBytes: 16384,
      },
    });
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
    const observation = observe(
      "desktop",
      replyFor(over),
      CONFIG,
      new Date(capacity.timestamp),
    );
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
    await expect(createCollector(deps).collect()).rejects.toBe(boom);
  });

  test("two concurrent collects make one read per host (mutation: start a second round)", async () => {
    const { deps, control } = depsFor(["laptop-a"]);
    control.set("laptop-a", { kind: "hang" });
    const collector = createCollector({ ...deps, sleep: () => Promise.resolve() });
    const [first, second] = await Promise.all([collector.collect(), collector.collect()]);
    expect(first).toBe(second);
    expect(control.calls()).toHaveLength(1);
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
});

describe("collector error hygiene", () => {
  test("unexpected code text never reaches the message (mutation: pass .message)", () => {
    const error = new HostStateError("daemon-rejected", "route: north !!!");
    expect(error.code).toBeNull();
    expect(error.message).toBe("daemon-rejected");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isHostCapacity } from "../../contracts/v1/validate.js";
import type { HostCapacity } from "../../contracts/v1/types.js";
import type { HostStateConfig } from "../../src/hoststate/config.js";
import { observe } from "../../src/hoststate/collector.js";
import type { HostStateReply } from "../../src/hoststate/port.js";

const PACKAGE_ID = "moc.host-state";
const DIGEST = `sha256:${"b".repeat(64)}`;

const CONFIG: HostStateConfig = {
  package: {
    id: PACKAGE_ID,
    version: "0.1.0",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    command: "host-state",
  },
  collector: {
    acceptedVersions: ["0.1.0"],
    pluginTimeoutMs: 10000,
    transportMarginMs: 2000,
    maxOutputBytes: 16384,
    maxClockSkewMs: 120000,
  },
};

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

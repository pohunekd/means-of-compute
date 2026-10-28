// Host-state port tests: reads through the fake daemon over the real SDK
// transport seam. No real daemon, no network, no timers.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isHostCapacity } from "../../../contracts/v1/validate.js";
import type { HostCapacity } from "../../../contracts/v1/types.js";
import { createFakeDaemon, fakeErrors } from "../../../src/dispatcher/adapter/fake-daemon.js";
import type { FakeDaemon } from "../../../src/dispatcher/adapter/fake-daemon.js";
import { createPohunekHostStatePort } from "../../../src/dispatcher/adapter/host-state-port.js";
import type { HostStateConfig } from "../../../src/hoststate/config.js";
import { createCollector } from "../../../src/hoststate/collector.js";
import type { HostStateLogEvent } from "../../../src/hoststate/collector.js";
import {
  HostStateError,
  type HostStateLimits,
  type HostStatePort,
} from "../../../src/hoststate/port.js";

const PACKAGE_ID = "moc.host-state";
const DIGEST = `sha256:${"d".repeat(64)}`;

const LIMITS: HostStateLimits = {
  pluginTimeoutMs: 10000,
  requestTimeoutMs: 12000,
  maxOutputBytes: 16384,
};

const CONFIG: HostStateConfig = {
  package: {
    id: PACKAGE_ID,
    version: "0.2.0",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    command: "host-state",
  },
  collector: {
    acceptedVersions: ["0.2.0"],
    pluginTimeoutMs: 10000,
    transportMarginMs: 2000,
    maxOutputBytes: 16384,
    maxClockSkewMs: 120000,
  },
};

function okResult(stdout: string): {
  package: { id: string; version: string };
  command: string;
  digest: string;
  output: string;
  duration_ms: number;
} {
  return {
    package: { id: PACKAGE_ID, version: "0.2.0" },
    command: "host-state",
    digest: DIGEST,
    output: stdout,
    duration_ms: 70,
  };
}

function fixtureStdout(hostAlias: string, timestamp: string): string {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "..", "fixtures", "probe", "scenarios", "desktop-mains.json"),
      "utf-8",
    ),
  ) as unknown;
  if (!isHostCapacity(raw)) {
    throw new Error("desktop-mains fixture is not a HostCapacity");
  }
  const capacity: HostCapacity = { ...raw, hostAlias, timestamp };
  return JSON.stringify(capacity);
}

function portFor(fake: FakeDaemon): HostStatePort {
  return createPohunekHostStatePort({
    connector: fake.connector,
    command: "host-state",
  });
}

test("an ok run returns the reply and records the command.run params", async () => {
  const fake = createFakeDaemon(["host-a"], "moc-worker");
  try {
    const stdout = fixtureStdout("host-a", "2026-10-27T12:00:00.000Z");
    fake.setCommand("host-a", { ok: okResult(stdout) });
    const port = portFor(fake);
    const reply = await port.read("host-a", PACKAGE_ID, LIMITS);
    expect(reply).toEqual({
      identity: { packageId: PACKAGE_ID, version: "0.2.0", digest: DIGEST },
      stdout,
    });
    const calls = fake.calls("host-a");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("command.run");
    expect(calls[0]?.params).toEqual({
      package: PACKAGE_ID,
      command: "host-state",
      timeout_ms: 10000,
      max_output_bytes: 16384,
    });
  } finally {
    await fake.connector.close();
  }
});

test("method_not_found maps to daemon-unsupported (command_unsupported)", async () => {
  const fake = createFakeDaemon(["host-a"], "moc-worker");
  try {
    fake.setCommand("host-a", { errCode: "method_not_found" });
    const port = portFor(fake);
    let caught: unknown;
    try {
      await port.read("host-a", PACKAGE_ID, LIMITS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostStateError);
    const mapped = caught as HostStateError;
    expect(mapped.failure).toBe("daemon-unsupported");
    expect(mapped.code).toBe("command_unsupported");
  } finally {
    await fake.connector.close();
  }
});

test("an unreachable host drops the connection and the next read succeeds", async () => {
  const fake = createFakeDaemon(["host-a"], "moc-worker");
  try {
    const stdout = fixtureStdout("host-a", "2026-10-27T12:00:00.000Z");
    fake.setCommand("host-a", { ok: okResult(stdout) });
    const seen: string[] = [];
    const inner = fake.connector;
    const port = createPohunekHostStatePort({
      connector: {
        aliases: () => inner.aliases(),
        client: (alias: string) => inner.client(alias),
        drop: (alias: string) => {
          seen.push(alias);
          return inner.drop(alias);
        },
        close: () => inner.close(),
      },
      command: "host-state",
    });
    fake.setUnreachable("host-a", true);
    let caught: unknown;
    try {
      await port.read("host-a", PACKAGE_ID, LIMITS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostStateError);
    expect((caught as HostStateError).failure).toBe("host-unreachable");
    expect(seen).toEqual(["host-a"]);
    fake.setUnreachable("host-a", false);
    const reply = await port.read("host-a", PACKAGE_ID, LIMITS);
    expect(reply.stdout).toBe(stdout);
  } finally {
    await fake.connector.close();
  }
});

test("a daemon request timeout maps to request-timeout with a drop", async () => {
  const fake = createFakeDaemon(["host-a"], "moc-worker");
  try {
    const seen: string[] = [];
    const inner = fake.connector;
    const port = createPohunekHostStatePort({
      connector: {
        aliases: () => inner.aliases(),
        client: (alias: string) => inner.client(alias),
        drop: (alias: string) => {
          seen.push(alias);
          return inner.drop(alias);
        },
        close: () => inner.close(),
      },
      command: "host-state",
    });
    fake.failNext("host-a", "command.run", {
      error: fakeErrors.requestTimeout("host-a"),
      apply: false,
    });
    let caught: unknown;
    try {
      await port.read("host-a", PACKAGE_ID, LIMITS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostStateError);
    expect((caught as HostStateError).failure).toBe("request-timeout");
    expect(seen).toEqual(["host-a"]);
  } finally {
    await fake.connector.close();
  }
});

test("command_failed details pass through the real SDK decoder", async () => {
  const fake = createFakeDaemon(["host-a"], "moc-worker");
  try {
    fake.setCommand("host-a", {
      errCode: "command_failed",
      details: { process_exit: { exit_code: 2 } },
    });
    const port = portFor(fake);
    let caught: unknown;
    try {
      await port.read("host-a", PACKAGE_ID, LIMITS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostStateError);
    const mapped = caught as HostStateError;
    expect(mapped.failure).toBe("plugin-failed");
    expect(mapped.code).toBe("exit-2");
  } finally {
    await fake.connector.close();
  }
});

test("hosts sorts the aliases", () => {
  const fake = createFakeDaemon(["host-b", "host-a"], "moc-worker");
  try {
    const port = portFor(fake);
    expect(port.hosts()).toEqual(["host-a", "host-b"]);
  } finally {
    void fake.connector.close();
  }
});

test("an unknown alias throws a plain Error with no command.run call", async () => {
  const fake = createFakeDaemon(["host-a"], "moc-worker");
  try {
    const port = portFor(fake);
    let caught: unknown;
    try {
      await port.read("host-x", PACKAGE_ID, LIMITS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(HostStateError);
    expect(fake.calls("host-a")).toEqual([]);
  } finally {
    await fake.connector.close();
  }
});

test("limits above the daemon ceilings throw a plain Error with no call", async () => {
  const fake = createFakeDaemon(["host-a"], "moc-worker");
  try {
    const port = portFor(fake);
    let caught: unknown;
    try {
      await port.read("host-a", PACKAGE_ID, { ...LIMITS, maxOutputBytes: 131073 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(HostStateError);
    expect(fake.calls("host-a")).toEqual([]);
  } finally {
    await fake.connector.close();
  }
});

test("close twice resolves and a later read throws", async () => {
  const fake = createFakeDaemon(["host-a"], "moc-worker");
  try {
    const stdout = fixtureStdout("host-a", "2026-10-27T12:00:00.000Z");
    fake.setCommand("host-a", { ok: okResult(stdout) });
    const port = portFor(fake);
    await port.close();
    await port.close();
    let caught: unknown;
    try {
      await port.read("host-a", PACKAGE_ID, LIMITS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("host state port is closed");
  } finally {
    await fake.connector.close();
  }
});

test("the adapter over the fake gives reported and plugin-failed observations", async () => {
  const fake = createFakeDaemon(["host-a", "host-b"], "moc-worker");
  try {
    const now = new Date("2026-10-27T12:00:01.000Z");
    fake.setCommand("host-a", {
      ok: okResult(fixtureStdout("host-a", "2026-10-27T12:00:00.000Z")),
    });
    fake.setCommand("host-b", {
      errCode: "command_failed",
      details: { process_exit: { exit_code: 1 } },
    });
    const events: HostStateLogEvent[] = [];
    const observations = await createCollector({
      port: portFor(fake),
      config: CONFIG,
      now: () => new Date(now.getTime()),
      sleep: () => new Promise<void>(() => {}),
      log: (event) => {
        events.push(event);
      },
    }).collect();
    expect(observations).toHaveLength(2);
    const first = observations[0];
    const second = observations[1];
    if (first?.kind !== "reported") {
      throw new Error("expected host-a to be reported");
    }
    expect(first.hostAlias).toBe("host-a");
    expect(first.capacity.hostAlias).toBe("host-a");
    if (second?.kind !== "unavailable") {
      throw new Error("expected host-b to be unavailable");
    }
    expect(second.cause).toBe("plugin-failed");
    expect(second.detail).toBe("plugin-failed (exit-1)");
    expect(events).toHaveLength(2);
  } finally {
    await fake.connector.close();
  }
});

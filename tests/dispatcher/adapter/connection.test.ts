// Connector tests (decision F4): in-flight opens are invalidated by drop
// and close. The injected connectHost is gated per test; the reconnect
// after a drop uses the same injection, so no socket is touched. The
// runtime directory below is a per-process /tmp scratch space; the socket
// verification never leaves the test.
import { expect, test } from "bun:test";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectHostFn } from "../../../src/dispatcher/adapter/connection.js";
import { createHostConnector } from "../../../src/dispatcher/adapter/connection.js";
import { PortRejectedError, PortUnreachableError } from "../../../src/dispatcher/port.js";

function routes(): ReadonlyMap<string, string> {
  return new Map([["laptop-a", "peer.test-route"]]);
}

async function runtimeEnv(
  body: (env: Readonly<Record<string, string | undefined>>) => Promise<void>,
): Promise<void> {
  const dir = join("/tmp", `moc-conn-${String(process.pid)}`);
  await mkdir(join(dir, "pohunek"), { recursive: true, mode: 0o700 });
  await chmod(join(dir, "pohunek"), 0o700);
  try {
    await chmod(dir, 0o700);
    await body({ XDG_RUNTIME_DIR: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface FakeClient {
  close(): Promise<void>;
}

function gatedClient(onClose: () => void, started: () => void, gate: Promise<void>): ConnectHostFn {
  const connectHost = (async () => {
    started();
    await gate;
    const client: FakeClient = {
      close: () => {
        onClose();
        return Promise.resolve();
      },
    };
    return client;
  }) as unknown as ConnectHostFn;
  return connectHost;
}

function openGate(): { gate: Promise<void>; release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    gate,
    release: () => {
      release();
    },
  };
}

test("a rejected connect removes its own pending entry", async () => {
  await runtimeEnv(async (env) => {
    let calls = 0;
    const failing = (() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("dial refused"));
      }
      const client: FakeClient = {
        close: () => Promise.resolve(),
      };
      return Promise.resolve(client);
    }) as unknown as ConnectHostFn;
    const connector = createHostConnector(
      routes(),
      { connectTimeoutMs: 5000, connectHost: failing },
      env,
    );
    let first: unknown;
    try {
      await connector.client("laptop-a");
    } catch (error) {
      first = error;
    }
    expect(first).toBeDefined();
    const second = await connector.client("laptop-a");
    expect(second).toBeDefined();
    expect(calls).toBe(2);
    await connector.close();
  });
});

test("the in-flight client is closed when close wins the race", async () => {
  await runtimeEnv(async (env) => {
    const controls = openGate();
    const started = { current: false };
    let closedCount = 0;
    const connector = createHostConnector(
      routes(),
      {
        connectTimeoutMs: 5000,
        connectHost: gatedClient(
          () => {
            closedCount += 1;
          },
          () => {
            started.current = true;
          },
          controls.gate,
        ),
      },
      env,
    );
    const opening = connector.client("laptop-a");
    while (!started.current) {
      await Bun.sleep(1);
    }
    const closed = connector.close();
    controls.release();
    await closed;
    let caught: unknown;
    try {
      await opening;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PortRejectedError);
    expect(closedCount).toBe(1);
  });
});

test("a drop between two opens leaves the second open intact", async () => {
  await runtimeEnv(async (env) => {
    // A is dropped before it resolves; B starts after the drop and must
    // reuse the pending entry instead of starting a third connect.
    let calls = 0;
    const firstClosed = { current: false };
    const secondClosed = { current: false };
    let firstGate!: () => void;
    let secondGate!: () => void;
    const firstWait = new Promise<void>((resolve) => {
      firstGate = resolve;
    });
    const secondWait = new Promise<void>((resolve) => {
      secondGate = resolve;
    });
    const both = (async () => {
      calls += 1;
      if (calls === 1) {
        await firstWait;
        const client: FakeClient = {
          close: () => {
            firstClosed.current = true;
            return Promise.resolve();
          },
        };
        return client;
      }
      await secondWait;
      const client: FakeClient = {
        close: () => {
          secondClosed.current = true;
          return Promise.resolve();
        },
      };
      return client;
    }) as unknown as ConnectHostFn;
    const connector = createHostConnector(
      routes(),
      { connectTimeoutMs: 5000, connectHost: both },
      env,
    );
    const first = connector.client("laptop-a");
    while (calls === 0) {
      await Bun.sleep(1);
    }
    await connector.drop("laptop-a");
    const second = connector.client("laptop-a");
    secondGate();
    const secondClient = await second;
    firstGate();
    let firstCaught: unknown;
    try {
      await first;
    } catch (error) {
      firstCaught = error;
    }
    expect(firstCaught).toBeInstanceOf(PortUnreachableError);
    expect((firstCaught as PortUnreachableError).message).toBe("laptop-a: host_unreachable");
    expect(secondClient).toBeDefined();
    expect(calls).toBe(2);
    // B's own resolution must have cached its client.
    expect(await connector.client("laptop-a")).toBe(secondClient);
    await connector.close();
    expect(firstClosed.current).toBe(true);
    expect(secondClosed.current).toBe(true);
  });
});

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

test("close during an open in flight rejects with connector-closed", async () => {
  await runtimeEnv(async (env) => {
    const controls = openGate();
    const started = { current: false };
    const connector = createHostConnector(
      routes(),
      {
        connectTimeoutMs: 5000,
        connectHost: gatedClient(
          () => {},
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
    expect((caught as PortRejectedError).code).toBe("connector-closed");
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

test("drop during an open in flight rejects with host-unreachable", async () => {
  await runtimeEnv(async (env) => {
    const controls = openGate();
    const started = { current: false };
    const connector = createHostConnector(
      routes(),
      {
        connectTimeoutMs: 5000,
        connectHost: gatedClient(
          () => {},
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
    const dropped = connector.drop("laptop-a");
    controls.release();
    await dropped;
    let caught: unknown;
    try {
      await opening;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PortUnreachableError);
    expect((caught as PortUnreachableError).message).toBe("laptop-a: host_unreachable");
    const client = await connector.client("laptop-a");
    expect(client).toBeDefined();
    await connector.close();
  });
});

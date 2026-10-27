// Connector tests (decision F4): in-flight opens are invalidated by drop
// and close. The injected connectHost is gated per test; the default
// still resolves through the local daemon socket.
import { expect, test } from "bun:test";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ENV_XDG_RUNTIME_DIR } from "@pohunek/sdk";
import type { Client as ClientType } from "@pohunek/sdk";
import type { ConnectHostFn } from "../../../src/dispatcher/adapter/connection.js";
import { createHostConnector } from "../../../src/dispatcher/adapter/connection.js";
import { PortRejectedError, PortUnreachableError } from "../../../src/dispatcher/port.js";

function routes(): ReadonlyMap<string, string> {
  return new Map([["laptop-a", "peer.test-route"]]);
}

async function runtimeEnv(
  body: (env: Record<string, string | undefined>) => Promise<void>,
): Promise<void> {
  const dir = join("/tmp", `moc-conn-${String(process.pid)}`);
  await mkdir(join(dir, "pohunek"), { recursive: true, mode: 0o700 });
  await chmod(join(dir, "pohunek"), 0o700);
  try {
    await chmod(dir, 0o700);
    await body({ [ENV_XDG_RUNTIME_DIR]: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function gatedClient(onClose: () => void, started: () => void, gate: Promise<void>): ConnectHostFn {
  const connectHost = (async () => {
    started();
    await gate;
    return {
      close: async () => {
        onClose();
      },
    } as unknown as ClientType;
  }) as unknown as ConnectHostFn;
  return connectHost;
}

test("close during an open in flight rejects with connector-closed", async () => {
  await runtimeEnv(async (env) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const connectHost = gatedClient(
      () => {},
      () => {
        started = true;
      },
      gate,
    );
    const connector = createHostConnector(routes(), { connectTimeoutMs: 5000, connectHost }, env);
    const opening = connector.client("laptop-a");
    while (!started) {
      await Bun.sleep(1);
    }
    const closed = connector.close();
    release();
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
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    let closedCount = 0;
    const connectHost = gatedClient(
      () => {
        closedCount += 1;
      },
      () => {
        started = true;
      },
      gate,
    );
    const connector = createHostConnector(routes(), { connectTimeoutMs: 5000, connectHost }, env);
    const opening = connector.client("laptop-a");
    while (!started) {
      await Bun.sleep(1);
    }
    const closed = connector.close();
    release();
    await closed;
    await expect(opening).rejects.toThrow();
    expect(closedCount).toBe(1);
  });
});

test("drop during an open in flight rejects with host-unreachable", async () => {
  await runtimeEnv(async (env) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const connectHost = gatedClient(
      () => {},
      () => {
        started = true;
      },
      gate,
    );
    const connector = createHostConnector(routes(), { connectTimeoutMs: 5000, connectHost }, env);
    const opening = connector.client("laptop-a");
    while (!started) {
      await Bun.sleep(1);
    }
    const dropped = connector.drop("laptop-a");
    release();
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

// Host-state map tests: one row per K7 table row, plus the
// command_failed details, route-free messages, null group and reply shape.
// SDK errors are built through the SDK seam only: the fake daemon decodes
// err replies through real Clients, and the ClientError statics are reached
// through a caught error, so this file never names the SDK package.
import { describe, expect, test } from "bun:test";
import { createFakeDaemon, fakeErrors } from "../../../src/dispatcher/adapter/fake-daemon.js";
import type { FakeDaemon } from "../../../src/dispatcher/adapter/fake-daemon.js";
import {
  hostStateErrorOf,
  hostStateReplyOf,
} from "../../../src/dispatcher/adapter/host-state-map.js";
import { HostStateError } from "../../../src/hoststate/port.js";
import { PortRejectedError, PortUnreachableError } from "../../../src/dispatcher/port.js";

type LocalClient = Awaited<ReturnType<FakeDaemon["connector"]["client"]>>;

interface ClientErrorStatics {
  protocol(source: unknown): unknown;
  remoteProtocol(host: string, source: unknown): unknown;
  daemonUnreachable(socketPath: string, source: unknown): unknown;
  hostUnreachable(host: string, source: unknown): unknown;
  remoteDaemonUnavailable(host: string): unknown;
  requestTimeout(host: string | undefined, timeoutMs: number): unknown;
  io(source: unknown): unknown;
  framing(message: string): unknown;
  json(source: unknown): unknown;
  versionMismatch(clientVersion: unknown, daemonVersion: number): unknown;
  daemonProtocolTooOld(detail: unknown): unknown;
  versionTranslation(host: string | undefined, daemonVersion: number, source: unknown): unknown;
  commandUnsupported(host: string | undefined): unknown;
  lifecycleOutcomeUnknown(operation: string, host: string | undefined, timeoutMs: number): unknown;
}

async function clientErrorStatics(): Promise<ClientErrorStatics> {
  const fake = createFakeDaemon(["laptop-a"], "moc-worker");
  try {
    const client = await fake.connector.client("laptop-a");
    fake.failNext("laptop-a", "session.inspect", { errCode: "branch_diverged", apply: false });
    try {
      await client.call("session.inspect", "fake-9");
    } catch (error) {
      const statics = (error as { constructor: unknown })
        .constructor as Partial<ClientErrorStatics>;
      if (typeof statics.protocol !== "function") {
        throw new Error("expected a ClientError with SDK statics", { cause: error });
      }
      return statics as ClientErrorStatics;
    }
    throw new Error("expected session.inspect to fail");
  } finally {
    await fake.connector.close();
  }
}

function protocolSource(code: string, details?: unknown): unknown {
  return {
    class: "daemon",
    code,
    msg: `daemon refused: ${code}`,
    ...(details === undefined ? {} : { details }),
  };
}

interface MiniChannel {
  send(line: string): Promise<void>;
  readonly lines: AsyncIterable<string>;
  close(): Promise<void>;
}

// A minimal Transport-shaped stub answering the version probe and one err
// reply with optional details, structured like the SDK seam.
function localErrTransport(
  code: string,
  details?: unknown,
): {
  control(): Promise<MiniChannel>;
  raw(): Promise<never>;
} {
  const queue: string[] = [];
  const wakeups: (() => void)[] = [];
  const push = (line: string): void => {
    queue.push(line);
    for (const wake of wakeups.splice(0)) {
      wake();
    }
  };
  const channel: MiniChannel = {
    async send(line: string): Promise<void> {
      const request = JSON.parse(line) as { id: string; method: string };
      await Promise.resolve();
      if (request.method === "daemon.health") {
        push(
          JSON.stringify({
            v: 4,
            id: request.id,
            ok: { status: "ok", daemon_version: "test", protocol_version: 4 },
          }),
        );
      } else {
        push(
          JSON.stringify({
            v: 4,
            id: request.id,
            err: {
              class: "daemon",
              code,
              msg: `test refused: ${code}`,
              ...(details === undefined ? {} : { details }),
            },
          }),
        );
      }
    },
    get lines(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<string> {
          return {
            async next(): Promise<IteratorResult<string>> {
              for (;;) {
                const next = queue.shift();
                if (next !== undefined) {
                  return { value: next, done: false };
                }
                await new Promise<void>((resolve) => {
                  wakeups.push(resolve);
                });
              }
            },
          };
        },
      };
    },
    async close(): Promise<void> {},
  };
  return {
    control(): Promise<MiniChannel> {
      return Promise.resolve(channel);
    },
    raw(): Promise<never> {
      throw new Error("no raw transport");
    },
  };
}

// Runs command.run through a local client so the err reply decodes with
// kind protocol. Returns the thrown error.
async function localRunError(code: string, details?: unknown): Promise<unknown> {
  const fake = createFakeDaemon(["laptop-a"], "moc-worker");
  try {
    const remote = await fake.connector.client("laptop-a");
    const ctor = remote.constructor as unknown as {
      connectTransport(transport: unknown, opts?: unknown): Promise<LocalClient>;
    };
    const local = await ctor.connectTransport(localErrTransport(code, details));
    try {
      await local.runCommand({
        package: "moc.host-state",
        command: "host-state",
        timeout_ms: 10000,
        max_output_bytes: 16384,
      });
    } catch (error) {
      return error;
    } finally {
      await local.close();
    }
    throw new Error(`expected command.run to fail with ${code}`);
  } finally {
    await fake.connector.close();
  }
}

// Runs command.run through the fake daemon so the err reply decodes with
// kind remoteProtocol. Returns the thrown error.
async function remoteRunError(code: string): Promise<unknown> {
  const fake = createFakeDaemon(["laptop-a"], "moc-worker");
  try {
    const client = await fake.connector.client("laptop-a");
    fake.failNext("laptop-a", "command.run", { errCode: code, apply: false });
    try {
      await client.runCommand({
        package: "moc.host-state",
        command: "host-state",
        timeout_ms: 10000,
        max_output_bytes: 16384,
      });
    } catch (error) {
      return error;
    }
    throw new Error(`expected command.run to fail with ${code}`);
  } finally {
    await fake.connector.close();
  }
}

const DIGEST = `sha256:${"c".repeat(64)}`;

function resultFor(output: string): Record<string, unknown> {
  return {
    package: { id: "moc.host-state", version: "0.2.0" },
    command: "host-state",
    digest: DIGEST,
    output,
    duration_ms: 70,
  };
}

describe("host-state error map", () => {
  test("PortUnreachableError maps to host-unreachable with null code", () => {
    const mapped = hostStateErrorOf(new PortUnreachableError("laptop-a: host_unreachable"));
    expect(mapped).toBeInstanceOf(HostStateError);
    expect(mapped?.failure).toBe("host-unreachable");
    expect(mapped?.code).toBeNull();
  });

  test("SDK-built unreachable errors map to host-unreachable with the SDK code", async () => {
    const statics = await clientErrorStatics();
    const errors: readonly unknown[] = [
      statics.daemonUnreachable("/tmp/sock", new Error("down")),
      statics.hostUnreachable("route-x", new Error("down")),
      fakeErrors.hostUnreachable("route-x"),
      statics.remoteDaemonUnavailable("route-x"),
      statics.io(new Error("broken")),
      statics.framing("truncated"),
    ];
    const expected: readonly string[] = [
      "daemon_unreachable",
      "host_unreachable",
      "host_unreachable",
      "remote_daemon_unavailable",
      "io_error",
      "framing",
    ];
    for (let i = 0; i < errors.length; i += 1) {
      const mapped = hostStateErrorOf(errors[i]);
      expect(mapped).toBeInstanceOf(HostStateError);
      expect(mapped?.failure).toBe("host-unreachable");
      expect(mapped?.code).toBe(expected[i]);
    }
  });

  test("SDK-built requestTimeout maps to request-timeout", async () => {
    const statics = await clientErrorStatics();
    for (const error of [
      statics.requestTimeout("host-a", 5),
      fakeErrors.requestTimeout("host-a"),
    ]) {
      const mapped = hostStateErrorOf(error);
      expect(mapped?.failure).toBe("request-timeout");
      expect(mapped?.code).toBe("request_timeout");
    }
  });

  test("SDK-built unsupported errors map to daemon-unsupported", async () => {
    const statics = await clientErrorStatics();
    const errors: readonly unknown[] = [
      statics.commandUnsupported("host-a"),
      statics.daemonProtocolTooOld({
        host: undefined,
        method: "command.run",
        daemonVersion: 3,
        requiredVersion: 4,
      }),
    ];
    const expected: readonly string[] = ["command_unsupported", "daemon_protocol_too_old"];
    for (let i = 0; i < errors.length; i += 1) {
      const mapped = hostStateErrorOf(errors[i]);
      expect(mapped?.failure).toBe("daemon-unsupported");
      expect(mapped?.code).toBe(expected[i]);
    }
  });

  test("SDK-built rejected errors map to daemon-rejected", async () => {
    const statics = await clientErrorStatics();
    const errors: readonly unknown[] = [
      statics.versionMismatch({ minimum: 3, maximum: 3 }, 4),
      fakeErrors.versionMismatch(),
      statics.versionTranslation(undefined, 3, new Error("stale")),
      statics.json(new Error("truncated")),
    ];
    const expected: readonly string[] = [
      "version_mismatch",
      "version_mismatch",
      "version_translation_failed",
      "json_error",
    ];
    for (let i = 0; i < errors.length; i += 1) {
      const mapped = hostStateErrorOf(errors[i]);
      expect(mapped?.failure).toBe("daemon-rejected");
      expect(mapped?.code).toBe(expected[i]);
    }
  });

  for (const code of [
    "command_unsupported",
    "command_package_not_installed",
    "command_not_selected",
    "command_not_declared",
    "command_package_disabled",
    "command_busy",
    "command_unavailable",
    "command_timed_out",
    "command_output_too_large",
    "command_output_not_utf8",
    "command_not_exposed",
    "bad_request",
  ] as const) {
    test(`protocol ${code} maps through its row`, async () => {
      const mapped = hostStateErrorOf(await localRunError(code));
      expect(mapped).toBeInstanceOf(HostStateError);
      expect(mapped?.code).toBe(code);
    });
    test(`remoteProtocol ${code} maps through its row`, async () => {
      const mapped = hostStateErrorOf(await remoteRunError(code));
      expect(mapped).toBeInstanceOf(HostStateError);
      expect(mapped?.code).toBe(code);
    });
  }

  test("protocol and remote command rows give the K7 failures", async () => {
    const expected = {
      command_unsupported: "daemon-unsupported",
      command_package_not_installed: "plugin-missing",
      command_not_selected: "plugin-missing",
      command_not_declared: "plugin-missing",
      command_package_disabled: "plugin-disabled",
      command_busy: "plugin-busy",
      command_unavailable: "daemon-rejected",
      command_timed_out: "plugin-timeout",
      command_output_too_large: "output-too-large",
      command_output_not_utf8: "output-invalid",
      command_not_exposed: "daemon-rejected",
      bad_request: "daemon-rejected",
    } as const;
    for (const [code, failure] of Object.entries(expected)) {
      expect(hostStateErrorOf(await localRunError(code))?.failure).toBe(failure);
      expect(hostStateErrorOf(await remoteRunError(code))?.failure).toBe(failure);
    }
  });

  test("command_failed with exit_code maps to exit-<n>", async () => {
    const mapped = hostStateErrorOf(
      await localRunError("command_failed", { process_exit: { exit_code: 3 } }),
    );
    expect(mapped?.failure).toBe("plugin-failed");
    expect(mapped?.code).toBe("exit-3");
  });

  test("command_failed with signal maps to signal-<n>", async () => {
    const mapped = hostStateErrorOf(
      await localRunError("command_failed", { process_exit: { signal: 9 } }),
    );
    expect(mapped?.failure).toBe("plugin-failed");
    expect(mapped?.code).toBe("signal-9");
  });

  for (const details of [
    undefined,
    { process_exit: { exit_code: 3, signal: 9 } },
    { process_exit: { exit_code: 1.5 } },
    { process_exit: { exit_code: 0 } },
    { process_exit: { signal: 0 } },
    { process_exit: {} },
    { other: 1 },
  ] as const) {
    test(`command_failed with ${JSON.stringify(details)} keeps command_failed`, async () => {
      const mapped = hostStateErrorOf(await localRunError("command_failed", details));
      expect(mapped?.failure).toBe("plugin-failed");
      expect(mapped?.code).toBe("command_failed");
    });
  }

  test("method_not_found maps through the SDK to daemon-unsupported", async () => {
    const mapped = hostStateErrorOf(await remoteRunError("method_not_found"));
    expect(mapped?.failure).toBe("daemon-unsupported");
    expect(mapped?.code).toBe("command_unsupported");
  });

  test("route names never reach the HostStateError message", async () => {
    const statics = await clientErrorStatics();
    const host = hostStateErrorOf(statics.hostUnreachable("route-x", new Error("down")));
    expect(host?.message).toContain("host-unreachable");
    expect(host?.message).not.toContain("route-x");
    const remoteErr = hostStateErrorOf(
      statics.remoteProtocol("route-y", protocolSource("bad_request")),
    );
    expect(remoteErr?.message).toContain("daemon-rejected");
    expect(remoteErr?.message).toContain("bad_request");
    expect(remoteErr?.message).not.toContain("route-y");
  });

  test("the null group maps to null", async () => {
    const statics = await clientErrorStatics();
    expect(hostStateErrorOf(new PortRejectedError("connector-closed"))).toBeNull();
    expect(hostStateErrorOf(new Error("boom"))).toBeNull();
    expect(hostStateErrorOf("x")).toBeNull();
    expect(hostStateErrorOf(statics.lifecycleOutcomeUnknown("stop", "host-a", 5))).toBeNull();
    expect(hostStateErrorOf(fakeErrors.resumeOutcomeUnknown("host-a"))).toBeNull();
  });
});

describe("host-state reply", () => {
  test("the result shape gives the identity and stdout verbatim", () => {
    const stdout = '{"schemaVersion":"v1"}\n';
    const reply = hostStateReplyOf(resultFor(stdout));
    expect(reply).toEqual({
      identity: { packageId: "moc.host-state", version: "0.2.0", digest: DIGEST },
      stdout,
    });
  });

  test("a missing digest gives daemon-rejected (reply-incomplete)", () => {
    const result = resultFor("out");
    delete result["digest"];
    expect(() => hostStateReplyOf(result)).toThrow(
      new HostStateError("daemon-rejected", "reply-incomplete"),
    );
  });

  test("an empty version gives daemon-rejected (reply-incomplete)", () => {
    const result = resultFor("out");
    result["package"] = { id: "moc.host-state", version: "" };
    expect(() => hostStateReplyOf(result)).toThrow(
      new HostStateError("daemon-rejected", "reply-incomplete"),
    );
  });

  test("a numeric output gives daemon-rejected (reply-incomplete)", () => {
    const result = resultFor("out");
    result["output"] = 7;
    expect(() => hostStateReplyOf(result)).toThrow(
      new HostStateError("daemon-rejected", "reply-incomplete"),
    );
  });
});

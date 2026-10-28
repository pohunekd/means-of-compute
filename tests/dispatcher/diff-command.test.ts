// dispatch:diff command tests (PR 3c C2): the daemon diff prints on
// stdout with exit 0; truncation warns; unreachable and missing sessions
// exit 2 with one line; bad flags never open the port. The fake daemon
// stands in for the host; real Clients run over the Transport seam.
import { expect, test } from "bun:test";
import { createFakeDaemon } from "../../src/dispatcher/adapter/fake-daemon.js";
import { createPohunekPort } from "../../src/dispatcher/adapter/pohunek-port.js";
import type { PohunekAdapterConfig } from "../../src/dispatcher/adapter/config.js";
import { runDiffCommand } from "../../src/dispatcher/diff-command.js";
import {
  PortRejectedError,
  type DispatcherPort,
  type SessionRef,
} from "../../src/dispatcher/port.js";

const CONFIG: PohunekAdapterConfig = {
  agentProfile: "moc-worker",
  project: "means-of-compute",
  cols: 200,
  rows: 50,
  inputAckTimeoutMs: 8000,
  connectTimeoutMs: 5000,
  cancelWaitTimeoutMs: 30000,
  diffLogPath: "logs/dispatch-diff.jsonl",
  hostRoutesFileEnv: "MOC_HOST_ROUTES_FILE",
};

const DIFF_TEXT = "diff --git a/item.md b/item.md\n+done\n";

interface CommandHarness {
  readonly fake: ReturnType<typeof createFakeDaemon>;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly counts: { opens: number; closes: number };
  openPort(): Promise<DispatcherPort>;
}

function harness(): CommandHarness {
  const fake = createFakeDaemon(["laptop-a"], CONFIG.agentProfile);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const counts = { opens: 0, closes: 0 };
  return {
    fake,
    stdout,
    stderr,
    counts,
    openPort: () => {
      counts.opens += 1;
      const port = createPohunekPort(CONFIG, {
        connector: fake.connector,
        log: () => undefined,
        meterToken: null,
      });
      const wrapped: DispatcherPort = {
        ...port,
        close: () => {
          counts.closes += 1;
          return port.close();
        },
      };
      return Promise.resolve(wrapped);
    },
  };
}

async function teardown(h: CommandHarness): Promise<void> {
  await h.fake.connector.close();
}

async function startSession(h: CommandHarness): Promise<SessionRef> {
  const setup = createPohunekPort(CONFIG, {
    connector: h.fake.connector,
    log: () => undefined,
    meterToken: (rid: string) => "moc1." + rid + ".T",
  });
  const handle = await setup.start({
    requestId: "req-1",
    workItemId: "item-1",
    repo: "example-repo",
    hostAlias: "laptop-a",
    branch: "moc/item-1",
    baseRef: "origin/main",
    resume: false,
    model: { providerId: "test-provider", model: "test-model" },
    brief: "do the thing",
  });
  return { sessionId: handle.sessionId, hostAlias: "laptop-a" };
}

test("diff prints the daemon diff and exits 0", async () => {
  const h = harness();
  try {
    const ref = await startSession(h);
    h.fake.setDiff("laptop-a", ref.sessionId, {
      diff: DIFF_TEXT,
      base: "origin/main",
      truncated: false,
    });
    const before = { ...h.counts };
    const rc = await runDiffCommand(
      ["--host", "laptop-a", "--session", ref.sessionId, "--base", "origin/main"],
      () => h.openPort(),
      {
        stdout: (text) => {
          h.stdout.push(text);
        },
        stderr: (line) => {
          h.stderr.push(line);
        },
      },
    );
    expect(rc).toBe(0);
    expect(h.stdout).toEqual([DIFF_TEXT]);
    expect(h.stderr).toEqual([]);
    expect(h.counts.opens).toBe(before.opens + 1);
    expect(h.counts.closes).toBe(before.closes + 1);
  } finally {
    await teardown(h);
  }
});

test("a truncated diff warns on stderr", async () => {
  const h = harness();
  try {
    const ref = await startSession(h);
    h.fake.setDiff("laptop-a", ref.sessionId, {
      diff: DIFF_TEXT,
      base: "origin/main",
      truncated: true,
    });
    const rc = await runDiffCommand(
      ["--host", "laptop-a", "--session", ref.sessionId, "--base", "origin/main"],
      () => h.openPort(),
      {
        stdout: (text) => {
          h.stdout.push(text);
        },
        stderr: (line) => {
          h.stderr.push(line);
        },
      },
    );
    expect(rc).toBe(0);
    expect(h.stdout).toEqual([DIFF_TEXT]);
    expect(h.stderr).toEqual(["diff truncated by daemon"]);
  } finally {
    await teardown(h);
  }
});

test("an unreachable host exits 2 with one line", async () => {
  const h = harness();
  try {
    await startSession(h);
    h.fake.setUnreachable("laptop-a", true);
    const before = { ...h.counts };
    const rc = await runDiffCommand(
      ["--host", "laptop-a", "--session", "fake-1", "--base", "origin/main"],
      () => h.openPort(),
      {
        stdout: (text) => {
          h.stdout.push(text);
        },
        stderr: (line) => {
          h.stderr.push(line);
        },
      },
    );
    expect(rc).toBe(2);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual(["dispatch: laptop-a: unreachable"]);
    expect(h.counts.opens).toBe(before.opens + 1);
    expect(h.counts.closes).toBe(before.closes + 1);
  } finally {
    await teardown(h);
  }
});

test("a missing session exits 2 with its code", async () => {
  const h = harness();
  try {
    const before = { ...h.counts };
    const rc = await runDiffCommand(
      ["--host", "laptop-a", "--session", "no-such-session", "--base", "origin/main"],
      () => h.openPort(),
      {
        stdout: (text) => {
          h.stdout.push(text);
        },
        stderr: (line) => {
          h.stderr.push(line);
        },
      },
    );
    expect(rc).toBe(2);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual(["dispatch: laptop-a: session-not-found"]);
    expect(h.counts.opens).toBe(before.opens + 1);
    expect(h.counts.closes).toBe(before.closes + 1);
  } finally {
    await teardown(h);
  }
});

test("a rejected diff prints the code, not the message", async () => {
  let closes = 0;
  const stub: DispatcherPort = {
    start: () => Promise.reject(new Error("unused")),
    wait: () => Promise.reject(new Error("unused")),
    diff: () => Promise.reject(new PortRejectedError("session-not-found", "unknown session x")),
    cancel: () => Promise.reject(new Error("unused")),
    close: () => {
      closes += 1;
      return Promise.resolve();
    },
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const rc = await runDiffCommand(
    ["--host", "laptop-a", "--session", "x", "--base", "origin/main"],
    () => Promise.resolve(stub),
    {
      stdout: (text) => {
        stdout.push(text);
      },
      stderr: (line) => {
        stderr.push(line);
      },
    },
  );
  expect(rc).toBe(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["dispatch: laptop-a: session-not-found"]);
  expect(closes).toBe(1);
});

const BAD_FLAG_CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["no --base", ["--host", "laptop-a", "--session", "fake-1"]],
  ["--host twice", ["--host", "laptop-a", "--host", "laptop-a", "--session", "s", "--base", "b"]],
  [
    "unknown flag",
    ["--host", "laptop-a", "--session", "fake-1", "--base", "origin/main", "--bogus", "x"],
  ],
];

for (const [name, args] of BAD_FLAG_CASES) {
  test(`bad flags exit 2 without opening the port: ${name}`, async () => {
    const h = harness();
    try {
      const rc = await runDiffCommand(args, () => h.openPort(), {
        stdout: (text) => {
          h.stdout.push(text);
        },
        stderr: (line) => {
          h.stderr.push(line);
        },
      });
      expect(rc).toBe(2);
      expect(h.stdout).toEqual([]);
      expect(h.stderr).toHaveLength(1);
      expect(h.stderr[0]?.startsWith("dispatch: ")).toBe(true);
      expect(h.counts.opens).toBe(0);
    } finally {
      await teardown(h);
    }
  });
}

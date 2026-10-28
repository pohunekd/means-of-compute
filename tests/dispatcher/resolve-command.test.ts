// dispatch:resolve CLI tests (53c, design 5.2): the command prints one
// JSON line with exit 0, maps refusals to exit 3 with the request id,
// never prints a port message or route, never opens the runtime on bad
// flags, and maps an unknown request to exit 2. The withRuntime helper
// builds a real dispatcher over the memory port; temp registry and ledger
// paths; no timers and no real host.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import {
  createDispatcher,
  type ResolveOutcome,
} from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import { FileLockError } from "../../src/fs/lock.js";
import type { ModelSelection, ReleaseRef, ReleaseResult } from "../../src/dispatcher/port.js";
import { PortUnreachableError } from "../../src/dispatcher/port.js";
import { runResolveCommand } from "../../src/dispatcher/resolve-command.js";

const MODEL: ModelSelection = { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" };

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

function queuedItem(id: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo",
    title: "Demo item",
    goal: "Exercise resolve",
    issue: 53,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: "meta/muse-glimmer-30b", attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
  };
}

function decision(itemId: string, hostAlias: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId: itemId,
    chosenHostAlias: hostAlias,
    reason: "test decision",
    candidates: [{ hostAlias, score: 1, reason: "only host", excluded: false }],
  };
}

interface CommandHarness {
  readonly withRuntime: <T>(
    use: (resolve: (requestId: string) => Promise<ResolveOutcome>) => Promise<T>,
  ) => Promise<T>;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly calls: { withRuntime: number };
  readonly control: ReturnType<typeof createMemoryPort>;
  provisionProvisional(): Promise<void>;
  provisionActive(): Promise<void>;
}

async function withCommandHarness(
  body: (h: CommandHarness) => Promise<void>,
  options: { readonly release?: (ref: ReleaseRef) => Promise<ReleaseResult> } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-resolve-command-"));
  try {
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      nonTerminalPauseMs: 0,
      registryPath: join(dir, "registry.json"),
    };
    const control = createMemoryPort();
    const port = options.release === undefined
      ? control.port
      : { ...control.port, release: options.release };
    const dispatcher = createDispatcher({
      port,
      budget: GATE,
      ledgerPath: join(dir, "ledger.jsonl"),
      config,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      lostUsage: () => Promise.resolve(null),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const calls = { withRuntime: 0 };
    const harness: CommandHarness = {
      withRuntime: (use) => {
        calls.withRuntime += 1;
        return use((requestId) => dispatcher.resolve(requestId));
      },
      stdout,
      stderr,
      calls,
      control,
      provisionProvisional: async () => {
        control.setUnreachable("laptop-a", true);
        let startError: unknown = null;
        try {
          await dispatcher.start(
            queuedItem("demo-item") as never,
            decision("demo-item", "laptop-a") as never,
            MODEL,
            "Do the work.",
          );
        } catch (error: unknown) {
          startError = error;
        }
        expect(startError).toBeInstanceOf(PortUnreachableError);
        control.setUnreachable("laptop-a", false);
      },
      provisionActive: async () => {
        const started = await dispatcher.start(
          queuedItem("demo-item") as never,
          decision("demo-item", "laptop-a") as never,
          MODEL,
          "Do the work.",
        );
        expect(started.kind).toBe("started");
      },
    };
    await body(harness);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("resolved prints one JSON line", async () => {
  await withCommandHarness(async (h) => {
    await h.provisionProvisional();
    const rc = await runResolveCommand(["--request", "demo-item:0"], h.withRuntime, {
      stdout: (line) => h.stdout.push(line),
      stderr: (line) => h.stderr.push(line),
    });
    expect(rc).toBe(0);
    expect(h.stdout).toEqual([
      '{"requestId":"demo-item:0","hostAlias":"laptop-a","outcome":"resolved","from":"provisional","state":"lost","stopped":[],"ledger":"appended"}',
    ]);
    expect(h.stderr).toEqual([]);
  });
});

test("already-resolved exits 0", async () => {
  await withCommandHarness(async (h) => {
    await h.provisionProvisional();
    const first = await runResolveCommand(["--request", "demo-item:0"], h.withRuntime, {
      stdout: (line) => h.stdout.push(line),
      stderr: (line) => h.stderr.push(line),
    });
    expect(first).toBe(0);
    const rc = await runResolveCommand(["--request", "demo-item:0"], h.withRuntime, {
      stdout: (line) => h.stdout.push(line),
      stderr: (line) => h.stderr.push(line),
    });
    expect(rc).toBe(0);
    expect(h.stdout).toHaveLength(2);
    expect(h.stdout[1]).toBe(
      '{"requestId":"demo-item:0","hostAlias":"laptop-a","outcome":"already-resolved","state":"lost","ledger":"none"}',
    );
    expect(h.stderr).toEqual([]);
  });
});

test("refusals exit 3 with the request id", async () => {
  await withCommandHarness(async (h) => {
    await h.provisionProvisional();
    h.control.setUnreachable("laptop-a", true);
    const rc = await runResolveCommand(["--request", "demo-item:0"], h.withRuntime, {
      stdout: (line) => h.stdout.push(line),
      stderr: (line) => h.stderr.push(line),
    });
    expect(rc).toBe(3);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual(["dispatch: demo-item:0: unreachable"]);
  });
  await withCommandHarness(async (h) => {
    await h.provisionProvisional();
    h.control.refuseRelease("laptop-a", "void-incomplete");
    const rc = await runResolveCommand(["--request", "demo-item:0"], h.withRuntime, {
      stdout: (line) => h.stdout.push(line),
      stderr: (line) => h.stderr.push(line),
    });
    expect(rc).toBe(3);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual(["dispatch: demo-item:0: void-incomplete"]);
  });
  await withCommandHarness(async (h) => {
    await h.provisionActive();
    const rc = await runResolveCommand(["--request", "demo-item:0"], h.withRuntime, {
      stdout: (line) => h.stdout.push(line),
      stderr: (line) => h.stderr.push(line),
    });
    expect(rc).toBe(3);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual(["dispatch: demo-item:0: request-active"]);
  });
});

test("a route never reaches the output", async () => {
  await withCommandHarness(
    async (h) => {
      await h.provisionProvisional();
      const rc = await runResolveCommand(["--request", "demo-item:0"], h.withRuntime, {
        stdout: (line) => h.stdout.push(line),
        stderr: (line) => h.stderr.push(line),
      });
      expect(rc).toBe(3);
      expect(h.stdout).toEqual([]);
      expect(h.stderr).toEqual(["dispatch: demo-item:0: unreachable"]);
      expect(h.stdout.join("\n")).not.toContain("peer.example-route");
      expect(h.stderr.join("\n")).not.toContain("peer.example-route");
    },
    {
      release: () =>
        Promise.reject(new PortUnreachableError("peer.example-route: host_unreachable")),
    },
  );
});

test("a busy registry exits 3", async () => {
  await withCommandHarness(async (h) => {
    const busy = <T,>(): Promise<T> =>
      Promise.reject(new FileLockError("busy", "Dispatcher registry /tmp/x: busy"));
    const rc = await runResolveCommand(["--request", "demo-item:0"], busy, {
      stdout: (line) => h.stdout.push(line),
      stderr: (line) => h.stderr.push(line),
    });
    expect(rc).toBe(3);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual(["dispatch: registry busy"]);
  });
});

test("bad flags exit 2 without a runtime", async () => {
  const cases: readonly string[][] = [
    [],
    ["--request", "demo-item:0", "--request", "demo-item:1"],
    ["--bogus", "x"],
    ["--request"],
  ];
  for (const args of cases) {
    await withCommandHarness(async (h) => {
      const rc = await runResolveCommand(args, h.withRuntime, {
        stdout: (line) => h.stdout.push(line),
        stderr: (line) => h.stderr.push(line),
      });
      expect(rc).toBe(2);
      expect(h.stdout).toEqual([]);
      expect(h.stderr).toHaveLength(1);
      expect(h.stderr[0]?.startsWith("dispatch: ")).toBe(true);
      expect(h.calls.withRuntime).toBe(0);
    });
  }
});

test("an unknown request exits 2", async () => {
  await withCommandHarness(async (h) => {
    const rc = await runResolveCommand(["--request", "demo-item:0"], h.withRuntime, {
      stdout: (line) => h.stdout.push(line),
      stderr: (line) => h.stderr.push(line),
    });
    expect(rc).toBe(2);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toHaveLength(1);
    expect(h.stderr[0]?.startsWith("dispatch: dispatcher precondition known-request: ")).toBe(
      true,
    );
  });
});

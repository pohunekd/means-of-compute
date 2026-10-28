// dispatch:resolve CLI tests (53c, design 5.2): the command prints one
// JSON line with exit 0, maps refusals to exit 3 with the request id,
// never prints a port message or route, never opens the runtime on bad
// flags, and maps an unknown request to exit 2. The withRuntime helper
// builds a real dispatcher over the memory port; temp registry and ledger
// paths; no timers and no real host.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher, type ResolveOutcome } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import { FileLockError, withFileLock } from "../../src/fs/lock.js";
import type { ModelSelection, ReleaseRef, ReleaseResult } from "../../src/dispatcher/port.js";
import { PortRejectedError, PortUnreachableError } from "../../src/dispatcher/port.js";
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
    const port =
      options.release === undefined ? control.port : { ...control.port, release: options.release };
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
  await withCommandHarness(
    async (h) => {
      await h.provisionProvisional();
      const rc = await runResolveCommand(["--request", "demo-item:0"], h.withRuntime, {
        stdout: (line) => h.stdout.push(line),
        stderr: (line) => h.stderr.push(line),
      });
      expect(rc).toBe(3);
      expect(h.stdout).toEqual([]);
      expect(h.stderr).toEqual(["dispatch: demo-item:0: void-incomplete"]);
      expect(h.stdout.join("\n")).not.toContain("peer.example-route");
      expect(h.stderr.join("\n")).not.toContain("peer.example-route");
    },
    {
      release: () =>
        Promise.reject(new PortRejectedError("void-incomplete", "peer.example-route: refused")),
    },
  );
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
    const busy = <T>(): Promise<T> =>
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
    expect(h.stderr[0]?.startsWith("dispatch: dispatcher precondition known-request: ")).toBe(true);
  });
});

async function runResolveCli(
  dir: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly rc: number }> {
  const proc = Bun.spawn(
    ["bun", join(process.cwd(), "src/dispatcher/cli.ts"), "resolve", ...args],
    {
      cwd: dir,
      env: { ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, rc] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, rc };
}

async function withConfigCopy(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-resolve-cli-"));
  try {
    cpSync(join(process.cwd(), "config"), join(dir, "config"), { recursive: true });
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function envWithoutMoc(): Record<string, string | undefined> {
  const kept: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("MOC_")) {
      kept[key] = value;
    }
  }
  return kept;
}

test("a bad flag opens nothing", async () => {
  await withConfigCopy(async (dir) => {
    const { stdout, stderr, rc } = await runResolveCli(dir, ["--bogus", "x"], envWithoutMoc());
    expect(rc).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe('dispatch: unknown flag "--bogus"\n');
    expect(existsSync(join(dir, "logs"))).toBe(false);
  });
});

test("a held registry lock exits 3", async () => {
  await withConfigCopy(async (dir) => {
    await mkdir(join(dir, "logs"), { recursive: true });
    const addressesFile = join(dir, "host-addresses.json");
    await writeFile(addressesFile, JSON.stringify({ "laptop-a": ["10.0.0.1"] }), "utf8");
    const env: Record<string, string | undefined> = {
      ...envWithoutMoc(),
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: randomBytes(32).toString("base64"),
      MOC_METER_HOST_ADDRESSES_FILE: addressesFile,
      NVIDIA_API_KEY: "test-nvidia-key",
      META_API_KEY: "test-meta-key",
    };
    const registryPath = join(dir, "logs", "dispatcher-sessions.json");
    await withFileLock("Dispatcher resolve test", registryPath, async () => {
      const { stdout, stderr, rc } = await runResolveCli(dir, ["--request", "demo-item:0"], env);
      expect(rc).toBe(3);
      expect(stdout).toBe("");
      expect(stderr.split("\n")).toEqual(["dispatch: registry busy", ""]);
    });
  });
});

test("an unknown request with no logs directory is a precondition error", async () => {
  await withConfigCopy(async (dir) => {
    const addressesFile = join(dir, "host-addresses.json");
    await writeFile(addressesFile, JSON.stringify({ "laptop-a": ["10.0.0.1"] }), "utf8");
    const routesFile = join(dir, "host-routes.json");
    await writeFile(routesFile, JSON.stringify({ "laptop-a": "route" }), "utf8");
    const runtimeBase = "/tmp/r";
    await mkdir(runtimeBase, { recursive: true });
    const runtimeDir = join(runtimeBase, "pohunek");
    await mkdir(runtimeDir, { recursive: true });
    await chmod(runtimeDir, 0o700);
    const env: Record<string, string | undefined> = {
      ...envWithoutMoc(),
      MOC_METER_LISTEN: "127.0.0.1:0",
      MOC_METER_SECRET: randomBytes(32).toString("base64"),
      MOC_METER_HOST_ADDRESSES_FILE: addressesFile,
      MOC_HOST_ROUTES_FILE: routesFile,
      XDG_RUNTIME_DIR: runtimeBase,
      NVIDIA_API_KEY: "test-nvidia-key",
      META_API_KEY: "test-meta-key",
    };
    const { stdout, stderr, rc } = await runResolveCli(dir, ["--request", "demo-item:0"], env);
    expect(rc).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.trim()).toMatch(/^dispatch: dispatcher precondition known-request:/);
    expect(stderr.trim().split("\n")).toHaveLength(1);
  });
});

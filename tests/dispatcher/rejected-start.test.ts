// Rejected-start tests (#56): a rejection with a meter grant becomes a
// terminal failed attempt on its own requestId, so the retry derives n + 1;
// a rejection with no grant keeps the removal; a crash between the settle
// and the registry write replays through lost.
// Deterministic: metered port with recorded fixtures, temp ledger/registry.
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type {
  DispatcherPort,
  ModelSelection,
  StartRequest,
} from "../../src/dispatcher/port.js";
import { PortRejectedError } from "../../src/dispatcher/port.js";
import { readRegistry } from "../../src/dispatcher/registry.js";
import * as registryModule from "../../src/dispatcher/registry.js";
import { createMeteredPort } from "../../src/meter/metered-port.js";
import { readLedger } from "../../src/ledger/read.js";
import { withMeter } from "../meter/helpers.js";

const MODEL: ModelSelection = { providerId: "meta-api", model: "muse-spark-1.3-contributor" };

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

function item(id: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo",
    title: `Demo item ${id}`,
    goal: "Exercise the rejected start",
    issue: 56,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: {
      preferredModel: "muse-spark-1.3-contributor",
      attempts: 0,
      fallbackUsed: false,
    },
    retryCount: 0,
    stallRounds: 0,
  };
}

function decision(workItemId: string, hostAlias: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId,
    chosenHostAlias: hostAlias,
    reason: "test decision",
    candidates: [{ hostAlias, score: 1, reason: "only host", excluded: false }],
  };
}

function configOf(registryPath: string, lostAfterUnreachable = 3): DispatcherConfig {
  return {
    baseBranch: "main",
    branchPrefix: "moc/",
    waitTimeoutMs: 1000,
    lostAfterUnreachable,
    unreachableBackoffMs: 0,
    nonTerminalPauseMs: 0,
    registryPath,
  };
}

// The K-replay spy is restored here too, so a test that ends early cannot
// leak its rejecting mockImplementationOnce into another test.
afterEach(() => {
  mock.restore();
});

function rejectOn(hostAlias: string, code: string) {
  return (control: ReturnType<typeof createMemoryPort>): DispatcherPort => ({
    ...control.port,
    start(request: StartRequest) {
      if (request.hostAlias === hostAlias) {
        return Promise.reject(new PortRejectedError(code, `${code} for ${hostAlias}`));
      }
      return control.port.start(request);
    },
  });
}

test("a rejection with a grant ledgers a failure and the retry starts on n + 1", async () => {
  await withMeter(
    "tests/meter/recordings/stream-ok.json",
    async ({ meter }) => {
      const dir = await mkdtemp(join(tmpdir(), "dispatch-rejected-grant-"));
      try {
        const ledgerPath = join(dir, "ledger.jsonl");
        const registryPath = join(dir, "registry.json");
        const control = createMemoryPort();
        const port = createMeteredPort(rejectOn("laptop-a", "host-unsupported")(control), meter, () => {});
        const events: Array<Record<string, unknown>> = [];
        const dispatcher = createDispatcher({
          port,
          budget: GATE,
          ledgerPath,
          config: configOf(registryPath),
          now: () => new Date("2026-10-27T10:00:00.000Z"),
          sleep: () => Promise.resolve(),
          log: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
          settleUsage: (requestId, state) => meter.settleRequest(requestId, state),
        });
        let firstError: unknown;
        try {
          await dispatcher.start(
            item("w56-demo") as never,
            decision("w56-demo", "laptop-a") as never,
            MODEL,
            "Do the work.",
          );
        } catch (error: unknown) {
          firstError = error;
        }
        expect(firstError).toBeInstanceOf(PortRejectedError);
        expect((firstError as PortRejectedError).code).toBe("host-unsupported");
        const stored = await readRegistry(registryPath);
        expect(stored).toHaveLength(1);
        expect(stored[0]?.terminal?.state).toBe("failed");
        expect(stored[0]?.terminal?.detail).toBe("start-rejected: host-unsupported");
        expect(stored[0]?.terminal?.seconds).toBe(0);
        expect(stored[0]?.terminal?.ledgerAppended).toBe(true);
        const contents = await readLedger("Test ledger", ledgerPath);
        expect(contents.pending).toHaveLength(1);
        expect(contents.pending[0]?.entryId).toBe("w56-demo:w56-demo:0");
        expect(contents.pending[0]?.session?.result).toBe("failure");
        expect(contents.pending[0]?.tokens).toHaveLength(1);
        expect(contents.pending[0]?.tokens[0]?.requests).toBe(0);
        expect(
          events.some(
            (event) =>
              event["event"] === "start-rejected-ledgered" &&
              event["requestId"] === "w56-demo:0",
          ),
        ).toBe(true);
        // The failure consumed n = 0, so the retry on another host gets a
        // fresh grant under a fresh requestId.
        const retry = await dispatcher.start(
          item("w56-demo") as never,
          decision("w56-demo", "laptop-b") as never,
          MODEL,
          "Do the work.",
        );
        if (retry.kind !== "started") {
          throw new Error(`expected the retry to start, got ${retry.kind}`);
        }
        expect(retry.request.requestId).toBe("w56-demo:1");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { hosts: { "laptop-a": ["127.0.0.1"], "laptop-b": ["127.0.0.2"] } },
  );
});

test("a rejection with no grant removes the entry and leaves the ledger alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-rejected-nogrant-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const dispatcher = createDispatcher({
      port: rejectOn("laptop-a", "host-unsupported")(control),
      budget: GATE,
      ledgerPath,
      config: configOf(registryPath),
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      settleUsage: () => Promise.resolve(null),
    });
    let error: unknown;
    try {
      await dispatcher.start(
        item("w56-nogrant") as never,
        decision("w56-nogrant", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PortRejectedError);
    expect(await readRegistry(registryPath)).toHaveLength(0);
    const contents = await readLedger("Test ledger", ledgerPath);
    expect(contents.pending).toHaveLength(0);
    expect(contents.records).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a crash between the settle and the registry write replays through lost", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter }) => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-rejected-crash-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      const registryPath = join(dir, "registry.json");
      const control = createMemoryPort();
      const port = createMeteredPort(rejectOn("laptop-a", "host-unsupported")(control), meter, () => {});
      const dispatcher = createDispatcher({
        port,
        budget: GATE,
        ledgerPath,
        config: configOf(registryPath, 1),
        now: () => new Date("2026-10-27T10:00:00.000Z"),
        sleep: () => Promise.resolve(),
        log: () => undefined,
        settleUsage: (requestId, state) => meter.settleRequest(requestId, state),
      });
      // The spy fails the first registry write inside finishRejected: the
      // grant is already closed, the entry is still provisional.
      const crashedWrite = spyOn(registryModule, "replaceRegistryEntry").mockImplementationOnce(
        () => Promise.reject(new Error("injected rejected-write failure")),
      );
      let failure: unknown;
      try {
        await dispatcher.start(
          item("w56-crash") as never,
          decision("w56-crash", "laptop-a") as never,
          MODEL,
          "Do the work.",
        );
      } catch (error: unknown) {
        failure = error;
      } finally {
        crashedWrite.mockRestore();
      }
      expect(String(failure)).toContain("injected rejected-write failure");
      const kept = await readRegistry(registryPath);
      expect(kept).toHaveLength(1);
      expect(kept[0]?.sessionId).toBeNull();
      expect(kept[0]?.terminal).toBeNull();
      // The replay meets the closed grant as grant-closed, which the port
      // surfaces as unreachable; finishLost settles the memoized join and
      // n advances through lost.
      const replayed = await dispatcher.start(
        item("w56-crash") as never,
        decision("w56-crash", "laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      if (replayed.kind !== "lost") {
        throw new Error(`expected the replay to end lost, got ${replayed.kind}`);
      }
      expect(replayed.requestId).toBe("w56-crash:0");
      const outcome = await dispatcher.watch(replayed.requestId);
      expect(outcome.result.state).toBe("lost");
      expect(outcome.result.sessionId).toBeNull();
      const contents = await readLedger("Test ledger", ledgerPath);
      expect(contents.pending).toHaveLength(1);
      expect(contents.pending[0]?.session?.result).toBe("lost");
      expect(contents.pending[0]?.tokens[0]?.requests).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

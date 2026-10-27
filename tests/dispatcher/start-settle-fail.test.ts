// K2b: a failed settle write keeps the provisional entry and one session.
// The settle write fails because the registry directory is read-only while
// the dispatcher writes it, so a regression that drops the provisional
// entry after a failed settle is observable: the entry stays, the port
// holds one live session, and a replayed start settles that same session.
// Deterministic: memory port, in-process switch gate, temp ledger and registry.
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as registryModule from "../../src/dispatcher/registry.js";
// Dynamic imports load the modules under test after the static helpers above.
const { createDispatcher } = await import("../../src/dispatcher/dispatcher.js");
const { createMemoryPort } = await import("../../src/dispatcher/memory-port.js");
const { readRegistry } = await import("../../src/dispatcher/registry.js");
const { createSwitchGate, gatePort } = await import("./gated-port.js");
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import type { ModelSelection } from "../../src/dispatcher/port.js";
import type { StartOutcome } from "../../src/dispatcher/dispatcher.js";

const MODEL: ModelSelection = { providerId: "nvidia-build", model: "meta/muse-glimmer-30b" };

function item(id: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id,
    repo: "example/demo",
    title: `Demo item ${id}`,
    goal: "Exercise the dispatcher settle failure",
    issue: 10,
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

function decision(workItemId: string, hostAlias: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId,
    chosenHostAlias: hostAlias,
    reason: "test decision",
    candidates: [{ hostAlias, score: 1, reason: "only host", excluded: false }],
  };
}

function startedOf(
  outcome: StartOutcome,
): asserts outcome is Extract<StartOutcome, { kind: "started" }> {
  if (outcome.kind !== "started") {
    throw new Error(`expected a started outcome, got ${outcome.kind}`);
  }
}

interface SettleHarness {
  readonly dir: string;
  readonly ledgerPath: string;
  readonly registryPath: string;
  readonly control: ReturnType<typeof createMemoryPort>;
  readonly starts: ReturnType<typeof gatePort>;
  readonly gate: ReturnType<typeof createSwitchGate>;
  readonly dispatcher: ReturnType<typeof createDispatcher>;
}

async function withHarness(body: (h: SettleHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-settle-fail-"));
  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const registryPath = join(dir, "registry.json");
    const control = createMemoryPort();
    const starts = gatePort(control.port, new Set(["start"]));
    const gate = createSwitchGate();
    const config: DispatcherConfig = {
      baseBranch: "main",
      branchPrefix: "moc/",
      waitTimeoutMs: 1000,
      lostAfterUnreachable: 3,
      unreachableBackoffMs: 0,
      registryPath,
    };
    const dispatcher = createDispatcher({
      port: starts.port,
      budget: gate.gate,
      config,
      ledgerPath,
      now: () => new Date("2026-10-27T10:00:00.000Z"),
      sleep: () => Promise.resolve(),
      log: () => undefined,
    });
    await body({ dir, ledgerPath, registryPath, control, starts, gate, dispatcher });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("K2b: a failed settle write keeps the provisional entry and one session", async () => {
  await withHarness(async ({ control, dispatcher, registryPath, starts }) => {
    const first = dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    const parked = await starts.next("start");
    // The spy is armed after the provisional insert, so only the settle
    // write fails; every later write (a wrongful removal included) passes.
    const settleWrite = spyOn(registryModule, "replaceRegistryEntry").mockImplementationOnce(
      () => Promise.reject(new Error("injected settle failure")),
    );
    let failure: unknown;
    try {
      await parked.release();
      await first;
    } catch (error) {
      failure = error;
    } finally {
      settleWrite.mockRestore();
    }
    expect(String(failure)).toContain("injected settle failure");
    // The provisional entry is still present and the port holds one live
    // session; no entry was removed after the failed settle.
    const kept = await readRegistry(registryPath);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.sessionId).toBeNull();
    expect(control.sessions()).toHaveLength(1);
    expect(starts.calls("start")).toBe(1);
    // A replayed start settles that same session.
    const second = dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    const parkedSecond = await starts.next("start");
    await parkedSecond.release();
    const outcome = await second;
    startedOf(outcome);
    const live = control.sessions()[0];
    if (live === undefined) {
      throw new Error("expected one live session in the port");
    }
    expect(outcome.handle.sessionId).toBe(live.handle.sessionId);
    const settled = await readRegistry(registryPath);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.sessionId).toBe(outcome.handle.sessionId);
  });
});

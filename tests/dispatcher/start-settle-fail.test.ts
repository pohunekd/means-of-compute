// K2b: a failed settle write keeps the provisional entry and one session.
// The settle write fails through an injected registry write failure, so a
// regression that drops the provisional entry after a failed settle is
// observable: the entry stays, the port holds one live session, and a
// replayed start settles that same session.
// Deterministic: memory port, in-process switch gate, temp ledger and registry.
import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Static import runs before the mock below, so this namespace keeps the
// original functions while later importers see the mocked module.
// Imported before the mock below, and copied by value: these stay the
// original functions while later importers see the mocked module.
const registryActual = await import("../../src/dispatcher/registry.js");
const realReplaceRegistryEntry = registryActual.replaceRegistryEntry;
let armed = true;
mock.module("../../src/dispatcher/registry.js", () => ({
  ...registryActual,
  replaceRegistryEntry: async (
    path: string,
    entry: import("../../src/dispatcher/registry.js").RegistryEntry,
  ): Promise<void> => {
    // Fail only the first settled write (the only write carrying a
    // session id in this test): the provisional insert and the
    // replayed settle both pass through.
    if (armed && entry.sessionId !== null) {
      armed = false;
      throw new Error("injected settle failure");
    }
    return realReplaceRegistryEntry(path, entry);
  },
}));

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

test("K2b: a failed settle write keeps the provisional entry and one session", async () => {
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
    const first = dispatcher.start(
      item("item-a") as never,
      decision("item-a", "laptop-a") as never,
      MODEL,
      "Do the work.",
    );
    const parked = await starts.next("start");
    await parked.release();
    let failure: unknown;
    try {
      await first;
    } catch (error) {
      failure = error;
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
    expect(outcome.handle.sessionId).toBe(control.sessions()[0]?.handle.sessionId);
    const settled = await readRegistry(registryPath);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.sessionId).toBe(outcome.handle.sessionId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

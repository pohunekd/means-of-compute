// Metered end-to-end tests (D1 of issue #35): a session whose agent
// calls the proxy gets real token counts in its UsageRecord. The
// dispatcher runs behind createMeteredPort, the model reaches the
// proxy through the loopback stub with recorded responses.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeUsage } from "../../src/ledger/store.js";
import { readLedger } from "../../src/ledger/read.js";
import { isUsageRecord } from "../../contracts/v1/validate.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { BudgetGate } from "../../src/budget/gate.js";
import { PortUnreachableError } from "../../src/dispatcher/port.js";
import { createMeteredPort } from "../../src/meter/metered-port.js";
import type { Meter } from "../../src/meter/meter.js";
import { meterUrl, withMeter } from "./helpers.js";

const MODEL = { providerId: "meta-api", model: "muse-spark-1.3-contributor" };

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id: "w1-demo",
    repo: "example/demo",
    title: "Demo item",
    goal: "Exercise the metered port",
    issue: 35,
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
    ...overrides,
  };
}

function decision(hostAlias: string): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId: "w1-demo",
    chosenHostAlias: hostAlias,
    reason: "test decision",
    candidates: [{ hostAlias, score: 1, reason: "only host", excluded: false }],
  };
}

function chatBody(): Record<string, unknown> {
  return {
    model: "moc-session",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  };
}

async function postCall(meter: Meter, requestId: string): Promise<void> {
  const resp = await fetch(meterUrl(meter), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${meter.tokenFor(requestId)}`,
    },
    body: JSON.stringify(chatBody()),
  });
  expect(resp.status).toBe(200);
  await resp.text();
}

test("a metered session records real counts", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async (fixture) => {
    const { meter, loopback } = fixture;
    const dir = mkdtempSync(join(tmpdir(), "meter-e2e-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      const config: DispatcherConfig = {
        baseBranch: "main",
        branchPrefix: "moc/",
        waitTimeoutMs: 1000,
        lostAfterUnreachable: 3,
        unreachableBackoffMs: 0,
        registryPath: join(dir, "registry.json"),
      };
      const control = createMemoryPort();
      const port = createMeteredPort(control.port, meter, () => {});
      const dispatcher = createDispatcher({
        port,
        budget: GATE,
        ledgerPath,
        config,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
        sleep: () => Promise.resolve(),
        log: () => undefined,
        lostUsage: (requestId) => meter.settleRequest(requestId, "lost"),
      });
      const started = await dispatcher.start(
        item() as never,
        decision("laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      if (started.kind !== "started") {
        throw new Error("expected a started session");
      }
      expect(started.kind).toBe("started");
      const { request, handle } = started;
      const requestId = request.requestId;
      await postCall(meter, requestId);
      await postCall(meter, requestId);
      control.complete(handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
      const outcome = await dispatcher.watch(requestId);
      const expected = [
        {
          provider: "meta-api",
          model: "muse-spark-1.3-contributor",
          inputTokens: 2400,
          outputTokens: 160,
          requests: 2,
          source: "meter-proxy",
        },
      ];
      expect(outcome.result.usage?.tokens).toEqual(expected);
      const contents = await readLedger("Test ledger", ledgerPath);
      expect(contents.pending).toHaveLength(1);
      expect(contents.pending[0]?.tokens).toEqual(expected);
      const finalized = await finalizeUsage(ledgerPath, {
        workItemId: "w1-demo",
        result: "success",
        retries: 0,
        humanInterventions: 0,
      });
      expect(finalized).toBe("appended");
      const after = await readLedger("Test ledger", ledgerPath);
      const recordLine = after.records.at(-1);
      expect(recordLine === undefined ? false : isUsageRecord(recordLine)).toBe(true);
      const refused = await fetch(meterUrl(meter), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${meter.tokenFor(requestId)}`,
        },
        body: JSON.stringify(chatBody()),
      });
      expect(refused.status).toBe(403);
      expect(loopback.requests().length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a lost session gets metered usage and is revoked", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async (fixture) => {
    const { meter } = fixture;
    const dir = mkdtempSync(join(tmpdir(), "meter-e2e-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      const config: DispatcherConfig = {
        baseBranch: "main",
        branchPrefix: "moc/",
        waitTimeoutMs: 1000,
        lostAfterUnreachable: 1,
        unreachableBackoffMs: 0,
        registryPath: join(dir, "registry.json"),
      };
      const control = createMemoryPort();
      const port = createMeteredPort(control.port, meter, () => {});
      const dispatcher = createDispatcher({
        port,
        budget: GATE,
        ledgerPath,
        config,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
        sleep: () => Promise.resolve(),
        log: () => undefined,
        lostUsage: (requestId) => meter.settleRequest(requestId, "lost"),
      });
      const started = await dispatcher.start(
        item() as never,
        decision("laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      if (started.kind !== "started") {
        throw new Error("expected a started session");
      }
      await postCall(meter, started.request.requestId);
      control.setUnreachable("laptop-a", true);
      const outcome = await dispatcher.watch(started.request.requestId);
      expect(outcome.attempt).toBe("lost");
      const expected = [
        {
          provider: "meta-api",
          model: "muse-spark-1.3-contributor",
          inputTokens: 1200,
          outputTokens: 80,
          requests: 1,
          source: "meter-proxy",
        },
      ];
      expect(outcome.result.usage?.tokens).toEqual(expected);
      const refused = await fetch(meterUrl(meter), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${meter.tokenFor(started.request.requestId)}`,
        },
        body: JSON.stringify(chatBody()),
      });
      expect(refused.status).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a provisional lost gets the measured zero row", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async (fixture) => {
    const { meter } = fixture;
    const dir = mkdtempSync(join(tmpdir(), "meter-e2e-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      const config: DispatcherConfig = {
        baseBranch: "main",
        branchPrefix: "moc/",
        waitTimeoutMs: 1000,
        lostAfterUnreachable: 1,
        unreachableBackoffMs: 0,
        registryPath: join(dir, "registry.json"),
      };
      const control = createMemoryPort();
      control.setUnreachable("laptop-a", true);
      const port = createMeteredPort(control.port, meter, () => {});
      const dispatcher = createDispatcher({
        port,
        budget: GATE,
        ledgerPath,
        config,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
        sleep: () => Promise.resolve(),
        log: () => undefined,
        lostUsage: (requestId) => meter.settleRequest(requestId, "lost"),
      });
      const outcome = await dispatcher.start(
        item() as never,
        decision("laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      if (outcome.kind !== "lost") {
        throw new Error("expected a lost start");
      }
      const contents = await readLedger("Test ledger", ledgerPath);
      expect(contents.pending).toHaveLength(1);
      expect(contents.pending[0]?.tokens).toEqual([
        {
          provider: "meta-api",
          model: "muse-spark-1.3-contributor",
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
          source: "meter-proxy",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a crash after settle replays to the same lost usage", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async (fixture) => {
    const { meter } = fixture;
    const dir = mkdtempSync(join(tmpdir(), "meter-e2e-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      const config: DispatcherConfig = {
        baseBranch: "main",
        branchPrefix: "moc/",
        waitTimeoutMs: 1000,
        lostAfterUnreachable: 2,
        unreachableBackoffMs: 0,
        registryPath: join(dir, "registry.json"),
      };
      const control = createMemoryPort();
      control.setUnreachable("laptop-a", true);
      const port = createMeteredPort(control.port, meter, () => {});
      const dispatcher = createDispatcher({
        port,
        budget: GATE,
        ledgerPath,
        config,
        now: () => new Date("2026-10-27T10:00:00.000Z"),
        sleep: () => Promise.resolve(),
        log: () => undefined,
        lostUsage: (requestId) => meter.settleRequest(requestId, "lost"),
      });
      let firstError: unknown;
      let requestId = "";
      try {
        const started = await dispatcher.start(
          item() as never,
          decision("laptop-a") as never,
          MODEL,
          "Do the work.",
        );
        if (started.kind === "started") {
          requestId = started.request.requestId;
        }
      } catch (error: unknown) {
        firstError = error;
        if (error instanceof PortUnreachableError) {
          requestId = "w1-demo:0";
        }
      }
      expect(firstError).toBeInstanceOf(PortUnreachableError);
      const settled = await meter.settleRequest(requestId, "lost");
      const outcome = await dispatcher.start(
        item() as never,
        decision("laptop-a") as never,
        MODEL,
        "Do the work.",
      );
      if (outcome.kind !== "lost") {
        throw new Error("expected a lost start");
      }
      const contents = await readLedger("Test ledger", ledgerPath);
      expect(contents.pending[0]?.tokens).toEqual(settled?.tokens);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

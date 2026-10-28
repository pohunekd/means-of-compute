// Unknown-usage test (D2 of issue #35): a provider reply without usage
// records null token counts, which the budget guard refuses as unknown
// spend. The dispatcher runs behind createMeteredPort; the sandbox
// holds copies of config/budget.json, config/providers/ and a ledger
// pointer at the test ledger.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCliBudgetGate } from "../../src/budget/gate.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import type { DispatcherConfig } from "../../src/dispatcher/config.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { BudgetGate } from "../../src/budget/gate.js";
import { readLedger } from "../../src/ledger/read.js";
import { createMeteredPort } from "../../src/meter/metered-port.js";
import type { Meter } from "../../src/meter/meter.js";
import { meterUrl, withMeter } from "./helpers.js";

const MODEL = { providerId: "meta-api", model: "muse-spark-1.3-contributor" };

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

function item(): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id: "w1-demo",
    repo: "example/demo",
    title: "Demo item",
    goal: "Exercise unknown usage",
    issue: 35,
    dod: [{ id: "D1", text: "Done", done: false }],
    dependencies: [],
    status: "queued",
    statusReason: null,
    assignedHostAlias: null,
    branch: null,
    pullNumber: null,
    modelRouting: { preferredModel: "muse-spark-1.3-contributor", attempts: 0, fallbackUsed: false },
    retryCount: 0,
    stallRounds: 0,
  };
}

function decision(): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId: "w1-demo",
    chosenHostAlias: "laptop-a",
    reason: "test decision",
    candidates: [{ hostAlias: "laptop-a", score: 1, reason: "only host", excluded: false }],
  };
}

function chatBody(): Record<string, unknown> {
  return {
    model: "moc-session",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  };
}

test("a reply without usage refuses as spend unknown", async () => {
  await withMeter("tests/meter/recordings/stream-no-usage.json", async ({ meter }) => {
    const dir = mkdtempSync(join(tmpdir(), "meter-unknown-"));
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
        lostUsage: (requestId) => (meter as Meter).settleRequest(requestId, "lost"),
      });
      const started = await dispatcher.start(
        item() as never,
        decision() as never,
        MODEL,
        "Do the work.",
      );
      if (started.kind !== "started") {
        throw new Error("expected a started session");
      }
      const resp = await fetch(meterUrl(meter), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${meter.tokenFor(started.request.requestId)}`,
        },
        body: JSON.stringify(chatBody()),
      });
      expect(resp.status).toBe(200);
      await resp.text();
      control.complete(started.handle.sessionId, {
        state: "finished",
        usage: null,
        detail: "exited 0",
      });
      const outcome = await dispatcher.watch(started.request.requestId);
      const expected = [
        {
          provider: "meta-api",
          model: "muse-spark-1.3-contributor",
          inputTokens: null,
          outputTokens: null,
          requests: 1,
          source: "meter-proxy",
        },
      ];
      expect(outcome.result.usage?.tokens).toEqual(expected);
      const contents = await readLedger("Test ledger", ledgerPath);
      expect(contents.pending).toHaveLength(1);
      expect(contents.pending[0]?.tokens).toEqual(expected);
      const sandbox = join(dir, "sandbox");
      await Bun.write(
        join(sandbox, "config", "budget.json"),
        JSON.stringify({
          statePath: join(sandbox, "state.json"),
          escalationLogPath: join(sandbox, "escalations.log"),
          dayCapUsd: 12,
          totalCapUsd: 140,
          nvidiaDailyRequestLimit: 1000,
          nvidiaProviderId: "nvidia-build",
        }),
      );
      for (const name of ["meta-api.json", "nvidia-build.json", "local.json", "route.json", "schema.json"]) {
        await Bun.write(
          join(sandbox, "config", "providers", name),
          Bun.file(join("config", "providers", name)),
        );
      }
      await Bun.write(
        join(sandbox, "config", "ledger.json"),
        JSON.stringify({ ledgerPath }),
      );
      const gate = createCliBudgetGate({
        command: ["bun", resolve("src/budget/check.ts")],
        timeoutMs: 30000,
        cwd: sandbox,
      });
      const admission = await gate.admit();
      expect(admission.admit).toBe(false);
      if (!admission.admit) {
        expect(admission.reason).toBe("spend unknown");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

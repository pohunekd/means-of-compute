// Stub worker smoke (demo mode, design section 7): a session started by the
// real dispatcher behind the metered memory port gets one metered model
// call, the scripted patch is pushed to the sandbox origin, and the watch
// reports a finished session with the meter's token counts.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import { createMeteredPort } from "../../src/meter/metered-port.js";
import { prepareSandbox } from "../../src/loop/stub/sandbox.js";
import { createStubWorker } from "../../src/loop/stub/worker.js";
import { withMeter } from "../meter/helpers.js";

const GATE: BudgetGate = {
  admit: () => Promise.resolve({ admit: true as const, line: "admitted: test" }),
};
const PATCH = [
  "diff --git a/notes.txt b/notes.txt",
  "new file mode 100644",
  "index 0000000..3b18e51",
  "--- /dev/null",
  "+++ b/notes.txt",
  "@@ -0,0 +1 @@",
  "+hello world",
  "",
].join("\n");

test("a started session is metered, pushed and finished by the stub worker", async () => {
  await withMeter("tests/meter/recordings/stream-ok.json", async ({ meter }) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-stub-worker-"));
    try {
      const demoRepoDir = join(dir, "demo-repo");
      mkdirSync(demoRepoDir);
      await Bun.write(join(demoRepoDir, "README.md"), "demo\n");
      const patchPath = join(dir, "demo-a.patch");
      await Bun.write(patchPath, PATCH);
      const git = { PATH: process.env.PATH ?? "", timeoutMs: 30_000 };
      const layout = await prepareSandbox({
        sandboxDir: join(dir, "sandbox"),
        demoRepoDir,
        registryPath: join(dir, "registry.json"),
        ownedDirs: [],
        configDir: "config",
        ledgerPath: join(dir, "sandbox", "ledger.jsonl"),
        git,
      });
      const control = createMemoryPort();
      const dispatcher = createDispatcher({
        port: createMeteredPort(control.port, meter, () => undefined),
        budget: GATE,
        ledgerPath: join(dir, "sandbox", "ledger.jsonl"),
        config: {
          baseBranch: "main",
          branchPrefix: "moc/",
          waitTimeoutMs: 1000,
          lostAfterUnreachable: 3,
          unreachableBackoffMs: 0,
          nonTerminalPauseMs: 0,
          registryPath: join(dir, "registry.json"),
        },
        now: () => new Date("2026-10-29T10:00:00.000Z"),
        sleep: () => Promise.resolve(),
        log: () => undefined,
        settleUsage: (requestId) => meter.settleRequest(requestId, "lost"),
      });
      const started = await dispatcher.start(
        {
          schemaVersion: "v1",
          id: "demo-a",
          repo: "example/demo-repo",
          title: "Demo a",
          goal: "Add the notes file",
          issue: null,
          dod: [{ id: "D1", text: "notes.txt says hello", done: false }],
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
        },
        {
          schemaVersion: "v1",
          workItemId: "demo-a",
          chosenHostAlias: "laptop-a",
          reason: "test decision",
          candidates: [{ hostAlias: "laptop-a", score: 1, reason: "only host", excluded: false }],
        },
        { providerId: "meta-api", model: "muse-spark-1.3-contributor" },
        "Do the work.",
      );
      if (started.kind !== "started") {
        throw new Error(`expected started, got ${started.kind}`);
      }
      const worker = createStubWorker({
        control,
        meter,
        sessionModelId: "moc-session",
        originDir: layout.originDir,
        hostsDir: layout.hostsDir,
        git,
        patchFor: (workItemId, round) =>
          workItemId === "demo-a" && round === 0 ? patchPath : null,
      });
      expect(await worker.step()).toEqual([started.handle.sessionId]);
      expect(await worker.step()).toEqual([]);
      const outcome = await dispatcher.watch(started.request.requestId);
      expect(outcome.attempt).toBe("success");
      expect(outcome.result.usage?.tokens).toEqual([
        {
          provider: "meta-api",
          model: "muse-spark-1.3-contributor",
          inputTokens: 1200,
          outputTokens: 80,
          requests: 1,
          source: "meter-proxy",
        },
      ]);
      const show = Bun.spawn(["git", "-C", layout.originDir, "show", "moc/demo-a:notes.txt"], {
        env: { PATH: git.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const shown = await new Response(show.stdout).text();
      expect(await show.exited).toBe(0);
      expect(shown).toBe("hello world\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

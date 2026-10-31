// Canary run: the stub loopback never reads a provider key, so this test
// drives the real secret-reading paths (the metered proxy, the gh port
// and the provider router) with synthetic values built at runtime, then
// scans its run dir for every canary and token shape. The run dir is
// removed and recreated at the start of this file and left in place.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetGate } from "../../src/budget/gate.js";
import { createDispatcher } from "../../src/dispatcher/dispatcher.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import type { ModelSelection } from "../../src/dispatcher/port.js";
import { loadLoopConfig } from "../../src/loop/config.js";
import { createGhPort, GitHubError } from "../../src/loop/github.js";
import { createMeteredPort } from "../../src/meter/metered-port.js";
import { meterUrl, withMeter } from "../meter/helpers.js";
import { startLoopback } from "../../src/providers/loopback.js";
import { callProvider, ProviderCallError } from "../../src/providers/router.js";

const RUN_DIR = "logs/canary-run";
const RECORDINGS = "tests/meter/recordings/stream-ok.json";

rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(RUN_DIR, { recursive: true });

// Built at runtime, so no committed file holds a full value.
const salt = randomBytes(12).toString("hex");
const CANARY = {
  // The split keeps the source free of a full canary value.
  meta: `sk-${"moc"}canary` + salt, // eslint-disable-line @typescript-eslint/no-unnecessary-template-expression
  nvidia: `nvapi-moccanary${salt}`,
  github: `ghp_moccanary${salt}`,
} as const;

const DISPATCH_LOG = join(RUN_DIR, "dispatcher.jsonl");
const ERRORS_LOG = join(RUN_DIR, "errors.jsonl");

const GATE: BudgetGate = {
  admit() {
    return Promise.resolve({ admit: true as const, line: "admitted: test" });
  },
};

const MODEL: ModelSelection = { providerId: "meta-api", model: "muse-spark-1.3-contributor" };

function item(): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id: "canary-meter",
    repo: "example/demo",
    title: "Demo item canary-meter",
    goal: "Exercise the metered port with a canary key",
    issue: 20,
    dod: [{ id: "D2", text: "Done", done: false }],
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

function decision(): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    workItemId: "canary-meter",
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

function appendEvent(event: unknown): void {
  appendFileSync(DISPATCH_LOG, `${JSON.stringify(event)}\n`);
}

// The failure names the file only, never its content.
async function scanRunDir(): Promise<void> {
  const leaked: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const text = await Bun.file(full).text();
      if (
        text.includes(CANARY.meta) ||
        text.includes(CANARY.nvidia) ||
        text.includes(CANARY.github) ||
        text.includes("moc1.") ||
        /\bsk-[A-Za-z0-9]/.test(text) ||
        /nvapi-[A-Za-z0-9]/.test(text) ||
        /ghp_[A-Za-z0-9]/.test(text) ||
        /BEGIN [A-Z ]*PRIVATE/.test(text)
      ) {
        leaked.push(full);
      }
    }
  }
  await walk(RUN_DIR);
  expect(leaked).toEqual([]);
}

test("a metered call forwards the canary key and logs none of it", async () => {
  await withMeter(
    RECORDINGS,
    async (fixture) => {
      const { meter, loopback } = fixture;
      const control = createMemoryPort();
      const dispatcher = createDispatcher({
        port: createMeteredPort(control.port, meter, (event) => {
          appendEvent(event);
        }),
        budget: GATE,
        ledgerPath: join(RUN_DIR, "ledger.jsonl"),
        config: {
          baseBranch: "main",
          branchPrefix: "moc/",
          waitTimeoutMs: 1000,
          lostAfterUnreachable: 3,
          unreachableBackoffMs: 0,
          nonTerminalPauseMs: 0,
          registryPath: join(RUN_DIR, "registry.json"),
        },
        now: () => new Date("2026-10-27T10:00:00.000Z"),
        sleep: () => Promise.resolve(),
        log: (event) => {
          appendEvent(event);
        },
        settleUsage: (requestId) => meter.settleRequest(requestId, "lost"),
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
      const { request, handle } = started;
      const resp = await fetch(meterUrl(meter), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${meter.tokenFor(request.requestId)}`,
        },
        body: JSON.stringify(chatBody()),
      });
      expect(resp.status).toBe(200);
      await resp.text();
      control.complete(handle.sessionId, { state: "finished", usage: null, detail: "exited 0" });
      await dispatcher.watch(request.requestId);
      await Bun.write(join(RUN_DIR, "meter-usage.jsonl"), await Bun.file(fixture.logPath).text());
      await Bun.write(
        join(RUN_DIR, "meter-events.jsonl"),
        `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      expect(loopback.requests()[0]?.headers["authorization"]).toBe(`Bearer ${CANARY.meta}`);
      await scanRunDir();
    },
    { keys: { meta: CANARY.meta, nvidia: CANARY.nvidia } },
  );
});

test("secret-bearing error paths redact the value", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "canary-bin-"));
  try {
    writeFileSync(
      join(binDir, "gh"),
      "#!/bin/sh\nprintf 'HTTP 401: Bad credentials for %s\\n' \"$GH_TOKEN\" >&2\nexit 1\n",
    );
    chmodSync(join(binDir, "gh"), 0o755);
    const github = (await loadLoopConfig("config/loop-demo.json", "stub")).github;
    const port = createGhPort(
      { ...github, configDir: join(RUN_DIR, "gh-config") },
      { PATH: binDir, token: CANARY.github },
    );
    let ghThrown: unknown;
    try {
      await port.viewerLogin();
    } catch (error: unknown) {
      ghThrown = error;
    }
    expect(ghThrown).toBeInstanceOf(GitHubError);
    const ghDetail = (ghThrown as GitHubError).detail ?? "";
    expect(ghDetail).toContain("[redacted]");
    appendFileSync(
      ERRORS_LOG,
      `${JSON.stringify({ name: "GitHubError", message: (ghThrown as Error).message, detail: ghDetail })}\n`,
    );
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
  const recDir = mkdtempSync(join(tmpdir(), "canary-rec-"));
  const recPath = join(recDir, "unauthorized.json");
  await Bun.write(
    recPath,
    JSON.stringify([{ status: 401, body: { error: { message: `invalid key ${CANARY.meta}` } } }]),
  );
  const loopback = await startLoopback(recPath);
  const saved = process.env.META_API_KEY;
  process.env.META_API_KEY = CANARY.meta;
  try {
    let routerThrown: unknown;
    try {
      await callProvider(
        {
          id: "meta-api",
          name: "canary",
          baseUrl: `http://127.0.0.1:${String(loopback.port)}`,
          model: "muse-spark-1.3-contributor",
          timeoutMs: 5000,
          apiKeyEnv: "META_API_KEY",
          pricing: { inputPer1M: 0, outputPer1M: 0 },
        },
        { messages: [{ role: "user", content: "hi" }] },
      );
    } catch (error: unknown) {
      routerThrown = error;
    }
    expect(routerThrown).toBeInstanceOf(ProviderCallError);
    expect((routerThrown as ProviderCallError).status).toBe(401);
    expect(loopback.requests()[0]?.headers["authorization"]).toBe(`Bearer ${CANARY.meta}`);
    appendFileSync(
      ERRORS_LOG,
      `${JSON.stringify({ name: "ProviderCallError", message: (routerThrown as Error).message, detail: (routerThrown as ProviderCallError).kind })}\n`,
    );
  } finally {
    if (saved === undefined) {
      delete process.env.META_API_KEY;
    } else {
      process.env.META_API_KEY = saved;
    }
    await loopback.stop();
    rmSync(recDir, { recursive: true, force: true });
  }
  await scanRunDir();
});

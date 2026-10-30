// Production composition (P3, design row L47): with every opener injected,
// a missing GitHub token and a wrong factory login stop the startup with
// exit-2 errors before the registry lock, and a good startup creates the
// factory-owned directories, prints the running line, and stops cleanly
// on the stop signal. No token, host, gh or model is involved: the token
// variable holds a placeholder that no opener reads.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PohunekAdapterConfig } from "../../src/dispatcher/adapter/config.js";
import { createMemoryPort } from "../../src/dispatcher/memory-port.js";
import { createMemoryHostStatePort } from "../../src/hoststate/memory-port.js";
import { LoopStartupError, loadLoopConfigs, type StopSignal } from "../../src/loop/compose.js";
import { runProduction, type ProductionOpeners } from "../../src/loop/production.js";
import { applyTestEnv } from "../auditor/test-env.js";
import { createStubGitHub } from "../../src/loop/stub/github.js";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// The committed production configs with every written path moved into dir.
async function writeConfigs(dir: string, factoryLogin: string): Promise<string> {
  const at = (name: string): string => join(dir, name);
  const write = async (name: string, value: unknown): Promise<string> => {
    await Bun.write(at(name), `${JSON.stringify(value, null, 2)}\n`);
    return at(name);
  };
  mkdirSync(at("checkout"));
  const loop = readJson("config/loop.json");
  const github = loop["github"] as Record<string, unknown>;
  const repos = loop["repos"] as Record<string, unknown>[];
  return write("loop.json", {
    ...loop,
    statePath: at("loop-state.json"),
    logPath: at("loop.jsonl"),
    resultsPath: at("loop-results.jsonl"),
    workConfigPath: await write("work.json", {
      ...readJson("config/work.json"),
      storePath: at("work-items.json"),
    }),
    dispatcherConfigPath: await write("dispatcher.json", {
      ...readJson("config/dispatcher.json"),
      registryPath: at("registry.json"),
    }),
    auditorConfigPath: await write("auditor.json", {
      ...readJson("config/auditor.json"),
      verdictDir: at("verdicts"),
    }),
    ledgerConfigPath: await write("ledger.json", { ledgerPath: at("ledger.jsonl") }),
    approvalsConfigPath: await write("approvals.json", {
      ...readJson("config/approvals.json"),
      requestsPath: at("approval-requests.json"),
    }),
    meterConfigPath: await write("meter.json", {
      ...readJson("config/meter.json"),
      usageLogPath: at("meter-usage.jsonl"),
    }),
    github: { ...github, factoryLogin, configDir: at("gh-config") },
    repos: repos.map((repo) => ({ ...repo, checkoutDir: at("checkout") })),
    trialMerge: { ...(loop["trialMerge"] as Record<string, unknown>), scratchDir: at("trial") },
    digest: { dir: at("digest"), onExit: false },
  });
}

async function writeConfigsWithGrace(
  dir: string,
  factoryLogin: string,
  shutdownGraceMs: number,
): Promise<string> {
  const loop = readJson(join(dir, "loop.json"));
  await Bun.write(
    join(dir, "loop.json"),
    `${JSON.stringify({ ...loop, shutdownGraceMs }, null, 2)}\n`,
  );
  return join(dir, "loop.json");
}

function openers(dir: string, env: Record<string, string>, login: string): ProductionOpeners {
  return {
    env,
    loadAdapterConfig: (path) => Promise.resolve(readJson(path) as unknown as PohunekAdapterConfig),
    openGitHub: () =>
      createStubGitHub({
        repo: "pohunekd/means-of-compute",
        originDir: join(dir, "origin.git"),
        baseBranch: "main",
        factoryLogin: login,
        git: { PATH: env.PATH ?? "", timeoutMs: 5000 },
        scratchDir: join(dir, "trial"),
        ci: () => "success",
      }),
    resolveMeterEnv: () =>
      Promise.resolve({
        listen: { host: "127.0.0.1", port: 0 },
        secret: randomBytes(32),
        hostAddresses: new Map(),
        hostAddressesFile: join(dir, "meter-hosts.json"),
      }),
    loadProviders: () => Promise.resolve({}),
    openPort: () => Promise.resolve(createMemoryPort().port),
    openHostState: () => Promise.resolve(createMemoryHostStatePort(["host-a"]).port),
    auditCall: () => Promise.reject(new Error("production test never audits")),
  };
}

// A stop signal that fires as soon as the run prints its running line.
function stopAfterRunning(lines: string[]): { stop: StopSignal; out: (line: string) => void } {
  let stopped = false;
  const handlers: (() => void)[] = [];
  return {
    stop: {
      stopping: () => stopped,
      onStop: (handler) => {
        handlers.push(handler);
      },
      sleep: () => Promise.resolve(),
    },
    out: (line) => {
      lines.push(line);
      stopped = true;
      for (const handler of handlers.splice(0)) {
        handler();
      }
    },
  };
}

test("production startup checks GitHub first and stops cleanly (P3, L47)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-production-"));
  const restoreEnv = applyTestEnv();
  try {
    await Bun.write(join(dir, "meter-hosts.json"), "{}\n");
    const path = await writeConfigs(dir, "moc-factory");
    const configs = await loadLoopConfigs(path, "production");
    const base = { PATH: process.env.PATH ?? "", HOME: dir };
    const run = async (env: Record<string, string>, login: string): Promise<unknown> => {
      const lines: string[] = [];
      const signal = stopAfterRunning(lines);
      try {
        const rc = await runProduction({
          configs,
          openers: openers(dir, env, login),
          stop: signal.stop,
          out: signal.out,
          warn: () => undefined,
        });
        return { rc, lines };
      } catch (error: unknown) {
        return error;
      }
    };

    const missing = await run(base, "moc-factory");
    expect(missing).toBeInstanceOf(LoopStartupError);
    expect((missing as Error).message).toBe("github token missing");
    expect(existsSync(join(dir, "registry.json.lock"))).toBe(false);

    const withToken = { ...base, MOC_GITHUB_TOKEN: "placeholder" };
    const mismatch = await run(withToken, "someone-else");
    expect(mismatch).toBeInstanceOf(LoopStartupError);
    expect((mismatch as Error).message).toBe("github login mismatch");
    expect(existsSync(join(dir, "registry.json.lock"))).toBe(false);

    expect(await run(withToken, "moc-factory")).toEqual({
      rc: 0,
      lines: ["loop: running (0 active)"],
    });
    const tight = await runProduction({
      configs: await loadLoopConfigs(
        await writeConfigsWithGrace(dir, "moc-factory", 600000),
        "production",
      ),
      openers: openers(dir, withToken, "moc-factory"),
      stop: stopAfterRunning([]).stop,
      out: () => undefined,
      warn: () => undefined,
    }).then(
      () => "started",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(tight).toBe(
      "shutdownGraceMs 600000 must exceed the largest audit provider timeoutMs 600000 (meta-wonder)",
    );
    for (const owned of ["verdicts", "digest", "trial", "gh-config"]) {
      expect(existsSync(join(dir, owned))).toBe(true);
    }
    const events = readFileSync(join(dir, "loop.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events[0]).toBe("factory-start");
    expect(events.at(-1)).toBe("factory-stop");
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

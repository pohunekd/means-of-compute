// Dashboard CLI end-to-end test: D1, D2 and D3 of design section 10.
// It spawns `bun src/factory/serve.ts` in a sandbox config dir, waits for
// the ready line, fetches the page and checks the section 10 commands and
// every exit-2 case the section 11 row names. Each assertion names the
// mutation it must catch.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SERVE_SCRIPT = join(REPO_ROOT, "src", "factory", "serve.ts");
const LEDGER_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "dashboard", "ledger.jsonl");
const VERDICTS_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "dashboard", "verdicts");
const READY = /^factory: dashboard listening \(dashboard\) port (\d+)$/;
const PINNED_NOW = "2026-10-27T12:00:00.000Z";

async function makeSandbox(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-serve-"));
  await Bun.write(
    join(dir, "config", "budget.json"),
    await Bun.file(join(REPO_ROOT, "config", "budget.json")).text(),
  );
  for (const name of [
    "local.json",
    "meta-api.json",
    "nvidia-build.json",
    "route.json",
    "schema.json",
  ]) {
    await Bun.write(
      join(dir, "config", "providers", name),
      await Bun.file(join(REPO_ROOT, "config", "providers", name)).text(),
    );
  }
  await Bun.write(
    join(dir, "config", "dashboard.json"),
    `${JSON.stringify(
      {
        listenEnv: "MOC_DASHBOARD_LISTEN",
        listenAlias: "dashboard",
        logPath: "logs/dashboard.jsonl",
        maxRequestBytes: 1024,
        idleTimeoutSec: 10,
        workRowLimit: 50,
        baselines: {
          frontierTokens: {
            label: "synthetic frontier",
            inputPer1M: 3,
            outputPer1M: 15,
            source: "synthetic test value, not a price",
            asOf: "2026-10-01",
          },
          cloudSandboxHour: {
            label: "synthetic sandbox",
            perHour: 0.5,
            source: "synthetic test value, not a price",
            asOf: "2026-10-01",
          },
          ownedHostHour: {
            label: "synthetic owned",
            perHour: 0.05,
            source: "synthetic test value, not a price",
            asOf: "2026-10-01",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(dir, "logs"), { recursive: true });
  return dir;
}

function serveEnv(
  dir: string,
  extra: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    MOC_DASHBOARD_LISTEN: "127.0.0.1:0",
    MOC_DASHBOARD_NOW: PINNED_NOW,
    ...extra,
  };
}

async function waitForReady(
  proc: ReturnType<typeof Bun.spawn>,
): Promise<{ port: number; line: string }> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) {
        buffered += decoder.decode(value, { stream: true });
      }
      for (const line of buffered.split("\n")) {
        const match = READY.exec(line);
        if (match !== null) {
          return { port: Number(match[1]), line };
        }
      }
      if (done) {
        throw new Error(`serve exited before the ready line, stdout was: ${buffered}`);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe("dashboard serve D1 (mutation: bind the wildcard; print the address in the ready line)", () => {
  test("serves the five panels with the 10.2 values, then exits 0 on SIGTERM", async () => {
    const dir = await makeSandbox();
    const proc = Bun.spawn(
      ["bun", SERVE_SCRIPT, "--ledger", LEDGER_FIXTURE, "--verdicts", VERDICTS_FIXTURE],
      { cwd: dir, stdout: "pipe", stderr: "pipe", env: serveEnv(dir, {}) },
    );
    try {
      const { port, line } = await waitForReady(proc);
      expect(line).not.toContain("127.0.0.1");
      const response = await fetch(`http://127.0.0.1:${String(port)}/`);
      expect(response.status).toBe(200);
      const page = await response.text();
      const headings = [...page.matchAll(/<h2>(Fleet|Work|Usage|Savings|Autonomy)<\/h2>/g)].map(
        (match) => match[1],
      );
      expect(headings).toEqual(["Fleet", "Work", "Usage", "Savings", "Autonomy"]);
      for (const value of [
        "$0.2200",
        "$0.2600",
        "$12.0000",
        "$140.0000",
        "31 of 1,000",
        "admitted (within budget)",
        "$45.6000",
        "$0.2400",
        "$45.3600",
        "$2.0000",
        "$0.2000",
        "$1.8000",
        "$47.1600",
        "2 succeeded, 1 blocked",
        "meta/muse-glimmer-30b",
        "d4-delta",
        "d3-gamma",
        "d1-alpha",
        "d2-beta",
        "showing 4 of 4 items",
        "no data (host state not wired)",
        "no data (dispatcher registry not wired)",
      ]) {
        expect(page).toContain(value);
      }
      const d4 = page.indexOf("d4-delta");
      const d3 = page.indexOf("d3-gamma");
      const d1 = page.indexOf("d1-alpha");
      const d2 = page.indexOf("d2-beta");
      expect(d4).toBeGreaterThan(-1);
      expect(d3).toBeGreaterThan(d4);
      expect(d1).toBeGreaterThan(d3);
      expect(d2).toBeGreaterThan(d1);
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stderr as ReadableStream).text()).toContain(
        `factory: dashboard time pinned by MOC_DASHBOARD_NOW: ${PINNED_NOW}`,
      );
    } finally {
      proc.kill(9);
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("unknown flag exits 2 with factory: (mutation: ignore unknown flags)", async () => {
    const dir = await makeSandbox();
    try {
      const proc = Bun.spawn(["bun", SERVE_SCRIPT, "--bogus"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: serveEnv(dir, {}),
      });
      const [stderr, code] = await Promise.all([
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain("factory: ");
      expect(stderr).toContain("unknown flag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("repeated --ledger exits 2 with factory: (mutation: last flag wins)", async () => {
    const dir = await makeSandbox();
    try {
      const proc = Bun.spawn(
        ["bun", SERVE_SCRIPT, "--ledger", LEDGER_FIXTURE, "--ledger", LEDGER_FIXTURE],
        { cwd: dir, stdout: "pipe", stderr: "pipe", env: serveEnv(dir, {}) },
      );
      const [stderr, code] = await Promise.all([
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain("factory: ");
      expect(stderr).toContain("--ledger given twice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("wildcard listen exits 2 without binding (mutation: bind the wildcard)", async () => {
    const dir = await makeSandbox();
    try {
      const proc = Bun.spawn(["bun", SERVE_SCRIPT, "--ledger", LEDGER_FIXTURE], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: serveEnv(dir, { MOC_DASHBOARD_LISTEN: "0.0.0.0:0" }),
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("factory: ");
      expect(stderr).toContain("MOC_DASHBOARD_LISTEN");
      expect(stderr).not.toContain("0.0.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("unset listen exits 2 naming the variable (mutation: default a value)", async () => {
    const dir = await makeSandbox();
    try {
      const env = serveEnv(dir, {});
      delete env["MOC_DASHBOARD_LISTEN"];
      const proc = Bun.spawn(["bun", SERVE_SCRIPT, "--ledger", LEDGER_FIXTURE], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const [stderr, code] = await Promise.all([
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain("factory: ");
      expect(stderr).toContain("MOC_DASHBOARD_LISTEN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("dashboard serve D2 (mutation: money figure without a price citation)", () => {
  test("every $ figure cites per 1M, per hour or config/budget.json", async () => {
    const dir = await makeSandbox();
    const proc = Bun.spawn(
      ["bun", SERVE_SCRIPT, "--ledger", LEDGER_FIXTURE, "--verdicts", VERDICTS_FIXTURE],
      { cwd: dir, stdout: "pipe", stderr: "pipe", env: serveEnv(dir, {}) },
    );
    try {
      const { port } = await waitForReady(proc);
      const page = await (await fetch(`http://127.0.0.1:${String(port)}/`)).text();
      const figures = [...page.matchAll(/<div class="figure">([\s\S]*?)<\/div>/g)].map(
        (match) => match[1] ?? "",
      );
      expect(figures.length).toBeGreaterThan(0);
      let money = 0;
      for (const figure of figures) {
        const value =
          /<span class="(?:value|nodata|error)">([\s\S]*?)<\/span>/.exec(figure)?.[1] ?? "";
        if (/^-?\$/u.test(value)) {
          money += 1;
          const cite = /<p class="cite">source: ([\s\S]*?)<\/p>/.exec(figure)?.[1] ?? "";
          expect(cite).toMatch(/per 1M|per hour|config\/budget\.json/);
        }
      }
      expect(money).toBeGreaterThan(0);
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill(9);
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("dashboard serve D3 (mutation: alias, address or finding text reaches the page)", () => {
  test("the served page is clean of host-, addresses and sentinel texts", async () => {
    const dir = await makeSandbox();
    const proc = Bun.spawn(
      ["bun", SERVE_SCRIPT, "--ledger", LEDGER_FIXTURE, "--verdicts", VERDICTS_FIXTURE],
      { cwd: dir, stdout: "pipe", stderr: "pipe", env: serveEnv(dir, {}) },
    );
    try {
      const { port } = await waitForReady(proc);
      const page = await (await fetch(`http://127.0.0.1:${String(port)}/`)).text();
      for (const needle of ["192.168.", "198.51.100.", ".internal", "sentinel"]) {
        expect(page).not.toContain(needle);
      }
      expect(page.toLowerCase()).not.toContain("host-");
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill(9);
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

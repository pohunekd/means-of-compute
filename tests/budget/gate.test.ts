// Budget gate tests: admit/refuse mapping against the real CLI, plus the
// config loader and the never-admit-on-doubt rule.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetGateError,
  createCliBudgetGate,
  loadBudgetGateConfig,
} from "../../src/budget/gate.js";

test("gate config loads the default command", async () => {
  const loaded = await loadBudgetGateConfig();
  expect(loaded.command).toEqual(["bun", "src/budget/check.ts"]);
  expect(loaded.timeoutMs).toBe(30000);
});

test("gate config rejects unknown keys and bad values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-gate-"));
  try {
    const path = join(dir, "budget-gate.json");
    await Bun.write(
      path,
      JSON.stringify({ command: ["bun", "run", "budget:check"], timeoutMs: 30000, extra: 1 }),
    );
    let message = "";
    try {
      await loadBudgetGateConfig(path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("only 'command' and 'timeoutMs' are allowed");
    await Bun.write(path, JSON.stringify({ command: [], timeoutMs: 30000 }));
    message = "";
    try {
      await loadBudgetGateConfig(path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("'command'");
    await Bun.write(
      path,
      JSON.stringify({ command: ["bun", "run", "budget:check"], timeoutMs: 0 }),
    );
    message = "";
    try {
      await loadBudgetGateConfig(path);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("'timeoutMs'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate admits when spend is below the caps", async () => {
  const gate = createCliBudgetGate({
    command: [
      "bun",
      "run",
      "budget:check",
      "--spend",
      "3.20",
      "--day-cap",
      "12",
      "--total-cap",
      "140",
    ],
    timeoutMs: 60000,
    cwd: process.cwd(),
  });
  const admission = await gate.admit();
  expect(admission.admit).toBe(true);
  if (admission.admit) {
    expect(admission.line).toMatch(/^admitted: /);
  }
});

test("gate refuses with the reason when spend is at the cap", async () => {
  const gate = createCliBudgetGate({
    command: [
      "bun",
      "run",
      "budget:check",
      "--spend",
      "12.00",
      "--day-cap",
      "12",
      "--total-cap",
      "140",
    ],
    timeoutMs: 60000,
    cwd: process.cwd(),
  });
  const admission = await gate.admit();
  expect(admission.admit).toBe(false);
  if (!admission.admit) {
    expect(admission.reason).toBe("daily cap reached");
    expect(admission.line).toMatch(/^refused: /);
  }
});

test("gate throws on a non-guard failure instead of refusing", async () => {
  const gate = createCliBudgetGate({
    command: ["bun", "-e", "process.exit(1)"],
    timeoutMs: 60000,
    cwd: process.cwd(),
  });
  let error: unknown;
  try {
    await gate.admit();
  } catch (thrown: unknown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(BudgetGateError);
});

test("gate wraps a missing command as BudgetGateError", async () => {
  const gate = createCliBudgetGate({
    command: ["no-such-cmd-mocgate"],
    timeoutMs: 60000,
    cwd: process.cwd(),
  });
  let error: unknown;
  try {
    await gate.admit();
  } catch (thrown: unknown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(BudgetGateError);
  expect((error as Error).message).toContain("cannot start no-such-cmd-mocgate");
});

test("gate timeout throws naming the timeout without waiting for pipes", async () => {
  const gate = createCliBudgetGate({
    command: ["sh", "-c", "sleep 6; true"],
    timeoutMs: 300,
    cwd: process.cwd(),
  });
  let error: unknown;
  try {
    await gate.admit();
  } catch (thrown: unknown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(BudgetGateError);
  expect((error as Error).message).toContain("timed out after 300 ms");
});

test("gate names the signal when the child dies on its own", async () => {
  const gate = createCliBudgetGate({
    command: ["sh", "-c", "kill -9 $$"],
    timeoutMs: 60000,
    cwd: process.cwd(),
  });
  let error: unknown;
  try {
    await gate.admit();
  } catch (thrown: unknown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(BudgetGateError);
  expect((error as Error).message).toContain("killed by signal SIGKILL");
  expect((error as Error).message).not.toContain("timed out");
});

test(
  "gate signal branch bounds its stderr read by the deadline (P1)",
  async () => {
    const gate = createCliBudgetGate({
      command: ["sh", "-c", "(sleep 6 &); kill -9 $$"],
      timeoutMs: 300,
      cwd: process.cwd(),
    });
    const started = Date.now();
    let error: unknown;
    try {
      await gate.admit();
    } catch (thrown: unknown) {
      error = thrown;
    }
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(BudgetGateError);
    expect((error as Error).message).toContain("killed by signal SIGKILL");
    expect(elapsed).toBeLessThan(5000);
  },
  { timeout: 15000 },
);

test(
  "gate with a fast command does not wait out the timeout (P2)",
  async () => {
    const started = Date.now();
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        "const { createCliBudgetGate } = await import('./src/budget/gate.js');" +
          "const gate = createCliBudgetGate({ command: ['bun', '-e', \"console.log('admitted: x')\"], timeoutMs: 30000, cwd: process.cwd() });" +
          "const admission = await gate.admit();" +
          "if (!admission.admit) { process.exit(1); }",
      ],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: process.cwd() },
    );
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(elapsed).toBeLessThan(10000);
  },
  { timeout: 15000 },
);

test("gate refuses output held open past the deadline", async () => {
  const gate = createCliBudgetGate({
    command: ["sh", "-c", "(sleep 6 &); echo 'admitted: x'"],
    timeoutMs: 300,
    cwd: process.cwd(),
  });
  let error: unknown;
  try {
    await gate.admit();
  } catch (thrown: unknown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(BudgetGateError);
  expect((error as Error).message).toContain("output not closed within 300 ms");
});

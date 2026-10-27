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
  expect(loaded.command).toEqual(["bun", "run", "budget:check"]);
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

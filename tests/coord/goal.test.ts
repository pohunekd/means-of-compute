// Goal loader tests (G1-G5): committed goals load, and each later
// check names its own input.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGoal, type GoalContext } from "../../src/coord/goal.js";
import { loadFactorySpecs } from "../../src/work/specs.js";
import { loadWorkConfig } from "../../src/work/config.js";

async function context(): Promise<GoalContext> {
  const work = await loadWorkConfig("config/work.json");
  const specs = await loadFactorySpecs("tests/fixtures/mcp/demo/factory-specs.json");
  return { maxOutcomeChars: 8000, workConfig: work, specs };
}

async function copyToTemp(dir: string, source: string, name: string): Promise<string> {
  const text = await Bun.file(source).text();
  const path = join(dir, name);
  await Bun.write(path, text);
  return path;
}

async function failsWith(path: string, ctx: GoalContext, fragment: string): Promise<void> {
  let message = "";
  try {
    await loadGoal(path, ctx);
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain(fragment);
}

test("committed goals load and maxItems is bounded by the config (G1)", async () => {
  const ctx = await context();
  const notes = await loadGoal("tests/fixtures/coord/goals/notes.json", ctx);
  expect(notes.goalId).toBe("notes");
  expect(notes.maxItems).toBe(5);
  const d3 = await loadGoal("tests/fixtures/coord/goals/d3.json", ctx);
  expect(d3.goalId).toBe("d3");
  const dir = mkdtempSync(join(tmpdir(), "goal-"));
  try {
    const path = await copyToTemp(dir, "tests/fixtures/coord/goals/notes.json", "notes.json");
    await failsWith(path, { ...ctx, workConfig: { ...ctx.workConfig, maxItemsPerSubmit: 3 } },
      `Goal ${path}: maxItems exceeds maxItemsPerSubmit 3`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unconfigured repo names the repo (G2)", async () => {
  const ctx = await context();
  const dir = mkdtempSync(join(tmpdir(), "goal-"));
  try {
    const raw = (await Bun.file("tests/fixtures/coord/goals/notes.json").json()) as Record<
      string,
      unknown
    >;
    const path = join(dir, "repo.json");
    await Bun.write(path, `${JSON.stringify({ ...raw, repo: "pohunekd/means-of-compute" })}\n`);
    await failsWith(path, ctx, "repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a disallowed model names the model (G3)", async () => {
  const ctx = await context();
  const dir = mkdtempSync(join(tmpdir(), "goal-"));
  try {
    const raw = (await Bun.file("tests/fixtures/coord/goals/notes.json").json()) as Record<
      string,
      unknown
    >;
    const path = join(dir, "model.json");
    await Bun.write(path, `${JSON.stringify({ ...raw, preferredModel: "gpt-x" })}\n`);
    await failsWith(path, ctx, "preferredModel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema failures name the path and keyword (G4)", async () => {
  const ctx = await context();
  const dir = mkdtempSync(join(tmpdir(), "goal-"));
  try {
    const raw = (await Bun.file("tests/fixtures/coord/goals/notes.json").json()) as Record<
      string,
      unknown
    >;
    const badPrefix = join(dir, "prefix.json");
    await Bun.write(badPrefix, `${JSON.stringify({ ...raw, idPrefix: "Bad" })}\n`);
    await failsWith(badPrefix, ctx, "invalid at /idPrefix (pattern)");
    const extra = join(dir, "extra.json");
    await Bun.write(extra, `${JSON.stringify({ ...raw, extra: true })}\n`);
    await failsWith(extra, ctx, "invalid at / (additionalProperties)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outcome is measured in code points (G5)", async () => {
  const ctx = await context();
  const dir = mkdtempSync(join(tmpdir(), "goal-"));
  try {
    const raw = (await Bun.file("tests/fixtures/coord/goals/d3.json").json()) as Record<
      string,
      unknown
    >;
    const small: GoalContext = { ...ctx, maxOutcomeChars: 100 };
    const ok = join(dir, "ok.json");
    await Bun.write(ok, `${JSON.stringify({ ...raw, outcome: "😀".repeat(100) })}\n`);
    expect((await loadGoal(ok, small)).outcome).toBe("😀".repeat(100));
    const over = join(dir, "over.json");
    await Bun.write(over, `${JSON.stringify({ ...raw, outcome: "😀".repeat(101) })}\n`);
    await failsWith(over, small, "outcome");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

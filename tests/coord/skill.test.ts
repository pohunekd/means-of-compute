// Skill tests (K1-K4): the examples submit cleanly, every refusal
// code has a table row, and the frontmatter names the skill.
import { expect, test } from "bun:test";
import { applySubmission, checkItems } from "../../src/work/submit.js";
import { loadFactorySpecs } from "../../src/work/specs.js";
import { loadWorkConfig } from "../../src/work/config.js";
import type { WorkItem } from "../../contracts/v1/types.js";

const CODES = [
  "invalid-arguments",
  "item-too-large",
  "contract-invalid",
  "loop-state-not-initial",
  "repo-not-configured",
  "model-not-allowed",
  "duplicate-id",
  "id-exists",
  "unknown-dependency",
  "dag-cycle",
  "store-full",
  "store-busy",
  "source-unreadable",
  "store-write-failed",
  "internal-error",
  "call-log-unavailable",
];

const TOOLS = [
  "fleet_status",
  "list_work",
  "audit_results",
  "submit_work",
  "approve",
  "pause_fleet",
];

async function planItems(): Promise<readonly WorkItem[]> {
  const raw = (await Bun.file(".agents/skills/factory-coord/examples/plan-dag.json").json()) as {
    items: WorkItem[];
  };
  return raw.items;
}

async function followupItems(): Promise<readonly WorkItem[]> {
  const raw = (await Bun.file(
    ".agents/skills/factory-coord/examples/followup-item.json",
  ).json()) as { items: WorkItem[] };
  return raw.items;
}

test("the plan DAG submits cleanly (K1)", async () => {
  const work = await loadWorkConfig("config/work.json");
  await loadFactorySpecs("tests/fixtures/mcp/demo/factory-specs.json");
  const items = await planItems();
  expect(checkItems(items, 16384, work.models, new Set(["example/demo-repo"]))).toBeNull();
  for (const item of items) {
    const paths = [...item.dod.flatMap((entry) => entry.text.match(/bun test \S+/g) ?? [])];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(item.goal).toContain(path.replace("bun test ", ""));
    }
  }
  const result = applySubmission(
    { schemaVersion: "v1", revision: 0, items: [], submissions: [] },
    items,
    "coordinator",
    "2026-10-28T10:00:00.000Z",
    1000,
  ).value;
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") {
    expect(result.itemIds).toEqual(["greet-parser", "greet-render", "greet-cli"]);
  }
});

test("the follow-up item ends in -fu with no dependencies (K2)", async () => {
  const work = await loadWorkConfig("config/work.json");
  const items = await followupItems();
  expect(checkItems(items, 16384, work.models, new Set(["example/demo-repo"]))).toBeNull();
  const item = items[0] as WorkItem;
  expect(item.id.endsWith("-fu")).toBe(true);
  expect(item.dependencies).toEqual([]);
  const match = /[0-9a-f]{40}/.exec(item.goal);
  expect(match).not.toBeNull();
  expect(item.title).toContain((match as RegExpExecArray)[0].slice(0, 8));
});

test("every refusal code has a table row and every tool is named (K3)", async () => {
  const text = await Bun.file(".agents/skills/factory-coord/SKILL.md").text();
  for (const code of CODES) {
    const matches = text
      .split("\n")
      .filter((line) => new RegExp(`^\\| \`${code}\` +\\|`).test(line));
    expect(matches.length).toBe(1);
  }
  for (const tool of TOOLS) {
    expect(text).toContain(tool);
  }
});

test("the frontmatter names the factory-coord skill (K4)", async () => {
  const text = await Bun.file(".agents/skills/factory-coord/SKILL.md").text();
  const lines = text.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  expect(lines[0]).toBe("---");
  expect(end).toBeGreaterThan(0);
  const front = lines.slice(1, end);
  expect(front).toContain("name: factory-coord");
  const description = front.find((line) => line.startsWith("description: "));
  expect(description).toBeDefined();
  expect((description as string).length).toBeGreaterThan("description: ".length);
});

test("the failure branches are spelled out (K5)", async () => {
  const text = await Bun.file(".agents/skills/factory-coord/SKILL.md").text();
  expect(text).toContain(
    '6. When `approve` or `pause_fleet` returns `"ok": false`, report its code for that entry and do not call it again.',
  );
  expect(text).toContain(
    '3. If `audit_results` returns `"ok": false`, or step 2 collects no finding, do not call `submit_work` for this entry; report the entry\'s `workItemId` with the code, or with `no findings`.',
  );
});

// Prompt rendering tests (P1-P3): committed prompts match byte for
// byte, and fences grow past any fence inside the goal.
import { expect, test } from "bun:test";
import type { Goal } from "../../src/coord/goal.js";
import { loadSkill, renderPlanPrompt, renderReactPrompt } from "../../src/coord/prompt.js";

async function loadGoalFile(path: string): Promise<Goal> {
  return (await Bun.file(path).json()) as Goal;
}

test("the plan prompt matches the committed file (P1)", async () => {
  const skill = await loadSkill(".agents/skills/factory-coord");
  const goal = await loadGoalFile("tests/fixtures/coord/goals/notes.json");
  const rendered = renderPlanPrompt({
    skill,
    goal,
    runId: "20261028T100000Z-notes-abcdef",
    mergeMode: "by-rule",
    limits: { maxSubmitAttempts: 4 },
  });
  const expected = await Bun.file("tests/fixtures/coord/prompt-plan-expected.md").text();
  expect(rendered).toBe(expected);
});

test("the react prompt matches the committed file (P2)", async () => {
  const skill = await loadSkill(".agents/skills/factory-coord");
  const goal = await loadGoalFile("tests/fixtures/coord/goals/d3.json");
  const rendered = renderReactPrompt({
    skill,
    goal,
    runId: "20261028T100000Z-d3-abcdef",
    mergeMode: "by-rule",
    attention: [
      {
        kind: "followup",
        key: "followup:d3-writer",
        workItemId: "d3-writer",
        pullNumber: 7,
        issue: null,
        fallbackUsed: true,
      },
    ],
    limits: { maxSubmitPerEntry: 2 },
  });
  const expected = await Bun.file("tests/fixtures/coord/prompt-react-expected.md").text();
  expect(rendered).toBe(expected);
});

test("fences grow past backticks inside the goal (P3)", async () => {
  const skill = await loadSkill(".agents/skills/factory-coord");
  const base = await loadGoalFile("tests/fixtures/coord/goals/d3.json");
  const goal: Goal = { ...base, outcome: "a ``` b" };
  const rendered = renderPlanPrompt({
    skill,
    goal,
    runId: "20261028T100000Z-d3-abcdef",
    mergeMode: "by-rule",
    limits: { maxSubmitAttempts: 4 },
  });
  expect(rendered).not.toContain("name: factory-coord");
  const goalBlock = rendered.slice(rendered.indexOf("### Goal"));
  expect(goalBlock).toContain("````json");
  expect(goalBlock).not.toMatch(/^```json$/m);
});

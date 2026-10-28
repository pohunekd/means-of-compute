// Coordinator prompt rendering: the skill text plus the goal and the
// attention list, wrapped in fences that grow past any fence inside.
import type { MergeMode } from "../../contracts/v1/types.js";
import { readInputText } from "../fs/input.js";
import type { Goal } from "./goal.js";

export interface SkillText {
  readonly body: string;
  readonly planExample: string;
  readonly followupExample: string;
}

export type AttentionEntry =
  | {
      readonly kind: "followup";
      readonly key: string;
      readonly workItemId: string;
      readonly pullNumber: number;
      readonly issue: number | null;
      readonly fallbackUsed: boolean;
    }
  | {
      readonly kind: "approve";
      readonly key: string;
      readonly workItemId: string;
      readonly pullNumber: number;
      readonly headSha: string;
      readonly auditorModel: string;
    }
  | {
      readonly kind: "pause";
      readonly key: string;
      readonly goalId: string;
      readonly blocked: number;
    };

export async function loadSkill(dir: string): Promise<SkillText> {
  const path = `${dir}/SKILL.md`;
  const text = await readInputText("Skill", path);
  const lines = text.split("\n");
  const first = lines[0];
  const second = lines.findIndex((line, index) => index > 0 && line === "---");
  if (first !== "---" || second < 0) {
    throw new Error(`Skill ${path}: missing frontmatter`);
  }
  const body = lines
    .slice(second + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd();
  const planExample = (await readInputText("Skill", `${dir}/examples/plan-dag.json`)).trimEnd();
  const followupExample = (
    await readInputText("Skill", `${dir}/examples/followup-item.json`)
  ).trimEnd();
  return { body, planExample, followupExample };
}

function fence(text: string): string {
  let longest = 0;
  let run = 0;
  for (const char of text) {
    if (char === "`") {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function block(text: string): readonly string[] {
  const rule = fence(text);
  return [`${rule}json`, text, rule];
}

export function renderPlanPrompt(input: {
  readonly skill: SkillText;
  readonly goal: Goal;
  readonly runId: string;
  readonly mergeMode: MergeMode;
  readonly limits: { readonly maxSubmitAttempts: number };
}): string {
  const merge =
    input.mergeMode === "human-approval"
      ? "Repository <repo> merges by human approval."
      : "Repository <repo> merges by rule.";
  const lines = [
    input.skill.body,
    "",
    "## Example: plan submission",
    "",
    ...block(input.skill.planExample),
    "",
    "## Example: follow-up item",
    "",
    ...block(input.skill.followupExample),
    "",
    "## This run",
    "",
    `- Run: ${input.runId}`,
    "- Session: plan",
    `- ${merge.replace("<repo>", input.goal.repo)}`,
    `- Limit: at most ${String(input.limits.maxSubmitAttempts)} submit_work calls in this session.`,
    `- Items: at most ${String(input.goal.maxItems)}; ids start with "${input.goal.idPrefix}-" and have at most 45 characters.`,
    "",
    "### Goal",
    "",
    ...block(JSON.stringify(input.goal, null, 2)),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderReactPrompt(input: {
  readonly skill: SkillText;
  readonly goal: Goal;
  readonly runId: string;
  readonly mergeMode: MergeMode;
  readonly attention: readonly AttentionEntry[];
  readonly limits: { readonly maxSubmitPerEntry: number };
}): string {
  const merge =
    input.mergeMode === "human-approval"
      ? "Repository <repo> merges by human approval."
      : "Repository <repo> merges by rule.";
  const lines = [
    input.skill.body,
    "",
    "## Example: plan submission",
    "",
    ...block(input.skill.planExample),
    "",
    "## Example: follow-up item",
    "",
    ...block(input.skill.followupExample),
    "",
    "## This run",
    "",
    `- Run: ${input.runId}`,
    "- Session: react",
    `- ${merge.replace("<repo>", input.goal.repo)}`,
    `- Limit: at most ${String(input.limits.maxSubmitPerEntry)} submit_work calls per followup entry.`,
    `- Items: at most ${String(input.goal.maxItems)}; ids start with "${input.goal.idPrefix}-" and have at most 45 characters.`,
    "",
    "### Goal",
    "",
    ...block(JSON.stringify(input.goal, null, 2)),
    "",
    "### Attention",
    "",
    ...block(JSON.stringify(input.attention, null, 2)),
  ];
  return `${lines.join("\n")}\n`;
}

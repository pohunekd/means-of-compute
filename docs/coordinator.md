# Coordinator

The coordinator turns one goal file into a DAG of work items through the
MCP server. The skill, the goal format and the prompt bytes live here.

## Skill layout

`.agents/skills/factory-coord/SKILL.md` names the `factory` MCP tools and the
rules for plan and react sessions. `examples/plan-dag.json` shows a three-item
DAG; `examples/followup-item.json` shows one follow-up item.

## Goal format

A goal is the JSON in `src/coord/goal.schema.json`: repo, outcome, constraints,
issues, `maxItems` and `preferredModel`. `loadGoal` validates the file, then
bounds the outcome length, `maxItems`, the repo and the model against the work
config and the factory specs. The first failure throws `GoalError`.

## Prompt bytes

`loadSkill` reads the skill body and both examples. `renderPlanPrompt` builds
the plan session prompt; `renderReactPrompt` adds the attention list. Fences
grow past any backticks inside the payload. Long arrays collapse to one line
when they fit, so committed prompts stay byte-identical through Prettier.

# Coordinator

The coordinator turns one goal file into a DAG of work items through the
MCP server. The skill, the goal format and the prompt bytes live here.

## Skill layout

`.agents/skills/factory-coord/SKILL.md` names the `factory` MCP tools and the
rules for plan and react sessions. `examples/plan-dag.json` shows a three-item
DAG; `examples/followup-item.json` shows one follow-up item.

## Goal format

A goal is the JSON in `src/coord/goal.schema.json` with ten keys:
`schemaVersion`, `goalId`, `idPrefix`, `repo`, `title`, `outcome`,
`constraints`, `issues`, `maxItems` and `preferredModel`. `loadGoal`
validates the file, then bounds the outcome length, `maxItems`, the repo
and the model against the work config and the factory specs. The first
failure throws `GoalError`.

## Prompt bytes

`loadSkill` reads the skill body and both examples. `renderPlanPrompt` builds
the plan session prompt; `renderReactPrompt` adds the attention list. Fences
grow past any backticks inside the payload. The Goal and Attention blocks
are exactly `JSON.stringify` with two-space indent. `.prettierignore`
excludes `tests/fixtures/coord/prompt-*-expected.md`, so Prettier never
rewrites the committed prompts; any new byte-exact `.md` fixture needs
its own ignore line.

## Launcher config and Muse argv

`loadCoordConfig` reads `config/coordinator.json` with 19 required keys:
`museCommand`, `providerId`, `model`, `contributorMode`, `approvalMode`,
`envPassthrough`, `mcpConfigPath`, `budgetGateConfigPath`, `skillDir`,
`runsDir`, `maxRunsPerDay`, `maxOutcomeChars`, `maxToolOutputBytes`,
`killGraceMs`, `exportTimeoutMs`, `plan`, `react`, `watch` and `seed`.
The provider and model stay pinned to `meta-api` and
`muse-spark-1.3-contributor`. The config names the key variable only:
`apiKeyEnv` comes from the provider descriptor and its value is never
read. `envPassthrough` excludes `HOME`, `XDG_*` and the key variable.
`museArgv` builds the `exec` command from the plan or react phase.
`factoryEntry` runs `src/mcp/serve.ts` under bun with the coordinator
caller. `exportArgv` builds the redacted `export` command. `readCoordCalls`
returns null for an absent log, otherwise the coordinator call-ends.

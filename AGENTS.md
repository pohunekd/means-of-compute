# AGENTS.md

Entry point for every agent working in this repository. Keep it short: it routes to
the guides that own the details.

## About

Means of Compute is an autonomous software factory that runs coding-agent work
on company-owned machines. A coordinator running on Meta models talks to the
Means of Compute MCP server, work is placed on idle hosts, sessions run through
Pohunek (an external dependency), every change passes an audit gate, and a ledger
feeds a savings dashboard. Built by itself: see README. Models: Muse Glimmer 30B
is the main coder; Muse Spark is fallback, planner and auditor. Every Muse Spark
call uses `muse-spark-1.3-contributor`; Muse Code runs with
`--model muse-spark-1.3-contributor --contributor-mode on`. See
[docs/architecture.md](docs/architecture.md).

## Hard rules (every task, including read-only work)

- **New work only.** This repository contains only work created from 2026-10-26 on.
  Never copy code, documentation, or instruction text from Pohunek or any other
  existing project. Pohunek is used only as a dependency through `@pohunek/sdk`
  behind `DispatcherPort`.
- **Secrets by reference.** Never read `.env*`, key or certificate files, or token
  values. Never run `env` or `printenv`. Check a variable with
  `test -n "$NAME" && echo set`. No secret in code, argv, logs, prompts, or commits.
- **Public repository.** Committed files use synthetic host names, paths, and
  sessions. Hosts are shown only through the display-alias map, never as overlay
  names or addresses.
- English in code, comments, docs, and commits. No `Co-Authored-By` or "Generated
  with" lines. Comments describe the current code, never its history.
- Never push to `main`, never merge, never release or publish. The coordinator merges
  under the policy in the workflow guide.

## Routes

- **Any product or architecture change:** [.agents/instructions/project.md](.agents/instructions/project.md)
- **Any code change:** [.agents/instructions/coding.md](.agents/instructions/coding.md)
- **Any test, gate, or validation work:** [.agents/instructions/verification.md](.agents/instructions/verification.md)
- **Issues, branches, pull requests, audits:** [.agents/instructions/workflow.md](.agents/instructions/workflow.md)
- **Delivering an issue end to end:** the [deliver-issue skill](.agents/skills/deliver-issue/SKILL.md)

## Commands

```sh
bun install          # dependencies
bun run gates        # format, lint, typecheck, contracts, providers, plugin-digest, docs-links, test; prints one rc per gate
bun run fmt          # apply formatting
```

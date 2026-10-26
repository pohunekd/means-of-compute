# Means of Compute

Means of Compute is an autonomous software factory. Given a goal it keeps
developing on its own: it turns the goal into issues with DoD and dependencies,
runs coding agents on the company's idle machines with Meta models, audits every
result with a different model, merges what passes by a fixed rule (green checks
plus a clean audit verdict at that exact commit), files follow-ups, and shows
what that saved. The human sets goals, reads one digest a day, and can revert.

Built by itself: from the handover commit on, this repository is developed by
the same autonomous loop. See [docs/architecture.md](docs/architecture.md) for
the loop runner.

Models: Muse Glimmer 30B (open weights, NVIDIA Build) is the main coder; Muse
Spark is the fallback, planner and auditor. Every Muse Spark call is the
Contributor variant `muse-spark-1.3-contributor`; Muse Code always runs with
`--model muse-spark-1.3-contributor --contributor-mode on`.

Built for the Meta Global AI Developer Hackathon (2026-10-26 to 2026-11-04).

- **Pre-existing:** Pohunek, the owner's open-source session daemon, used here only as
  an external dependency.
- **Built during the hackathon:** everything in this repository.

## Status

Under construction. The architecture is in [docs/architecture.md](docs/architecture.md);
contributor and agent rules start at [AGENTS.md](AGENTS.md).

## Development

```sh
bun install
bun run gates
```

## License

[Business Source License 1.1](LICENSE), changing to Apache License 2.0 on the Change
Date. The Additional Use Grant allows limited production use; see the LICENSE file.

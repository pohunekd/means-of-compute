# Means of Compute

**Seize the idle means of compute.** Means of Compute is a dark factory for coding
agents: it turns the laptops and desktops a company already owns into a managed fleet
for agent work, coordinated by Meta models.

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

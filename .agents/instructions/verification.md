# Verification guide

## Gates

`bun run gates` runs format, lint, typecheck, contracts, providers, plugin-digest, docs-links, and test, each as its own process,
and prints one `gate <name> rc=<n>` line per gate. Output appears only for a failing
gate. CI runs the same command on every pull request and on `main`.

- Run the checks your change affects while iterating; run `bun run gates` once on
  the final commit before asking for review.
- Report each gate's rc as printed. Never report a gate as green without running
  it, and never chain gates or pipe them into `tail`.

## Testing policy

Tests are kept to the minimum that protects the demo and the contracts:

- **Smoke end-to-end scenarios on the critical path**: host joins, work is placed
  on an idle host, dispatched, finished, and audited.
- **Contract tests** for every schema in `contracts-v1`, using its fixtures.
- Nothing else unless the issue's DoD asks for it.

Rules:

- Deterministic only: no dependency on wall-clock timing, the network, or a real
  model. Models are reached through the loopback stub with recorded responses.
- Expected values come from the contract, the issue, or a recorded fixture, never
  from the code under test.
- A flaky test is moved to `quarantine/` (outside the gates) or deleted at once,
  with one line on its issue. Never rerun it in a loop.
- A test you cannot fix on the first attempt is quarantined; continue with the task.
- No coverage targets.
- Real-model and real-fleet runs are evidence recorded on the issue (command,
  output, recording), not CI tests.

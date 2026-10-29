# Workflow guide

## Issues

GitHub Issues hold scope, decisions, DoD, evidence, and handoffs. No local planning
files. Every piece of work has an issue before it starts; defects and out-of-scope
findings get their own issue without asking.

Issue body sections: **Scope** (including the scope boundary), **Decisions**,
**DoD** (D1..Dn, each a verifiable behaviour with the command that shows it),
**Dependencies**, **Verification**, **Size**.

Labels: `stage:0`..`stage:4`, `ws:<workstream>`,
`readiness:ready|blocked|design-needed`, `size:S|M|L`. Only `readiness:ready` issues
without open dependencies are picked up.

## Branches and pull requests

- One branch per issue, created from `main` in a dedicated worktree. Never commit to
  `main` directly.
- Small sequential pull requests, about 400 hand-written lines at most. In a stack,
  only the lowest pull request that needs CI is pushed.
- Every pull request is complete production code for its slice, with docs updated
  in the same pull request. No stubs or placeholders.
- Bodies use `Refs #N`; only the last pull request of an issue uses `Closes #N`.
  The body lists the DoD items with evidence and the gate rcs.

## Audit gate

Each pushed head is audited read-only against the issue's DoD by a model other than
the author's. The audit posts one comment whose first line is:

```
<!-- audit:v1:<owner>/<repo>#<PR number>@<40-char head sha>:auditor=<model id>:high=<n>:medium=<n>:low=<n> -->
```

followed by a findings table (severity, `path:line`, defect, failure scenario, fix
direction) or "No findings."

## Merge policy

A pull request merges only when all hold:

1. CI is green at the exact head.
2. An audit marker exists for that exact head with `high=0` and `medium=0`.
3. If `main` moved since the pull request's CI run, a trial merge of the head into a
   scratch branch passes the gates. The head itself stays unchanged.
4. The merge uses a head guard (`gh pr merge --match-head-commit <sha>`) and is
   verified afterwards.

Branches under `moc/` and their pull requests belong to the factory loop. Nobody
creates a `moc/` branch or pull request by hand. The coordinator never merges or
closes a `moc/` pull request and never posts an audit verdict marker on one.

## Handoff and stalls

- A handoff is an issue comment: branch, commit, gates run with rcs, remaining
  work, blockers.
- Three rounds without a newly met DoD item park the task with one escalation. At
  most two retries per task, then `readiness:blocked`.

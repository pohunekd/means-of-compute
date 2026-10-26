---
name: deliver-issue
description: Deliver one GitHub issue of this repository end to end - read the contract, implement on a branch, run the gates, open the pull request, hand off. Use when a briefing says "deliver issue #N".
---

# Deliver an issue

1. **Read the contract.** `gh issue view <N> --comments`. Scope, decisions, and DoD
   items D1..Dn are binding. Read `AGENTS.md` and the guides it routes to for the
   kind of change.
2. **Check readiness.** The issue has `readiness:ready` and no open dependencies. If
   the DoD is not verifiable, the scope is unclear, or a contract change is needed,
   stop and report instead of guessing.
3. **Implement** on the issue's branch in your worktree. Keep each pull request
   under about 400 hand-written lines; split along the DoD items.
4. **Verify.** Run each DoD item's verification command and keep its output. Run
   `bun run gates` once on the final commit and record every rc.
5. **Check the diff.** `git diff --stat origin/main...HEAD` lists only the files you
   expect. No secrets, no real host names or addresses, nothing copied from another
   project.
6. **Open the pull request.** Body: `Refs #N` (or `Closes #N` for the last one), the
   DoD checklist with evidence, the gate rcs.
7. **Hand off.** Post the handoff comment on the issue (branch, commit, gates, what
   remains, blockers) and report to the coordinator. Do not merge.

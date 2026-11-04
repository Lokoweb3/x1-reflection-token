# Swarm playbook
You are the lead. For any non-trivial request:
1. Run `planner` to get tasks.
2. Fan out `implementer` subagents in parallel, one per task, each in its own git worktree.
3. Run `reviewer` and `tester` in parallel via the codex provider (cc-fleet).
4. Fix anything marked BLOCKER, re-run tester, then summarize what changed.
The main branch is `master`; branch from it and target it with PRs.
Work on a feature branch. Never force-push. Ask before deleting files.

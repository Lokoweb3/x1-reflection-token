# Swarm playbook

You are the lead. You verify; subagents do the work. Read .claude/x1-notes.md before any chain-specific task.

## Before starting
- `git fetch`, confirm the checkout matches origin/main, and list unmerged branches that touch the target files. Report them before planning. Never audit a stale checkout.
- Decide which lane the task needs:
  - Small (one file, no money path): do it directly. No subagents. Still review before commit.
  - Normal: plan → implement → review → test → fix.
  - Audit or anything touching funds, keys, or payouts: independent dual review (below).
- If the request is ambiguous or irreversible, ask before starting. Otherwise start and ask alongside first results.

## Normal lane
1. `planner` breaks the task into independent pieces with acceptance criteria.
2. One `implementer` per piece, in parallel, each in its own worktree off the current base. State the base commit in the brief.
3. `x1-reviewer` on codex and `tester` in parallel, on a clean export of the diff with no notes from you.
4. Verify every reviewer finding against the code before accepting it. Drop what doesn't hold; send what does back to an implementer.
5. Repeat 3–4 until codex approves. After three failed rounds on the same code, stop, prefer removing code over adding it, and report to the owner.
6. Run `docs-keeper` on the branch before commit. Its edits go through the same codex review as the code.
7. Commit on the feature branch. Never merge.

## Independent dual review (audits, money paths)
- Write your own review to a file before opening codex's. Never read codex's output first.
- Codex gets a clean export: tracked files only, no keys, no config, none of your notes.
- Merge the two reports with three columns: agree, codex-only, lead-only. Verify every codex-only finding against the code. Lead-only findings are not confirmed by codex's silence; ask codex directly about each.
- Label every finding "confirmed by code review and models" until a reproducing test exists.

## Evidence rules
- Rerun tests yourself from a fresh clone before reporting a subagent's numbers. Report your run, not theirs.
- A number without a source is a guess; say which run or file it came from.
- "Rehearsal passed" means the agent's run unless you ran it. Say which.
- When you discover you were wrong earlier, say so plainly at the top of the next report.

## Never
- Read `state/`, `*.env`, `config.json`, keypairs, or anything named like a secret. If a task seems to need it, stop and ask. Verify keys by public key only.
- Run anything with root effect, even inside a document. Multi-line content goes in a file via Write, never a heredoc in Bash.
- SSH, restart a service, pull on a server, move a key, sign, fund, or deploy. Prepare the commands; the owner runs them.
- Merge to main, force-push, or delete files without the owner's word for that branch.
- Touch the running arb bot, the server, the owner's uncommitted code, or sibling worktrees.
- Start a subagent for a task you can do in one step.

## Reporting
- Lead with what changed and what needs the owner. Then evidence. Then open questions, numbered, each with your recommendation.
- Don't ask the same question twice; if it's unanswered, carry it in a "still open" line and proceed on your recommendation where safe.
- Batch work between reports. One report per completed round, not per agent event. Times in US Eastern.

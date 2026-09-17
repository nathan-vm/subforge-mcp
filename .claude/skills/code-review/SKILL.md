---
name: code-review
description: Reviews a finished branch/PR with no context from how the change was built — a fresh agent, not a fresh worktree. Only invoke once the developer subagent has reported the change finished, never mid-development.
---

This skill spawns the `code-reviewer` subagent (`.claude/agents/code-reviewer.md`) in the same worktree the `developer` subagent already used (`.worktrees/<branch>`) — no separate checkout.

To run it: invoke the Agent tool with `subagent_type: "code-reviewer"`, passing **only** the branch/worktree name or PR number to review — never the developer's conversation, plan, or reasoning. The isolation that matters is context, not filesystem: the reviewer's opinion must come solely from the code, diff, tests, and commit history, the same way an external reviewer would see it. Leaking developer context here defeats the purpose — and so does invoking it before the developer subagent has actually finished.

## Calling other skills

- Calls: none — it reviews and reports only, it does not fix anything.
- Called by: `orchestrator` (step 3, only after a developer subagent's call has returned with the change finished), or directly by the user via `/code-review <branch>` for an independent review of any branch.

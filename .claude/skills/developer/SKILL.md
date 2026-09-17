---
name: developer
description: Implements one concrete, scoped coding task in subforge-mcp. Use standalone for a single well-defined change, or let orchestrator dispatch it per planned subtask.
---

This skill spawns the `developer` subagent (`.claude/agents/developer.md`) to implement one scoped task: write the code, run build/test/typecheck/lint, and report what changed.

To run it: invoke the Agent tool with `subagent_type: "developer"` and the scoped task as the prompt, plus a branch name to work in (e.g. `feat/<slug>`) — give it a concrete, bounded task, not the whole feature request unparsed. It creates and works in its own worktree under `.worktrees/<branch>`, never the caller's working tree. For multiple independent subtasks, issue separate `Agent` calls (parallel if they don't touch the same files, sequential otherwise).

## Calling other skills

- Calls: none — it implements only. If review or QA is needed after, that's the caller's decision, not this skill's.
- Called by: `orchestrator` (step 2, once per planned subtask), or directly by the user via `/developer` for a single standalone task.

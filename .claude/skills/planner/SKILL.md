---
name: planner
description: Breaks a request into an ordered, scoped task list before any code is written. Use standalone for "what would it take to do X", or let orchestrator call it automatically.
---

This skill spawns the `planner` subagent (`.claude/agents/planner.md`) to turn a request into an ordered, file-grounded task list, without writing any code.

To run it: invoke the Agent tool with `subagent_type: "planner"` and the request as the prompt. Relay its plan back rather than acting on it yourself.

## Calling other skills

- Calls: none — it's a leaf.
- Called by: `orchestrator` (step 1 of its workflow), or directly by the user via `/planner` for a plan without execution.

# 0001. Agentic sub-agent workflow for this repo

Status: Accepted

## Context

Left unstructured, a single Claude Code session both writes and reviews its own code in the same context — it can't catch its own blind spots, and there's no natural point where a fresh, unbiased pass happens. We want planning, implementation, review, and (when warranted) QA to be distinct passes with deliberately different context, not just different prompts in the same conversation.

## Decision

Introduce a fixed set of project-scoped roles, each a real Claude Code sub-agent definition under `.claude/agents/`, entered through a matching skill of the same name under `.claude/skills/`:

- `orchestrator` — the entry point; sequences the others, never implements or reviews directly.
- `planner` — read-only task breakdown.
- `developer` — implementation, one scoped task at a time, in its own worktree.
- `code-review` — review of that same worktree once development is finished, with no developer context (see [0002](0002-isolated-worktree-code-review.md)).
- `qa` — conditional runtime smoke testing.

`orchestrator` is invoked automatically at session start via a `SessionStart` hook (`.claude/settings.json`), so the workflow is the default rather than something that has to be remembered.

Every sub-agent defaults to Sonnet or Haiku at `effort: medium` or lower. The orchestrator may pick Sonnet vs. Haiku per task within that envelope on its own judgment (a per-call `model` override, no file changes needed) — effort has no such override and stays at each agent's declared default. Escalating past the envelope (Opus, or effort above medium) requires stopping and asking the user first — it's never a sub-agent's or the orchestrator's call to make alone, since it changes cost and blast radius without the user in the loop.

## Consequences

- Review genuinely can't rubber-stamp the developer's own framing, since it never sees it.
- More tool calls and latency per task than one flat session — acceptable for anything beyond a trivial change; the orchestrator is expected to skip the ceremony for one-line fixes.
- Model/effort choices are declarative (agent frontmatter) rather than re-decided per call, so they're easy to audit but require editing the agent file to change a role's default.

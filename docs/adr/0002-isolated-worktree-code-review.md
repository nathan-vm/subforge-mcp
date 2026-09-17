# 0002. Developer works in an isolated worktree; review is context-isolated, not filesystem-isolated

Status: Accepted

## Context

If the same conversation (or a forked sub-agent that inherits it) both writes and reviews a change, the review inherits the developer's framing of the problem — it tends to confirm the approach taken rather than question it, and it shares any blind spot the developer had. A human reviewer on a PR doesn't see the author's internal monologue either; they see the diff, the code around it, the tests, and the commit history.

Separately, the `developer` sub-agent needs to not touch the orchestrator's own working tree while it works, the same reason any of this repo's git work happens in a worktree.

## Decision

`developer` always works in its own git worktree (`.worktrees/<branch>`), created for the task. `code-reviewer` reviews that **same** worktree/branch — it does not create a separate checkout. The isolation that matters for review quality is the agent's *context*, not the filesystem: `code-reviewer` is spawned as a fresh agent (not a fork of the orchestrator or developer conversation) and is handed only a branch/worktree name or PR number, never the plan or the developer's reasoning.

`orchestrator` must not invoke `code-review` until the `developer` call for that task has returned and reported the change finished — review never overlaps with development on the same worktree.

## Consequences

- The reviewer can flag things the developer rationalized away, since it never saw the rationalization — without paying for a second checkout.
- One worktree per task instead of two keeps `.worktrees/` smaller and avoids a second full `pnpm install`/build cycle purely for review.
- The orchestrator is responsible for sequencing correctly; nothing stops it from calling review early except its own workflow discipline (documented in `orchestrator`'s `SKILL.md`).
- Worktrees under `.worktrees/` are local-only (excluded via `.git/info/exclude`, not `.gitignore`) and must be cleaned up (`git worktree remove`) once review concludes, or they accumulate.

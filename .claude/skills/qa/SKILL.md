---
name: qa
description: Runs a runtime smoke test of a change's golden path, beyond what unit tests cover. Use only for user/tool-facing changes — most changes don't need this.
---

This skill spawns the `qa` subagent (`.claude/agents/qa.md`) to build the project and exercise the changed behavior at runtime.

To run it: invoke the Agent tool with `subagent_type: "qa"`, naming the specific tool/feature that changed and what its golden path is. Most changes (refactors, internal-only logic, doc/config edits) don't need this — unit tests already cover them; reserve it for new or changed MCP tool behavior or CLI-visible output.

## Calling other skills

- Calls: none — it tests and reports only.
- Called by: `orchestrator` (step 4, conditionally, after review passes), or directly by the user via `/qa` for an ad hoc smoke test.

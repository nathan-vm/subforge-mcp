#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "This repo (subforge-mcp) uses an agentic workflow documented in CLAUDE.md. For any non-trivial feature, fix, or refactor, invoke the orchestrator skill instead of implementing directly — it delegates to planner, developer, code-review, and (conditionally) qa, each a pinned Sonnet/Haiku sub-agent at medium effort or lower. Escalating model or effort beyond that requires asking the user first."
  }
}
EOF

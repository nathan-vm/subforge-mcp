# subforge-mcp

MCP server exposing local LM Studio models (list/chat/load) over stdio. Single package, no monorepo.

## Commands

```bash
pnpm install
pnpm run build       # tsc -> dist/
pnpm test            # node:test, runs tests/*.test.ts directly against src/
pnpm run typecheck   # tsc -p tsconfig.test.json (src + tests, noEmit)
pnpm run lint         # oxlint --type-aware
pnpm run lint:fix
```

## Conventions

- **Trunk-based.** All work lands on `main` via PR, squash-merged. No long-lived branches.
- **Conventional Commits required** on PR titles (`feat: ...`, `fix: ...`, `feat!: ...` / `BREAKING CHANGE:` for majors) — enforced by `.husky/commit-msg` locally and the `pr-title-lint` CI workflow. [semantic-release](https://github.com/semantic-release/semantic-release) reads this history on `main` to pick the next version, so a mislabeled type/PR title directly produces the wrong release.
- **Version is derived, not hand-edited.** `package.json#version` and `CHANGELOG.md` are written by semantic-release on merge (`.github/workflows/release.yml`) — never bump them by hand. `src/index.ts` reads the version at runtime from `package.json` rather than hardcoding it.
- **Tests import `src/*.ts` directly** (not `dist/`) — Node's native TS support runs them without a build step. Keep `tests/helpers.ts` mocks in sync with any change to the `ToolExtra` shape in `src/index.ts`.
- **No implicit LM Studio model loads.** `chat` refuses if the target model isn't already loaded; `load_model` is the only tool that loads one, and only behind an MCP elicitation prompt. Don't add a code path that loads a model without going through that. `unload_model` is intentionally the one operation _not_ gated behind elicitation — freeing memory is low-risk and reversible, unlike consuming it — so its lack of a consent prompt is deliberate, not an oversight.
- **`delegate_task` never runs outside `dir`.** All three of its file tools (`read_file`/`list_dir`/`edit_file`) go through `safeResolvePath` — don't add a code path that lets the loop touch anything outside the caller-supplied directory, and never add a shell/Bash tool to its tool definitions. Tests for it use the `withTempDir` fixture in `tests/helpers.ts`, which creates and cleans up a real temp directory for exercising real filesystem reads/edits.

## CI shape

- `ci.yml` (PRs + push to main): `lint` / `test` / `typecheck` in parallel, then `outdated` (allowed to fail) and `audit` (blocking) once those pass.
- `pr-title-lint.yml`: rejects non-Conventional-Commit PR titles.
- `release.yml` (push to main only): build, then `semantic-release` (version, changelog, GitHub release, npm publish). Checks out with a `RELEASE_TOKEN` secret (fine-grained PAT, Contents read/write) instead of the default token, because main's branch ruleset requires a PR for every update and the default `github-actions[bot]` identity can't bypass it — the PAT authenticates as a repo admin, who's on the ruleset's bypass list.

Dependabot config (`dependabot.yml` + its auto-merge workflow) lives on the separate `dependabot-config` branch, not on `main` — see that branch's own PR.

## Agentic workflow

This repo uses a fixed set of Claude Code sub-agents (`.claude/agents/`) entered through matching skills (`.claude/skills/`). A `SessionStart` hook loads `orchestrator`'s guidance automatically — new sessions default to delegating rather than implementing inline. See [docs/adr/0001](docs/adr/0001-agentic-subagent-workflow.md) for why.

| Skill | Use it for | Calls |
| --- | --- | --- |
| `orchestrator` | Default entry point for any non-trivial feature/fix/refactor. Plans, dispatches, reviews, integrates. | `planner`, `developer`, `code-review`, `qa` |
| `planner` | "What would it take to do X" — a read-only, file-grounded task breakdown, no code written. | none |
| `developer` | Implementing one concrete, already-scoped task, in its own worktree (`.worktrees/<branch>`). | none |
| `code-review` | Reviewing that same worktree once the developer subagent reports finished — zero developer context, never mid-development. `/code-review <branch>` works standalone too. See [docs/adr/0002](docs/adr/0002-isolated-worktree-code-review.md). | none |
| `qa` | Runtime smoke-testing a user/tool-facing change (new/changed MCP tool behavior). Skip for refactors and internal-only changes. | none |

Model/effort policy: each sub-agent's `.claude/agents/*.md` defaults to Sonnet or Haiku at `effort: medium` or lower. The orchestrator may freely pick Sonnet vs. Haiku per task within that envelope (via the `Agent` call's `model` override) — no approval needed. Going past the envelope (Opus, or effort above medium) always requires asking the user first; it's a cost/blast-radius decision, not a judgment call to make silently.

Architecture decisions land in `docs/adr/` (one file per decision, `docs/adr/template.md` to start a new one) — check there before assuming *why* something is structured a certain way.

## MCP servers

`.mcp.json` declares a project-scoped `github` MCP server for anyone who clones this repo without the GitHub MCP already configured globally. It reads its token from `${SUBFORGE_GITHUB_TOKEN}` (never hardcode a token into `.mcp.json` — it's committed). Set it locally with a PAT scoped to this repo, e.g. `export SUBFORGE_GITHUB_TOKEN=$(gh auth token)`.

## Tooling

- **rtk** condenses local command output for the assistant; it's configured at the user's global Claude Code profile level (not per-repo) — see the user's own setup, nothing repo-specific needed.

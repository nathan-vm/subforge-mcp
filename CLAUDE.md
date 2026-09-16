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
- **No implicit LM Studio model loads.** `chat` refuses if the target model isn't already loaded; `load_model` is the only tool that loads one, and only behind an MCP elicitation prompt. Don't add a code path that loads a model without going through that.

## CI shape

- `ci.yml` (PRs + push to main): `lint` / `test` / `typecheck` in parallel, then `outdated` (allowed to fail) and `audit` (blocking) once those pass.
- `pr-title-lint.yml`: rejects non-Conventional-Commit PR titles.
- `dependabot-auto-merge.yml`: auto-merges Dependabot PRs that aren't major bumps, once CI is green.
- `release.yml` (push to main only): build, then `semantic-release` (version, changelog, GitHub release, npm publish).

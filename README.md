# subforge-mcp

An MCP (Model Context Protocol) server that lets AI clients talk to models
running locally in [LM Studio](https://lmstudio.ai/) — list what's loaded,
chat with per-session history, and (with user consent) load a downloaded
model into memory.

## Install

Requires LM Studio running locally with its local server started
(LM Studio → Developer → Start Server).

**Claude Code:**

```bash
claude mcp add subforge -- npx -y subforge-mcp
```

**Claude Desktop / VS Code (`mcp.json`):**

```json
{
  "mcpServers": {
    "subforge": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "subforge-mcp"]
    }
  }
}
```

## Configuration

| Variable            | Default                 | Notes                                                     |
| ------------------- | ----------------------- | --------------------------------------------------------- |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234` | Base URL of the LM Studio local server (REST + WebSocket) |

## MCP Tools

| Tool            | Description                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_models`   | List models currently loaded into memory in LM Studio                                                                                                                                                                       |
| `chat`          | Send a message to a loaded model; keeps per-`session_id` conversation history                                                                                                                                               |
| `load_model`    | Load a downloaded-but-unloaded model into memory — requires client elicitation support and explicit user consent                                                                                                            |
| `unload_model`  | Unload a currently-loaded model from memory — the counterpart to `load_model`; does not require elicitation/consent                                                                                                         |
| `reset_chat`    | Clear conversation history for a session (or all sessions)                                                                                                                                                                  |
| `delegate_task` | Delegate a mechanical, bounded coding task (rename, find/replace) to a local model running its own read/list/edit-file loop against `dir` — file content never enters the calling conversation, only the final summary does |

`chat` and `load_model` never implicitly load a model: `chat` refuses if the
requested model isn't already loaded, and `load_model` is the only tool that
can bring one into memory, gated behind an MCP elicitation prompt. `unload_model`
is exempt from that gate by design — freeing memory is low-risk and reversible
(load the model again any time), so it doesn't ask for consent.

## Delegating tasks to a local model

`delegate_task` hands a small, mechanical, multi-step coding task (a variable
rename, a boring find/replace, a boilerplate first draft) to a local LM
Studio model, which runs its own read → edit → read → done loop directly
against the filesystem. File contents and the tool back-and-forth never enter
the calling conversation — only a short final summary does — which is what
makes this worth using: rote, bounded edits that would otherwise burn context
reading and re-writing file contents happen entirely on the local model's
side.

**Safety model.** The local model gets exactly three tools — `list_dir`,
`read_file`, `edit_file` — all resolved through `safeResolvePath`, which
refuses any path that would resolve outside the caller-supplied `dir`. There
is no shell/Bash tool in its loop, ever. `edit_file` is a search-and-replace
(exactly one match of `old_string` required), not a whole-file overwrite, so
a bad or ambiguous edit fails loudly and leaves the file untouched instead of
silently clobbering it. It also cannot create new files.

**Reliability caveat.** Local models are much weaker than Claude — think
"fast and free but low-reliability," not a peer. They're fine for
boilerplate, renames, and simple mechanical transforms; they are not a good
fit for anything requiring cross-file understanding, nuanced judgment, or
high-stakes/hard-to-verify correctness. Always review the returned summary
before trusting it.

**Speed tip.** For reasoning models (e.g. Qwen3) doing simple mechanical
tasks, the "thinking" pass before each tool call adds latency with little
quality benefit. The `think: false` input tries a best-effort
`chat_template_kwargs: { enable_thinking: false }` passthrough on each
request, but this isn't guaranteed to be honored — the reliable lever is
disabling it directly in LM Studio's Jinja prompt template (add
`{%- set enable_thinking = false %}` at the top of the template, editable
under that model's settings in LM Studio).

## Development

```bash
pnpm install
pnpm run build      # compile TypeScript to dist/
pnpm test           # run the test suite (node:test)
pnpm run typecheck  # type-check src/ + tests/
pnpm run lint        # oxlint (type-aware)
```

### Project structure

```
subforge-mcp/
├── src/
│   └── index.ts       # server + tool registrations
└── tests/
    ├── helpers.ts      # fetch/extra mocks shared by tests
    └── *.test.ts
```

## Releases

This project is trunk-based: every change lands on `main` via a squash-merged
pull request titled as a [Conventional Commit](https://www.conventionalcommits.org/)
(`feat: ...`, `fix: ...`, `feat!: ...`, etc.). Merging to `main` triggers
[semantic-release](https://github.com/semantic-release/semantic-release),
which determines the next version from commit history, updates
[`CHANGELOG.md`](./CHANGELOG.md), tags a GitHub release, and publishes to npm.

## License

[MIT](./LICENSE)

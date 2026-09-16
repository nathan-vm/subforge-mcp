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

| Tool          | Description                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `list_models` | List models currently loaded into memory in LM Studio                                                            |
| `chat`        | Send a message to a loaded model; keeps per-`session_id` conversation history                                    |
| `load_model`  | Load a downloaded-but-unloaded model into memory — requires client elicitation support and explicit user consent |
| `reset_chat`  | Clear conversation history for a session (or all sessions)                                                       |

`chat` and `load_model` never implicitly load a model: `chat` refuses if the
requested model isn't already loaded, and `load_model` is the only tool that
can bring one into memory, gated behind an MCP elicitation prompt.

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

# subforge-mcp

An MCP (Model Context Protocol) server that lets AI clients talk to every kind
of model running locally in [LM Studio](https://lmstudio.ai/) — chat with LLMs,
rank text with embedding models, get calibrated choices from decision models —
and (with user consent) load a downloaded model into memory.

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

| Variable                       | Default                 | Notes                                                     |
| ------------------------------ | ----------------------- | --------------------------------------------------------- |
| `LMSTUDIO_BASE_URL`            | `http://localhost:1234` | Base URL of the LM Studio local server (REST + WebSocket) |
| `SUBFORGE_DECISION_TIMEOUT_MS` | `30000`                 | Per-request timeout for `/v1/systemone` calls             |

## MCP Tools

| Tool                 | Description                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_models`        | List loaded models with their type (llm/vlm, embeddings, decision); `include_unloaded` also lists downloaded ones                                                                                                           |
| `chat`               | Send a message to a loaded model; keeps per-`session_id` conversation history                                                                                                                                               |
| `load_model`         | Load a downloaded-but-unloaded model (llm, embedding or decision) into memory — requires client elicitation support and explicit user consent                                                                               |
| `unload_model`       | Unload a currently-loaded model from memory — the counterpart to `load_model`; does not require elicitation/consent                                                                                                         |
| `reset_chat`         | Clear conversation history for a session (or all sessions)                                                                                                                                                                  |
| `delegate_task`      | Delegate a mechanical, bounded coding task (rename, find/replace) to a local model running its own read/list/edit-file loop against `dir` — file content never enters the calling conversation, only the final summary does |
| `rank_by_similarity` | Rank up to 200 texts by cosine similarity to a query with a loaded embedding model; vectors never enter the conversation                                                                                                    |
| `decide`             | Pick between 2-6 options for a task + context with a loaded decision model; returns choice, probability, confidence and full ranking                                                                                        |
| `ask_decision`       | Send raw typed questions (`choice` / `score` / `noul`) about one state to a decision model, to prototype new questions                                                                                                      |
| `eval_decisions`     | Run a labeled `.jsonl` through a decision model: overall accuracy, accuracy per probability band, suggested auto-decide threshold                                                                                           |

No tool implicitly loads a model: `chat`, `delegate_task`, `rank_by_similarity`
and the decision tools refuse if the requested model isn't already loaded (or is
the wrong type), and `load_model` is the only tool that can bring one into
memory, gated behind an MCP elicitation prompt. `unload_model`
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

## Decision models

[Decision models](https://lmstudio.ai/docs/developer/jev-compat/systemone)
(System One / Jev-compatible, e.g. `LiquidAI/d1-3B-GGUF`) answer typed
questions with probabilities instead of generated text. LM Studio serves them
at `POST /v1/systemone`; this server wraps that endpoint in three tools.

**`decide`** sends one `choice` question: the state is `Task: <task>` plus
`Context: <context>`, the options are the criteria. Describe options neutrally —
their wording is the whole input.

```jsonc
// decide({ task, context, options: [{ id, description }, ...] })
{
  "ok": true,
  "model": "d1-3b",
  "choice": "postgres",
  "probability": 0.9138,
  "confidence": 0.8707,
  "ranking": [
    { "id": "postgres", "probability": 0.9138, "description": "..." },
    { "id": "redis", "probability": 0.0794, "description": "..." },
    { "id": "memory", "probability": 0.0067, "description": "..." },
  ],
}
```

**Failures never throw.** LM Studio down, model not loaded, wrong model type,
timeout or a bad response all come back as `ok: false` with an error `code`
(`lm_studio_unreachable`, `model_not_loaded`, `no_decision_model_loaded`,
`not_a_decision_model`, `timeout`, `invalid_request`, ...) and `probability: 0`,
so a caller gating on probability can never mistake a failure for a confident
answer.

**`eval_decisions`** measures where that gate should sit. Each line of the
`.jsonl` is either a `decide` case or a raw question case:

```jsonl
{"id": "sessions", "task": "store session tokens", "context": "Postgres in use", "options": [{"id": "postgres", "description": "..."}, {"id": "redis", "description": "..."}], "label": "postgres"}
{"id": "t1", "state": "Checkout is down!", "question": {"type": "noul", "instructions": "Is this urgent?"}, "label": true}
```

It reports overall accuracy, accuracy per probability band (`0.5-0.6`,
`0.6-0.7`, ...) and the lowest threshold whose auto-decisions reach
`target_accuracy` (default 0.9) over at least `min_support` cases. Pass
`current_threshold` to compare against the one in use. Probabilities are not
calibrated for your data until you measure them like this.

## Development

```bash
pnpm install
pnpm run build      # compile TypeScript to dist/
pnpm test           # run the test suite (node:test)
pnpm run test:live  # integration test against a real LM Studio with a decision model loaded
pnpm run typecheck  # type-check src/ + tests/
pnpm run lint        # oxlint (type-aware)
```

### Project structure

```
subforge-mcp/
├── src/
│   ├── index.ts       # server + tool registrations
│   └── decisions.ts   # decision-model questions, eval parsing and metrics (pure)
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

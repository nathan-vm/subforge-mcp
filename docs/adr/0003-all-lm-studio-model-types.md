# 0003. Serve every LM Studio model type, with decision tools that never throw

Status: Accepted

## Context

subforge-mcp started as a bridge to LM Studio chat models. LM Studio now also serves embedding models and decision models (System One / Jev-compatible, `POST /v1/systemone`), which answer typed questions with probabilities instead of text. Agents increasingly use a decision model as a gate ("act alone if the top option is above a threshold, otherwise ask a human"), which raises two needs: a way to call these models without the tool ever stalling a session, and a way to measure where the threshold should sit.

`@lmstudio/sdk` 1.x only knew the `llm` and `embedding` domains, so `load_model` / `unload_model` could not touch a decision model.

## Decision

- Upgrade `@lmstudio/sdk` to 2.x, whose `client.decision` namespace has the same `load` / `listLoaded` / `unload` surface as `llm` and `embedding`. `load_model` and `unload_model` dispatch on the model's type through one `namespaceFor(client, domain)` helper, keeping the elicitation gate and TTL unchanged.
- Every inference tool checks the model is loaded and of the right type before calling LM Studio (`requireLoadedModel`, `resolveDecisionModel`), because every inference endpoint JIT-loads an unloaded model.
- Embedding models are exposed as `rank_by_similarity` rather than a raw `embed`: vectors are useless in an agent's context, a ranking is not.
- Decision models get `decide` (2-6 options for a task + context), `ask_decision` (raw typed questions) and `eval_decisions` (labeled `.jsonl` → accuracy per probability band and a suggested threshold). These three never throw: every failure returns `ok: false`, an error code, and probability 0.
- Pure logic (question building, label normalization, eval parsing, metrics) lives in `src/decisions.ts` so it is unit-tested without mocking fetch.

## Consequences

- A caller gating on `probability` cannot mistake an outage or timeout for a confident answer, and a session waiting on a decision is bounded by `SUBFORGE_DECISION_TIMEOUT_MS`.
- Decision tools behave differently from the rest of the server on error (structured result vs. thrown error). That asymmetry is deliberate: their output feeds an automated gate, the others' output is read by a model.
- The SDK major bump ties `load_model` to LM Studio builds that speak the 2.x protocol.
- `eval_decisions` reads one caller-supplied `.jsonl` (5MB cap) — the only file access outside `delegate_task`'s sandbox.

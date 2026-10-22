import test from "node:test";
import assert from "node:assert/strict";
import { chatHandler, listModelsHandler, rankBySimilarityHandler } from "../src/index.ts";
import { jsonResponse, makeExtra, mockFetch } from "./helpers.ts";

const models = [
  { id: "qwen/qwen3-14b", type: "llm", state: "loaded" },
  { id: "d1-3b", type: "decision", state: "loaded" },
  { id: "nomic-embed", type: "embeddings", state: "loaded" },
  { id: "gemma", type: "vlm", state: "not-loaded" },
];

test("list_models shows each loaded model with its type, and unloaded ones on request", async (t) => {
  mockFetch(t, { models: () => jsonResponse({ data: models }) });
  const { extra } = makeExtra();

  const loadedOnly = await listModelsHandler({}, extra);
  assert.equal(
    loadedOnly.content[0].text,
    "qwen/qwen3-14b (llm)\nd1-3b (decision)\nnomic-embed (embeddings)",
  );

  const all = await listModelsHandler({ include_unloaded: true }, extra);
  assert.match(all.content[0].text, /Downloaded, not loaded:\ngemma \(vlm\)/);
});

test("chat refuses a loaded decision model instead of sending it a chat completion", async (t) => {
  const calls = mockFetch(t, { models: () => jsonResponse({ data: models }) });
  const { extra } = makeExtra();

  await assert.rejects(
    () => chatHandler({ message: "hi", model: "d1-3b", session_id: "types" }, extra),
    /is a decision model, but this tool needs a model of type llm/,
  );
  assert.equal(calls.length, 1);
});

test("chat accepts a vision model reported as 'vlm'", async (t) => {
  mockFetch(t, {
    models: () => jsonResponse({ data: [{ id: "gemma", type: "vlm", state: "loaded" }] }),
    chatCompletions: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
  });
  const { extra } = makeExtra();

  const result = await chatHandler({ message: "hi", model: "gemma", session_id: "vlm" }, extra);

  assert.equal(result.content[0].text, "ok");
});

test("rank_by_similarity embeds query + documents in one call and ranks by cosine", async (t) => {
  const bodies: any[] = [];
  mockFetch(t, {
    models: () => jsonResponse({ data: models }),
    embeddings: (body) => {
      bodies.push(body);
      // Returned out of order on purpose: results must be matched by `index`.
      return jsonResponse({
        data: [
          { index: 2, embedding: [1, 0] },
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [0, 1] },
          { index: 3, embedding: [1, 1] },
        ],
      });
    },
  });
  const { extra } = makeExtra();

  const result = await rankBySimilarityHandler(
    { query: "q", documents: ["orthogonal", "same", "diagonal"], model: "nomic-embed", top_k: 2 },
    extra,
  );

  assert.deepEqual(bodies[0], {
    model: "nomic-embed",
    input: ["q", "orthogonal", "same", "diagonal"],
  });
  const ranking = (result.structuredContent as any).ranking;
  assert.deepEqual(
    ranking.map((r: any) => r.index),
    [1, 2],
  );
  assert.equal(ranking[0].score, 1);
  assert.match(result.content[0].text, /^1\.0000 {2}#1 {2}same/);
});

test("rank_by_similarity refuses a non-embedding model", async (t) => {
  mockFetch(t, { models: () => jsonResponse({ data: models }) });
  const { extra } = makeExtra();

  await assert.rejects(
    () => rankBySimilarityHandler({ query: "q", documents: ["a"], model: "qwen/qwen3-14b" }, extra),
    /is a llm model, but this tool needs a model of type embedding/,
  );
});

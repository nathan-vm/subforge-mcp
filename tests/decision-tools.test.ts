import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { askDecisionHandler, decideHandler, evalDecisionsHandler } from "../src/index.ts";
import { jsonResponse, makeExtra, mockFetch, withTempDir } from "./helpers.ts";

const decisionModel = { id: "d1-3b", type: "decision", state: "loaded" };
const options = [
  { id: "postgres", description: "Store sessions in a table in the existing Postgres database" },
  { id: "redis", description: "Add Redis and store sessions there" },
  { id: "memory", description: "Keep sessions in process memory" },
];

function choiceAnswer(probabilities: Record<string, number>) {
  const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return { type: "choice", choice, probabilities, confidence: 0.87 };
}

test("decide sends one choice question and returns choice, probability and full ranking", async (t) => {
  const bodies: any[] = [];
  mockFetch(t, {
    models: () => jsonResponse({ data: [decisionModel] }),
    systemOne: (body) => {
      bodies.push(body);
      return jsonResponse({
        model: "d1-3b",
        answers: { decision: choiceAnswer({ postgres: 0.91, redis: 0.08, memory: 0.01 }) },
      });
    },
  });
  const { extra } = makeExtra();

  const result = await decideHandler(
    { task: "store sessions", context: "Postgres in use", options },
    extra,
  );

  assert.equal("isError" in result, false);
  assert.deepEqual(bodies[0], {
    model: "d1-3b",
    state: "Task: store sessions\nContext: Postgres in use",
    questions: {
      decision: {
        type: "choice",
        instructions: "Which option is the best way to accomplish the task given the context?",
        criteria: Object.fromEntries(options.map((o) => [o.id, o.description])),
      },
    },
  });
  const payload = result.structuredContent as any;
  assert.equal(payload.ok, true);
  assert.equal(payload.choice, "postgres");
  assert.equal(payload.probability, 0.91);
  assert.equal(payload.confidence, 0.87);
  assert.deepEqual(
    payload.ranking.map((r: any) => [r.id, r.probability]),
    [
      ["postgres", 0.91],
      ["redis", 0.08],
      ["memory", 0.01],
    ],
  );
  assert.equal(payload.ranking[1].description, options[1].description);
});

test("decide returns a structured error with probability 0 when LM Studio is unreachable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  const { extra } = makeExtra();

  const result = await decideHandler({ task: "t", options }, extra);

  assert.equal(result.isError, true);
  const payload = result.structuredContent as any;
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "lm_studio_unreachable");
  assert.equal(payload.probability, 0);
  assert.equal(payload.choice, null);
  assert.deepEqual(payload.ranking, []);
});

test("decide refuses an unloaded model without calling /v1/systemone (no implicit load)", async (t) => {
  const calls = mockFetch(t, {
    models: () => jsonResponse({ data: [{ ...decisionModel, state: "not-loaded" }] }),
  });
  const { extra } = makeExtra();

  const result = await decideHandler({ task: "t", options, model: "d1-3b" }, extra);

  const payload = result.structuredContent as any;
  assert.equal(payload.error.code, "model_not_loaded");
  assert.equal(payload.probability, 0);
  assert.equal(calls.length, 1);
});

test("decide refuses a chat model passed as the decision model", async (t) => {
  mockFetch(t, {
    models: () => jsonResponse({ data: [{ id: "qwen", type: "llm", state: "loaded" }] }),
  });
  const { extra } = makeExtra();

  const result = await decideHandler({ task: "t", options, model: "qwen" }, extra);

  assert.equal((result.structuredContent as any).error.code, "not_a_decision_model");
});

test("decide reports no_decision_model_loaded / ambiguous_decision_model when it can't pick one", async (t) => {
  let loaded = [{ id: "qwen", type: "llm", state: "loaded" }];
  mockFetch(t, { models: () => jsonResponse({ data: loaded }) });
  const { extra } = makeExtra();

  let result = await decideHandler({ task: "t", options }, extra);
  assert.equal((result.structuredContent as any).error.code, "no_decision_model_loaded");

  loaded = [decisionModel, { id: "other-decider", type: "decision", state: "loaded" }];
  result = await decideHandler({ task: "t", options }, extra);
  assert.equal((result.structuredContent as any).error.code, "ambiguous_decision_model");
});

test("decide uses the explicit model over other loaded decision models", async (t) => {
  const bodies: any[] = [];
  mockFetch(t, {
    models: () =>
      jsonResponse({
        data: [decisionModel, { id: "other-decider", type: "decision", state: "loaded" }],
      }),
    systemOne: (body) => {
      bodies.push(body);
      return jsonResponse({
        model: "other-decider",
        answers: { decision: choiceAnswer({ postgres: 0.9, redis: 0.07, memory: 0.03 }) },
      });
    },
  });
  const { extra } = makeExtra();

  const result = await decideHandler({ task: "t", options, model: "other-decider" }, extra);

  assert.equal("isError" in result, false);
  assert.equal(bodies[0].model, "other-decider");
});

test("decide maps a timeout to a structured timeout error", async (t) => {
  mockFetch(t, {
    models: () => jsonResponse({ data: [decisionModel] }),
    systemOne: () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  });
  const { extra } = makeExtra();

  const result = await decideHandler({ task: "t", options }, extra);

  const payload = result.structuredContent as any;
  assert.equal(payload.error.code, "timeout");
  assert.equal(payload.probability, 0);
});

test("decide maps LM Studio 400/501 responses to invalid_request / not_a_decision_model", async (t) => {
  let status = 400;
  mockFetch(t, {
    models: () => jsonResponse({ data: [decisionModel] }),
    systemOne: () => jsonResponse({ error: { message: "bad" } }, { status }),
  });
  const { extra } = makeExtra();

  let result = await decideHandler({ task: "t", options }, extra);
  assert.equal((result.structuredContent as any).error.code, "invalid_request");

  status = 501;
  result = await decideHandler({ task: "t", options }, extra);
  assert.equal((result.structuredContent as any).error.code, "not_a_decision_model");
});

test("ask_decision forwards state and questions untouched and returns the raw answers", async (t) => {
  const bodies: any[] = [];
  mockFetch(t, {
    models: () => jsonResponse({ data: [decisionModel] }),
    systemOne: (body) => {
      bodies.push(body);
      return jsonResponse({
        model: "d1-3b",
        answers: { urgent: { type: "noul", noul: 0.93 } },
        usage: { input_tokens: 42, output_tokens: 0 },
      });
    },
  });
  const { extra } = makeExtra();
  const questions = { urgent: { type: "noul" as const, instructions: "Is this urgent?" } };

  const result = await askDecisionHandler({ state: { ticket: "Server down" }, questions }, extra);

  assert.deepEqual(bodies[0], { model: "d1-3b", state: { ticket: "Server down" }, questions });
  const payload = result.structuredContent as any;
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.answers.urgent, { type: "noul", noul: 0.93 });
  assert.equal(payload.input_tokens, 42);
});

test("ask_decision returns a structured error instead of throwing", async (t) => {
  mockFetch(t, { models: () => jsonResponse({ data: [] }) });
  const { extra } = makeExtra();

  const result = await askDecisionHandler(
    { state: "x", questions: { q: { type: "noul", instructions: "?" } } },
    extra,
  );

  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as any).error.code, "no_decision_model_loaded");
});

async function writeDataset(dir: string, lines: unknown[]): Promise<string> {
  const file = path.join(dir, "cases.jsonl");
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return file;
}

test("eval_decisions scores every case and reports accuracy, bands and a threshold", async (t) => {
  await withTempDir(async (dir) => {
    // 6 confident hits (0.95), 2 shaky misses (0.55): threshold 0.6 is 100% accurate.
    const lines = [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `hit${i}`,
        task: `hit ${i}`,
        options,
        label: "postgres",
      })),
      { id: "miss0", task: "miss 0", options, label: "redis" },
      { id: "miss1", task: "miss 1", options, label: "redis" },
    ];
    const file = await writeDataset(dir, lines);
    mockFetch(t, {
      models: () => jsonResponse({ data: [decisionModel] }),
      systemOne: (body) => {
        const confident = body.state.startsWith("Task: hit");
        return jsonResponse({
          model: "d1-3b",
          answers: {
            q: choiceAnswer(
              confident
                ? { postgres: 0.95, redis: 0.04, memory: 0.01 }
                : { postgres: 0.55, redis: 0.4, memory: 0.05 },
            ),
          },
        });
      },
    });
    const { extra } = makeExtra();

    const result = await evalDecisionsHandler(
      { path: file, target_accuracy: 0.9, min_support: 3, current_threshold: 0.75 },
      extra,
    );

    const payload = result.structuredContent as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.cases, 8);
    assert.equal(payload.accuracy, 0.75);
    assert.equal(payload.suggested_threshold, 0.6);
    assert.deepEqual(
      payload.bands.filter((b: any) => b.n > 0).map((b: any) => [b.band, b.n, b.accuracy]),
      [
        ["0.5-0.6", 2, 0],
        ["0.9-1.0", 6, 1],
      ],
    );
    assert.equal(payload.current.accuracy, 1);
    const text = result.content[0].text;
    assert.match(text, /accuracy 75\.0%/);
    assert.match(text, /Suggested threshold: 0\.60/);
    assert.match(text, /miss0: picked postgres \(0\.55\), label redis/);
  });
});

test("eval_decisions aborts on the first fatal error instead of waiting on every case", async (t) => {
  await withTempDir(async (dir) => {
    const lines = Array.from({ length: 20 }, (_, i) => ({
      task: `t${i}`,
      options,
      label: "redis",
    }));
    const file = await writeDataset(dir, lines);
    let systemOneCalls = 0;
    mockFetch(t, {
      models: () => jsonResponse({ data: [decisionModel] }),
      systemOne: () => {
        systemOneCalls++;
        throw new TypeError("fetch failed");
      },
    });
    const { extra } = makeExtra();

    const result = await evalDecisionsHandler({ path: file }, extra);

    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, "lm_studio_unreachable");
    assert.ok(systemOneCalls <= 4, `expected at most one batch, got ${systemOneCalls} calls`);
  });
});

test("eval_decisions rejects a non-.jsonl path and an empty dataset", async (t) => {
  await withTempDir(async (dir) => {
    mockFetch(t, { models: () => jsonResponse({ data: [decisionModel] }) });
    const { extra } = makeExtra();

    const wrongExt = await evalDecisionsHandler({ path: path.join(dir, "cases.json") }, extra);
    assert.equal((wrongExt.structuredContent as any).ok, false);
    assert.match((wrongExt.structuredContent as any).error.message, /not a \.jsonl file/);

    const empty = await writeDataset(dir, []);
    const result = await evalDecisionsHandler({ path: empty }, extra);
    assert.equal((result.structuredContent as any).error.code, "empty_dataset");
  });
});

// Integration test against a real LM Studio with a decision model loaded.
// Skipped unless SUBFORGE_LIVE_TESTS=1 (see `pnpm run test:live`); never
// loads a model itself, so load one first (load_model or `lms load`).
import test from "node:test";
import assert from "node:assert/strict";
import { askDecisionHandler, decideHandler } from "../src/index.ts";
import { decideQuestion, decideState } from "../src/decisions.ts";
import { makeExtra } from "./helpers.ts";

const live = process.env.SUBFORGE_LIVE_TESTS === "1";

const task =
  "store user session tokens for a web app that runs on a single server and must survive restarts.";
const context = "small team, low traffic, Postgres already in use, no Redis yet.";
const options = [
  { id: "postgres", description: "Store sessions in a table in the existing Postgres database" },
  { id: "redis", description: "Add Redis and store sessions there" },
  { id: "memory", description: "Keep sessions in process memory" },
];

test("decide and ask_decision agree on the same choice question", { skip: !live }, async () => {
  const { extra } = makeExtra();

  const decided = (await decideHandler({ task, context, options }, extra)).structuredContent as any;
  assert.equal(decided.ok, true, JSON.stringify(decided.error));
  assert.equal(decided.ranking.length, 3);
  const total = decided.ranking.reduce((sum: number, r: any) => sum + r.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `probabilities sum to ${total}`);
  assert.equal(decided.probability, decided.ranking[0].probability);

  const asked = (
    await askDecisionHandler(
      { state: decideState(task, context), questions: { decision: decideQuestion(options) } },
      extra,
    )
  ).structuredContent as any;
  assert.equal(asked.ok, true, JSON.stringify(asked.error));
  assert.deepEqual(
    asked.answers.decision.probabilities,
    Object.fromEntries(decided.ranking.map((r: any) => [r.id, r.probability])),
  );
});

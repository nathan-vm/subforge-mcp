import test from "node:test";
import assert from "node:assert/strict";
import {
  type ScoredCase,
  accuracyByBand,
  decideOptionsSchema,
  decideQuestion,
  decideState,
  mapLimit,
  normalizeLabel,
  parseEvalJsonl,
  predictionFromAnswer,
  rankProbabilities,
  statsAtThreshold,
  suggestThreshold,
} from "../src/decisions.ts";

const options = [
  { id: "postgres", description: "Store sessions in Postgres" },
  { id: "redis", description: "Add Redis" },
];

test("decideState / decideQuestion build the same request shape as the reference curl", () => {
  assert.equal(
    decideState("store sessions", "small team"),
    "Task: store sessions\nContext: small team",
  );
  assert.equal(decideState("store sessions", "  "), "Task: store sessions");
  assert.deepEqual(decideQuestion(options), {
    type: "choice",
    instructions: "Which option is the best way to accomplish the task given the context?",
    criteria: { postgres: "Store sessions in Postgres", redis: "Add Redis" },
  });
});

test("decide options must be 2-6 with unique ids", () => {
  assert.equal(decideOptionsSchema.safeParse(options).success, true);
  assert.equal(decideOptionsSchema.safeParse(options.slice(0, 1)).success, false);
  const seven = Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, description: `option ${i}` }));
  assert.equal(decideOptionsSchema.safeParse(seven).success, false);
  assert.equal(decideOptionsSchema.safeParse([options[0], options[0]]).success, false);
});

test("rankProbabilities sorts highest first", () => {
  assert.deepEqual(rankProbabilities({ a: 0.2, b: 0.7, c: 0.1 }), [
    { id: "b", probability: 0.7 },
    { id: "a", probability: 0.2 },
    { id: "c", probability: 0.1 },
  ]);
});

test("predictionFromAnswer collapses every answer type to label + probability", () => {
  assert.deepEqual(
    predictionFromAnswer({
      type: "choice",
      choice: "b",
      probabilities: { a: 0.3, b: 0.7 },
      confidence: 0.4,
    }),
    { label: "b", probability: 0.7 },
  );
  assert.deepEqual(predictionFromAnswer({ type: "noul", noul: 0.8 }), {
    label: "true",
    probability: 0.8,
  });
  const no = predictionFromAnswer({ type: "noul", noul: 0.25 });
  assert.equal(no.label, "false");
  assert.equal(no.probability, 0.75);
  assert.deepEqual(
    predictionFromAnswer({
      type: "score",
      score: 1.4,
      legend: { "0": "low", "1": "mid", "2": "high" },
      probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
      confidence: 0.5,
    }),
    { label: "1", probability: 0.6 },
  );
});

test("normalizeLabel maps dataset labels onto prediction labels per question type", () => {
  const noul = { type: "noul" as const, instructions: "Urgent?" };
  assert.equal(normalizeLabel(true, noul), "true");
  assert.equal(normalizeLabel("Sim", noul), "true");
  assert.equal(normalizeLabel("no", noul), "false");
  assert.throws(() => normalizeLabel("maybe", noul), /not a yes\/no/);

  const score = { type: "score" as const, instructions: "How bad?", criteria: ["low", "high"] };
  assert.equal(normalizeLabel("High", score), "1");
  assert.equal(normalizeLabel(0, score), "0");

  const choice = decideQuestion(options);
  assert.equal(normalizeLabel("redis", choice), "redis");
  assert.throws(() => normalizeLabel("memory", choice), /not one of the options/);
});

test("parseEvalJsonl accepts decide and raw question cases and reports bad lines", () => {
  const text = [
    JSON.stringify({ id: "d1", task: "store sessions", context: "pg", options, label: "postgres" }),
    "",
    JSON.stringify({
      state: "Server is down!",
      question: { type: "noul", instructions: "Urgent?" },
      label: "yes",
    }),
    "{not json",
    JSON.stringify({ task: "x", options, label: "memory" }),
    JSON.stringify({ task: "x", options: options.slice(0, 1), label: "postgres" }),
  ].join("\n");

  const { cases, errors } = parseEvalJsonl(text);

  assert.deepEqual(
    cases.map((c) => [c.id, c.label]),
    [
      ["d1", "postgres"],
      ["line-3", "true"],
    ],
  );
  assert.equal(cases[0].state, "Task: store sessions\nContext: pg");
  assert.equal(errors.length, 3);
  assert.match(errors[0], /line 4: not valid JSON/);
  assert.match(errors[1], /line 5: .*not one of the options/);
  assert.match(errors[2], /line 6:/);
});

function scored(entries: [number, boolean][]): ScoredCase[] {
  return entries.map(([probability, correct], i) => ({
    id: `c${i}`,
    label: "a",
    predicted: correct ? "a" : "b",
    probability,
    correct,
  }));
}

test("accuracyByBand buckets by top probability, with 1.0 in the last band", () => {
  const bands = accuracyByBand(
    scored([
      [0.4, false],
      [0.55, true],
      [0.58, false],
      [0.95, true],
      [1, true],
    ]),
  );
  assert.deepEqual(
    bands.map((b) => [b.band, b.n, b.accuracy]),
    [
      ["0.0-0.5", 1, 0],
      ["0.5-0.6", 2, 0.5],
      ["0.6-0.7", 0, null],
      ["0.7-0.8", 0, null],
      ["0.8-0.9", 0, null],
      ["0.9-1.0", 2, 1],
    ],
  );
});

test("suggestThreshold picks the lowest threshold meeting target accuracy with enough support", () => {
  const data = scored([
    [0.55, false],
    [0.6, false],
    [0.65, true],
    [0.72, true],
    [0.78, true],
    [0.82, true],
    [0.9, true],
    [0.95, true],
  ]);

  const suggestion = suggestThreshold(data, 0.9, 3);
  assert.equal(suggestion?.threshold, 0.65);
  assert.equal(suggestion?.covered, 6);
  assert.equal(suggestion?.accuracy, 1);

  assert.equal(suggestThreshold(data, 0.9, 10), null);
  assert.deepEqual(statsAtThreshold(data, 0.75), {
    threshold: 0.75,
    covered: 4,
    coverage: 0.5,
    accuracy: 1,
  });
});

test("mapLimit preserves order and caps concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapLimit([30, 10, 20, 5, 15], 2, async (ms) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, ms));
    inFlight--;
    return ms * 2;
  });
  assert.deepEqual(results, [60, 20, 40, 10, 30]);
  assert.equal(peak, 2);
});

// Pure helpers for the decision-model tools (decide / ask_decision /
// eval_decisions): question shapes for LM Studio's TypeSafe-compatible
// POST /v1/systemone endpoint, answer interpretation, and eval metrics.
// Nothing in here does I/O except reading an eval dataset file.
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const MIN_DECIDE_OPTIONS = 2;
export const MAX_DECIDE_OPTIONS = 6;
export const MAX_EVAL_FILE_BYTES = 5 * 1024 * 1024;

export const DECIDE_INSTRUCTIONS =
  "Which option is the best way to accomplish the task given the context?";

const nonEmpty = z.string().trim().min(1);

export const optionSchema = z.object({
  id: nonEmpty.describe("Short stable id for the option, e.g. 'postgres'"),
  description: nonEmpty.describe("One neutral sentence describing the option"),
});

export type DecideOption = z.infer<typeof optionSchema>;

export const decideOptionsSchema = z
  .array(optionSchema)
  .min(MIN_DECIDE_OPTIONS)
  .max(MAX_DECIDE_OPTIONS)
  .refine((options) => new Set(options.map((o) => o.id)).size === options.length, {
    message: "Option ids must be unique.",
  });

export const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    instructions: nonEmpty,
    criteria: z
      .record(z.string(), z.string().nullable())
      .refine((c) => Object.keys(c).length >= 2, { message: "A choice needs at least 2 options." })
      .describe("Option id -> description (null when the id says it all)"),
  }),
  z.object({
    type: z.literal("score"),
    instructions: nonEmpty,
    criteria: z.array(nonEmpty).min(2).max(10).describe("Ordered levels, lowest first"),
  }),
  z.object({
    type: z.literal("noul"),
    instructions: nonEmpty.describe("A yes/no question"),
    criteria: z
      .object({ true: z.string().optional(), false: z.string().optional() })
      .optional()
      .describe("Optional descriptions of what yes and no mean"),
  }),
]);

export type Question = z.infer<typeof questionSchema>;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | { type: "noul"; noul: number };

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function decideState(task: string, context?: string): string {
  return context?.trim() ? `Task: ${task}\nContext: ${context}` : `Task: ${task}`;
}

export function decideQuestion(options: DecideOption[]): Question {
  return {
    type: "choice",
    instructions: DECIDE_INSTRUCTIONS,
    criteria: Object.fromEntries(options.map((o) => [o.id, o.description])),
  };
}

export interface RankedOption {
  id: string;
  probability: number;
}

export function rankProbabilities(probabilities: Record<string, number>): RankedOption[] {
  return Object.entries(probabilities)
    .map(([id, probability]) => ({ id, probability }))
    .sort((a, b) => b.probability - a.probability);
}

export interface Prediction {
  label: string;
  probability: number;
}

/**
 * Collapses any answer type into "what did the model pick, and how sure was
 * it", so accuracy and calibration can be measured the same way for all three
 * question types. A noul answer picks "true" or "false"; a score answer picks
 * its most likely level index.
 */
export function predictionFromAnswer(answer: Answer): Prediction {
  switch (answer.type) {
    case "choice":
      return { label: answer.choice, probability: answer.probabilities[answer.choice] ?? 0 };
    case "noul":
      return answer.noul >= 0.5
        ? { label: "true", probability: answer.noul }
        : { label: "false", probability: 1 - answer.noul };
    case "score": {
      const [top] = rankProbabilities(answer.probabilities);
      return { label: top?.id ?? "", probability: top?.probability ?? 0 };
    }
  }
}

const TRUE_LABELS = new Set(["true", "yes", "y", "1", "sim"]);
const FALSE_LABELS = new Set(["false", "no", "n", "0", "nao", "não"]);

/** Normalizes a dataset label into the same vocabulary as `predictionFromAnswer`. */
export function normalizeLabel(label: string | number | boolean, question: Question): string {
  if (question.type === "noul") {
    const text = String(label).trim().toLowerCase();
    if (TRUE_LABELS.has(text)) return "true";
    if (FALSE_LABELS.has(text)) return "false";
    throw new Error(`label '${label}' is not a yes/no value`);
  }
  if (question.type === "score") {
    if (typeof label === "number") return String(label);
    const index = question.criteria.findIndex(
      (level) => level.toLowerCase() === String(label).trim().toLowerCase(),
    );
    if (index >= 0) return String(index);
    if (/^\d+$/.test(String(label).trim())) return String(label).trim();
    throw new Error(`label '${label}' is neither a level index nor one of the levels`);
  }
  const id = String(label).trim();
  if (!(id in question.criteria)) {
    throw new Error(
      `label '${id}' is not one of the options (${Object.keys(question.criteria).join(", ")})`,
    );
  }
  return id;
}

const evalCaseSchema = z.union([
  z.object({
    id: z.string().optional(),
    task: nonEmpty,
    context: z.string().optional(),
    options: decideOptionsSchema,
    label: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({
    id: z.string().optional(),
    state: jsonValueSchema,
    question: questionSchema,
    label: z.union([z.string(), z.number(), z.boolean()]),
  }),
]);

export interface EvalCase {
  id: string;
  state: JsonValue;
  question: Question;
  label: string;
}

/**
 * Parses a labeled .jsonl dataset. Each line is either a `decide` case
 * (`{task, context?, options, label}`, label = winning option id) or a raw
 * question case (`{state, question, label}`). Invalid lines are reported
 * together instead of failing on the first one.
 */
export function parseEvalJsonl(text: string): { cases: EvalCase[]; errors: string[] } {
  const cases: EvalCase[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const lineNo = index + 1;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      errors.push(`line ${lineNo}: not valid JSON`);
      return;
    }
    const parsed = evalCaseSchema.safeParse(json);
    if (!parsed.success) {
      errors.push(`line ${lineNo}: ${parsed.error.issues[0]?.message ?? "invalid case"}`);
      return;
    }
    const raw = parsed.data;
    const id = raw.id ?? `line-${lineNo}`;
    const state = "task" in raw ? decideState(raw.task, raw.context) : raw.state;
    const question = "task" in raw ? decideQuestion(raw.options) : raw.question;
    try {
      cases.push({ id, state, question, label: normalizeLabel(raw.label, question) });
    } catch (err) {
      errors.push(`line ${lineNo}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { cases, errors };
}

export async function readEvalFile(filePath: string): Promise<string> {
  if (path.extname(filePath) !== ".jsonl") {
    throw new Error(`'${filePath}' is not a .jsonl file.`);
  }
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile()) throw new Error(`'${filePath}' does not exist or is not a file.`);
  if (stat.size > MAX_EVAL_FILE_BYTES) {
    throw new Error(`'${filePath}' exceeds the ${MAX_EVAL_FILE_BYTES / 1024 / 1024}MB limit.`);
  }
  return fs.readFile(filePath, "utf8");
}

export interface ScoredCase {
  id: string;
  label: string;
  predicted: string;
  probability: number;
  correct: boolean;
}

export interface BandStats {
  band: string;
  n: number;
  accuracy: number | null;
}

const BAND_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

export function accuracyByBand(scored: ScoredCase[]): BandStats[] {
  return BAND_EDGES.slice(0, -1).map((low, i) => {
    const high = BAND_EDGES[i + 1];
    const isLast = i === BAND_EDGES.length - 2;
    const inBand = scored.filter(
      (s) => s.probability >= low && (isLast ? s.probability <= high : s.probability < high),
    );
    return {
      band: `${low.toFixed(1)}-${high.toFixed(1)}`,
      n: inBand.length,
      accuracy: inBand.length ? inBand.filter((s) => s.correct).length / inBand.length : null,
    };
  });
}

export interface ThresholdStats {
  threshold: number;
  covered: number;
  coverage: number;
  accuracy: number | null;
}

export function statsAtThreshold(scored: ScoredCase[], threshold: number): ThresholdStats {
  const covered = scored.filter((s) => s.probability >= threshold);
  return {
    threshold,
    covered: covered.length,
    coverage: scored.length ? covered.length / scored.length : 0,
    accuracy: covered.length ? covered.filter((s) => s.correct).length / covered.length : null,
  };
}

/**
 * Picks the lowest threshold (in 0.05 steps from 0.50) at which decisions the
 * model makes on its own — those with top probability >= threshold — are right
 * at least `targetAccuracy` of the time, over at least `minSupport` cases. The
 * lowest such threshold maximizes how often you can skip asking a human.
 */
export function suggestThreshold(
  scored: ScoredCase[],
  targetAccuracy: number,
  minSupport: number,
): ThresholdStats | null {
  for (let step = 10; step <= 19; step++) {
    const stats = statsAtThreshold(scored, step / 20);
    if (stats.covered >= minSupport && (stats.accuracy ?? 0) >= targetAccuracy) return stats;
  }
  return null;
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function pct(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LMStudioClient, type LoggerInterface, type ModelInfo } from "@lmstudio/sdk";
import {
  type DecideOption,
  type EvalCase,
  type JsonValue,
  type Question,
  type ScoredCase,
  type SystemOneResponse,
  accuracyByBand,
  decideOptionsSchema,
  decideQuestion,
  decideState,
  jsonValueSchema,
  mapLimit,
  parseEvalJsonl,
  pct,
  predictionFromAnswer,
  questionSchema,
  rankProbabilities,
  readEvalFile,
  statsAtThreshold,
  suggestThreshold,
} from "./decisions.ts";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Creates a step notifier bound to one tool call. Each call sends a
 * `notifications/message` (logging) notification, and — if the caller
 * supplied a `progressToken` in `_meta` — an accompanying
 * `notifications/progress` notification with an incrementing counter.
 */
function createStepNotifier(extra: ToolExtra) {
  let progress = 0;
  const progressToken = extra._meta?.progressToken;
  return async (message: string): Promise<void> => {
    progress += 1;
    await extra.sendNotification({
      method: "notifications/message",
      params: { level: "info", data: message },
    });
    if (progressToken !== undefined) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress },
      });
    }
  };
}

export const BASE_URL = (process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234").replace(
  /\/$/,
  "",
);

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const sessions = new Map<string, ChatMessage[]>();

export class LmStudioRequestError extends Error {
  readonly kind: "unreachable" | "timeout" | "http";
  readonly status?: number;

  constructor(message: string, kind: "unreachable" | "timeout" | "http", status?: number) {
    super(message);
    this.name = "LmStudioRequestError";
    this.kind = kind;
    this.status = status;
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

export async function lmFetch(path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, init);
  } catch (err) {
    if (isTimeout(err)) {
      throw new LmStudioRequestError(
        `LM Studio at ${BASE_URL} did not answer ${path} in time.`,
        "timeout",
      );
    }
    throw new LmStudioRequestError(
      `Cannot reach LM Studio at ${BASE_URL}. Is the local server running (LM Studio > Developer > Start Server)? ${
        err instanceof Error ? err.message : String(err)
      }`,
      "unreachable",
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LmStudioRequestError(
      `LM Studio request failed: ${res.status} ${res.statusText} ${body}`,
      "http",
      res.status,
    );
  }
  return res.json();
}

interface LMStudioModel {
  id: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  [key: string]: unknown;
}

type ModelDomain = "llm" | "embedding" | "decision";

const MODEL_DOMAINS: readonly ModelDomain[] = ["llm", "embedding", "decision"];

/**
 * LM Studio's REST listing names types differently from the SDK domains:
 * vision LLMs are "vlm" (they chat like any LLM) and embedding models are
 * "embeddings".
 */
function domainOf(model: LMStudioModel): ModelDomain | undefined {
  if (model.type === "vlm") return "llm";
  if (model.type === "embeddings") return "embedding";
  return MODEL_DOMAINS.find((d) => d === model.type);
}

export async function getModels(): Promise<LMStudioModel[]> {
  const data = await lmFetch("/api/v0/models");
  return data.data ?? [];
}

export async function getLoadedModels(): Promise<LMStudioModel[]> {
  const models = await getModels();
  return models.filter((m) => m.state === "loaded");
}

function describeModels(models: LMStudioModel[]): string {
  return models.length
    ? models.map((m) => (m.type ? `${m.id} (${m.type})` : m.id)).join(", ")
    : "(none currently loaded)";
}

/**
 * Throws unless `model` is loaded and (when LM Studio reports a type) belongs
 * to `domain`. Every tool that sends inference to LM Studio goes through this
 * first, because LM Studio's REST endpoints silently JIT-load an unloaded
 * model — the implicit load this server never allows outside load_model.
 */
export async function requireLoadedModel(model: string, domain: ModelDomain): Promise<void> {
  const loaded = await getLoadedModels();
  const match = loaded.find((m) => m.id === model);
  if (!match) {
    throw new Error(
      `Model '${model}' is not currently loaded in LM Studio. Currently loaded models: ${describeModels(loaded)}. ` +
        `Load '${model}' with load_model (or in the LM Studio app) first — this tool will not trigger an implicit load.`,
    );
  }
  const actual = domainOf(match);
  if (match.type && actual !== domain) {
    throw new Error(
      `Model '${model}' is a ${match.type} model, but this tool needs a model of type ${domain}. ` +
        `Currently loaded models: ${describeModels(loaded)}.`,
    );
  }
}

// --- lmstudio-js (WebSocket) client, used ONLY by load_model / unload_model ---
//
// Hitting an inference endpoint (/v1/chat/completions, /v1/embeddings,
// /v1/systemone) with an unloaded model silently JIT-loads it, which is
// exactly the implicit behavior this server avoids elsewhere. The official
// @lmstudio/sdk package talks to LM Studio over WebSocket and exposes an
// explicit per-domain load (client.llm / client.embedding / client.decision)
// with progress feedback and an idle TTL, so it's the only path used to bring
// a new model into memory — and only after elicitation.

const WS_BASE_URL = BASE_URL.replace(/^http/, "ws");

let lmStudioClient: LMStudioClient | undefined;

// MCP over stdio reserves stdout exclusively for JSON-RPC messages. The SDK's
// default logger writes to `console` (stdout for info/warn/log), which would
// corrupt the transport — so every log level is redirected to stderr instead.
const stderrLogger: LoggerInterface = {
  info: (...args) => console.error(...args),
  warn: (...args) => console.error(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => console.error(...args),
};

function getLmStudioClient(): LMStudioClient {
  if (!lmStudioClient) {
    lmStudioClient = new LMStudioClient({ baseUrl: WS_BASE_URL, logger: stderrLogger });
  }
  return lmStudioClient;
}

/**
 * Test-only injection point: lets the test suite substitute a fake
 * LMStudioClient (mocking the WebSocket SDK) without ever constructing a
 * real one. Not used by production code paths.
 */
export function __setLmStudioClientForTesting(client: LMStudioClient | undefined): void {
  lmStudioClient = client;
}

interface LoadedInstance {
  identifier: string;
  modelKey: string;
  path: string;
}

/** The slice of the SDK's per-domain namespace these tools use; identical across domains. */
interface DomainNamespace {
  listLoaded(): Promise<LoadedInstance[]>;
  load(
    modelKey: string,
    opts: { ttl?: number; verbose?: boolean; onProgress?: (progress: number) => void },
  ): Promise<LoadedInstance>;
  unload(identifier: string): Promise<void>;
}

function namespaceFor(client: LMStudioClient, domain: ModelDomain): DomainNamespace {
  return client[domain];
}

export function describeLmStudioWsError(err: unknown): string {
  // A genuine connection failure (e.g. LM Studio not running) surfaces as an
  // AggregateError with code ECONNREFUSED and an empty `message`. Other SDK
  // errors (e.g. load guardrails, bad model key) carry a real message that
  // should be shown as-is rather than being masked by a generic connectivity
  // message.
  const code = (err as { code?: unknown } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ECONNREFUSED" || !message) {
    return `Cannot reach LM Studio at ${WS_BASE_URL} (WebSocket). Is the local server running (LM Studio > Developer > Start Server)?`;
  }
  return `LM Studio request failed: ${message}`;
}

// dist/index.js sits one level below the package root, where package.json
// (and its version, bumped by semantic-release on every release) lives.
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const server = new McpServer(
  {
    name: "subforge-mcp",
    version: packageJson.version,
  },
  {
    capabilities: {
      logging: {},
    },
  },
);

function formatModelLine(m: LMStudioModel): string {
  return m.type ? `${m.id} (${m.type})` : m.id;
}

export async function listModelsHandler(
  { include_unloaded = false }: { include_unloaded?: boolean },
  extra: ToolExtra,
) {
  const notify = createStepNotifier(extra);
  await notify("Checking LM Studio for models...");
  const models = await getModels();
  const loaded = models.filter((m) => m.state === "loaded");
  await notify(`Found ${loaded.length} loaded model(s) out of ${models.length} downloaded.`);

  const sections = [
    loaded.length
      ? loaded.map(formatModelLine).join("\n")
      : "No models are currently loaded in LM Studio. Load one with load_model (or in the LM Studio app) first.",
  ];
  if (include_unloaded) {
    const unloaded = models.filter((m) => m.state !== "loaded");
    sections.push(
      unloaded.length
        ? `Downloaded, not loaded:\n${unloaded.map(formatModelLine).join("\n")}`
        : "Every downloaded model is loaded.",
    );
  }
  return { content: [{ type: "text" as const, text: sections.join("\n\n") }] };
}

server.registerTool(
  "list_models",
  {
    title: "List LM Studio models",
    description:
      "List models loaded into memory in the local LM Studio server, with their type: llm/vlm " +
      "(chat, delegate_task), embedding (rank_by_similarity) or decision (decide, ask_decision, " +
      "eval_decisions). Set include_unloaded to also see downloaded models load_model can load.",
    inputSchema: {
      include_unloaded: z
        .boolean()
        .optional()
        .describe("Also list downloaded models that are not loaded yet"),
    },
  },
  listModelsHandler,
);

interface ChatArgs {
  message: string;
  model: string;
  session_id?: string;
  system_prompt?: string;
  temperature?: number;
  max_tokens?: number;
}

export async function chatHandler(
  { message, model, session_id, system_prompt, temperature, max_tokens }: ChatArgs,
  extra: ToolExtra,
) {
  const notify = createStepNotifier(extra);
  const key = session_id ?? "default";
  let history = sessions.get(key);
  if (!history) {
    history = [];
    if (system_prompt) history.push({ role: "system", content: system_prompt });
    sessions.set(key, history);
  }

  await notify(`Verifying model '${model}' is loaded...`);
  await requireLoadedModel(model, "llm");

  history.push({ role: "user", content: message });

  await notify(`Sending request to LM Studio (${history.length} messages in history)...`);

  let elapsedSeconds = 0;
  const heartbeat = setInterval(() => {
    elapsedSeconds += 3;
    void notify(`Still waiting for a response... (${elapsedSeconds}s elapsed)`);
  }, 3000);

  let data: any;
  try {
    data = await lmFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: history,
        temperature: temperature ?? 0.7,
        ...(max_tokens ? { max_tokens } : {}),
      }),
    });
  } finally {
    clearInterval(heartbeat);
  }

  const reply = data.choices?.[0]?.message?.content ?? "";
  history.push({ role: "assistant", content: reply });

  await notify(`Received reply (${reply.length} characters).`);

  return { content: [{ type: "text" as const, text: reply }] };
}

server.registerTool(
  "chat",
  {
    title: "Chat with local LM Studio model",
    description:
      "Send a message to a local model running in LM Studio. Maintains conversation history per session_id across calls; call reset_chat to clear it.",
    inputSchema: {
      message: z.string().describe("User message to send"),
      model: z.string().describe("Model id, e.g. from list_models"),
      session_id: z
        .string()
        .default("default")
        .describe("Conversation id to keep history separate across topics"),
      system_prompt: z
        .string()
        .optional()
        .describe("System prompt; only applied when starting a new session"),
      temperature: z.number().min(0).max(2).default(0.7).optional(),
      max_tokens: z.number().int().positive().optional(),
    },
  },
  chatHandler,
);

interface LoadModelArgs {
  model: string;
  ttl_seconds?: number;
}

export async function loadModelHandler({ model, ttl_seconds }: LoadModelArgs, extra: ToolExtra) {
  const notify = createStepNotifier(extra);

  await notify("Checking whether the connected client supports elicitation...");
  const clientCapabilities = server.server.getClientCapabilities();
  if (!clientCapabilities?.elicitation) {
    throw new Error(
      "The connected MCP client did not declare the 'elicitation' capability, so load_model cannot " +
        "obtain consent to load a model. Refusing to load anything. Connect with a client that " +
        "supports elicitation/create to use this tool.",
    );
  }

  const client = getLmStudioClient();

  await notify(`Looking up downloaded LM Studio models to validate '${model}'...`);
  let downloaded: ModelInfo[];
  try {
    downloaded = await client.system.listDownloadedModels();
  } catch (err) {
    throw new Error(describeLmStudioWsError(err));
  }

  const match = downloaded.find((m) => m.modelKey === model || m.path === model);
  if (!match) {
    const available = downloaded.length
      ? downloaded.map((m) => `${m.modelKey} (${m.type})`).join(", ")
      : "(none downloaded)";
    throw new Error(
      `Model '${model}' was not found among downloaded LM Studio models. Downloaded models: ${available}`,
    );
  }
  const namespace = namespaceFor(client, match.type);

  await notify(`Checking whether ${match.type} model '${match.modelKey}' is already loaded...`);
  let loadedInstances: LoadedInstance[];
  try {
    loadedInstances = await namespace.listLoaded();
  } catch (err) {
    throw new Error(describeLmStudioWsError(err));
  }
  const alreadyLoaded = loadedInstances.find(
    (m) => m.path === match.path || m.modelKey === match.modelKey,
  );
  if (alreadyLoaded) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Model '${match.modelKey}' is already loaded (identifier '${alreadyLoaded.identifier}'). No action needed; skipping elicitation.`,
        },
      ],
    };
  }

  const sizeGb = (match.sizeBytes / 1024 ** 3).toFixed(2);
  await notify(`Requesting user confirmation to load '${match.modelKey}' (${sizeGb} GB)...`);
  const elicitResult = await server.server.elicitInput({
    mode: "form",
    message:
      `Load ${match.type} model '${match.modelKey}' (${sizeGb} GB) into LM Studio memory? ` +
      `This will consume RAM/VRAM${
        ttl_seconds
          ? ` and will auto-unload after ${ttl_seconds}s of inactivity.`
          : " and will remain loaded until explicitly unloaded."
      }`,
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: "Load model",
          description: `Load '${match.modelKey}' into memory now?`,
          default: true,
        },
      },
      required: ["confirm"],
    },
  });

  if (elicitResult.action !== "accept" || elicitResult.content?.confirm !== true) {
    const verb = elicitResult.action === "decline" ? "declined" : "cancelled";
    return {
      content: [
        {
          type: "text" as const,
          text: `User ${verb} loading model '${match.modelKey}'. No changes were made.`,
        },
      ],
    };
  }

  await notify(`Loading '${match.modelKey}' into memory...`);
  let lastReportedPercent = -1;
  let instance: LoadedInstance;
  try {
    instance = await namespace.load(match.modelKey, {
      ttl: ttl_seconds,
      verbose: false,
      onProgress: (progress) => {
        const percent = Math.round(progress * 100);
        if (percent !== lastReportedPercent && percent % 10 === 0) {
          lastReportedPercent = percent;
          void notify(`Loading '${match.modelKey}'... ${percent}%`);
        }
      },
    });
  } catch (err) {
    throw new Error(describeLmStudioWsError(err));
  }

  await notify(`Model '${instance.identifier}' loaded successfully.`);

  return {
    content: [
      {
        type: "text" as const,
        text:
          `${match.type} model '${match.modelKey}' loaded successfully as '${instance.identifier}'.` +
          (ttl_seconds ? ` It will auto-unload after ${ttl_seconds}s of inactivity.` : ""),
      },
    ],
  };
}

server.registerTool(
  "load_model",
  {
    title: "Load a model into LM Studio memory",
    description:
      "Explicitly load a downloaded-but-not-yet-loaded model (llm, embedding or decision) into LM " +
      "Studio memory. Requires user " +
      "consent via MCP elicitation before loading — this is the only tool in this server that can " +
      "bring a new model into memory. Refuses if the connected client does not support elicitation, " +
      "or if the user declines.",
    inputSchema: {
      model: z
        .string()
        .describe("Model id/key to load, e.g. a modelKey or path from a downloaded models listing"),
      ttl_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Idle time-to-live in seconds; LM Studio auto-unloads the model after this much inactivity",
        ),
    },
  },
  loadModelHandler,
);

interface UnloadModelArgs {
  model: string;
}

export async function unloadModelHandler({ model }: UnloadModelArgs, extra: ToolExtra) {
  const notify = createStepNotifier(extra);
  const client = getLmStudioClient();

  await notify(`Checking whether '${model}' is loaded...`);
  let loadedByDomain: { domain: ModelDomain; instances: LoadedInstance[] }[];
  try {
    loadedByDomain = await Promise.all(
      MODEL_DOMAINS.map(async (domain) => ({
        domain,
        instances: await namespaceFor(client, domain).listLoaded(),
      })),
    );
  } catch (err) {
    throw new Error(describeLmStudioWsError(err));
  }

  const loadedInstances = loadedByDomain.flatMap(({ domain, instances }) =>
    instances.map((instance) => ({ domain, instance })),
  );
  const found = loadedInstances.find(
    ({ instance: m }) => m.identifier === model || m.modelKey === model || m.path === model,
  );
  if (!found) {
    const loadedList = loadedInstances.length
      ? loadedInstances.map(({ instance }) => instance.identifier).join(", ")
      : "(none currently loaded)";
    return {
      content: [
        {
          type: "text" as const,
          text: `Model '${model}' is not currently loaded in LM Studio. Currently loaded models: ${loadedList}.`,
        },
      ],
    };
  }

  const match = found.instance;
  await notify(`Unloading '${match.identifier}'...`);
  try {
    await namespaceFor(client, found.domain).unload(match.identifier);
  } catch (err) {
    throw new Error(describeLmStudioWsError(err));
  }

  await notify(`Model '${match.identifier}' unloaded successfully.`);

  return {
    content: [
      {
        type: "text" as const,
        text: `Model '${match.identifier}' unloaded successfully.`,
      },
    ],
  };
}

server.registerTool(
  "unload_model",
  {
    title: "Unload a model from LM Studio memory",
    description:
      "Explicitly unload a currently-loaded model from LM Studio memory. This is the counterpart to " +
      "load_model. Unlike load_model, this does NOT require user consent via MCP elicitation: " +
      "unloading only frees RAM/VRAM and is safely reversible (load it again any time), so it isn't " +
      "gated behind a confirmation prompt. Returns a plain informative result (not an error) if the " +
      "requested model isn't currently loaded.",
    inputSchema: {
      model: z
        .string()
        .describe(
          "Model to unload — matched against a currently-loaded model's identifier, modelKey, or " +
            "path (e.g. the identifier returned by load_model or list_models).",
        ),
    },
  },
  unloadModelHandler,
);

export async function resetChatHandler({ session_id }: { session_id?: string }) {
  if (session_id) {
    sessions.delete(session_id);
    return { content: [{ type: "text" as const, text: `Session '${session_id}' cleared.` }] };
  }
  sessions.clear();
  return { content: [{ type: "text" as const, text: "All sessions cleared." }] };
}

server.registerTool(
  "reset_chat",
  {
    title: "Reset chat session",
    description: "Clear the conversation history for a session_id (or all sessions).",
    inputSchema: {
      session_id: z.string().optional().describe("Session to clear; omit to clear all sessions"),
    },
  },
  resetChatHandler,
);

// --- rank_by_similarity: embedding models ---

export const MAX_SIMILARITY_DOCUMENTS = 200;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function preview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface RankBySimilarityArgs {
  query: string;
  documents: string[];
  model: string;
  top_k?: number;
}

export async function rankBySimilarityHandler(
  { query, documents, model, top_k = 10 }: RankBySimilarityArgs,
  extra: ToolExtra,
) {
  const notify = createStepNotifier(extra);
  await notify(`Verifying embedding model '${model}' is loaded...`);
  await requireLoadedModel(model, "embedding");

  await notify(`Embedding the query and ${documents.length} document(s)...`);
  const data = await lmFetch("/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: [query, ...documents] }),
  });
  const vectors: number[][] = [...(data.data ?? [])]
    .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    .map((d: { embedding: number[] }) => d.embedding);
  if (vectors.length !== documents.length + 1) {
    throw new Error(
      `LM Studio returned ${vectors.length} embeddings for ${documents.length + 1} inputs.`,
    );
  }

  const [queryVector, ...documentVectors] = vectors;
  const ranked = documentVectors
    .map((vector, index) => ({ index, score: cosine(queryVector, vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top_k);

  return {
    content: [
      {
        type: "text" as const,
        text: ranked
          .map((r) => `${r.score.toFixed(4)}  #${r.index}  ${preview(documents[r.index])}`)
          .join("\n"),
      },
    ],
    structuredContent: { model, ranking: ranked },
  };
}

server.registerTool(
  "rank_by_similarity",
  {
    title: "Rank texts by semantic similarity",
    description:
      "Embed a query and a list of documents with a loaded LM Studio embedding model and return " +
      "the documents ranked by cosine similarity to the query (score, original index, preview). " +
      "Vectors stay inside this server; only the ranking enters the conversation.",
    inputSchema: {
      query: z.string().min(1).describe("Text to compare every document against"),
      documents: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_SIMILARITY_DOCUMENTS)
        .describe("Candidate texts; results refer to them by their index in this array"),
      model: z.string().describe("Loaded embedding model id (see list_models)"),
      top_k: z.number().int().positive().optional().describe("How many results to return (10)"),
    },
  },
  rankBySimilarityHandler,
);

// --- Decision models: decide / ask_decision / eval_decisions ---
//
// These talk to LM Studio's TypeSafe-compatible POST /v1/systemone, which
// answers typed questions (choice / score / noul) with probabilities instead
// of generated text. Unlike the other tools they never throw: any failure
// (LM Studio down, model not loaded, timeout, bad response) comes back as a
// structured `{ ok: false, error: { code, message } }` result with
// probability 0, so a caller gating on probability can't mistake a failure
// for a confident answer, and a session waiting on a decision never hangs.

export const DECISION_TIMEOUT_MS = Number(process.env.SUBFORGE_DECISION_TIMEOUT_MS) || 30_000;

class DecisionToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DecisionErrorInfo {
  code: string;
  message: string;
}

export function describeDecisionError(err: unknown): DecisionErrorInfo {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DecisionToolError) return { code: err.code, message };
  if (err instanceof LmStudioRequestError) {
    if (err.kind === "unreachable") return { code: "lm_studio_unreachable", message };
    if (err.kind === "timeout") {
      return {
        code: "timeout",
        message: `${message} (limit ${DECISION_TIMEOUT_MS}ms, SUBFORGE_DECISION_TIMEOUT_MS)`,
      };
    }
    if (err.status === 400) return { code: "invalid_request", message };
    if (err.status === 501) return { code: "not_a_decision_model", message };
    return { code: "lm_studio_error", message };
  }
  if (isTimeout(err)) return { code: "timeout", message };
  return { code: "internal_error", message };
}

/**
 * Picks the decision model to use: the explicit argument, else
 * the only loaded decision model. It must be
 * loaded already — /v1/systemone would otherwise JIT-load it.
 */
export async function resolveDecisionModel(requested?: string): Promise<string> {
  const models = await getModels();
  const loadedDecision = models.filter((m) => m.state === "loaded" && m.type === "decision");
  const wanted = requested?.trim();
  const loadedList = loadedDecision.map((m) => m.id).join(", ") || "(none)";

  if (wanted) {
    const match = models.find((m) => m.id === wanted);
    if (!match || match.state !== "loaded") {
      throw new DecisionToolError(
        "model_not_loaded",
        `Decision model '${wanted}' is not loaded in LM Studio (loaded decision models: ${loadedList}). ` +
          `Find one with list_models (include_unloaded) and load it with load_model first — decision tools never trigger an implicit load.`,
      );
    }
    if (match.type && match.type !== "decision") {
      throw new DecisionToolError(
        "not_a_decision_model",
        `'${wanted}' is a ${match.type} model, not a decision model (loaded decision models: ${loadedList}).`,
      );
    }
    return wanted;
  }
  if (loadedDecision.length === 1) return loadedDecision[0].id;
  if (loadedDecision.length === 0) {
    throw new DecisionToolError(
      "no_decision_model_loaded",
      "No decision model is loaded in LM Studio. Find one with list_models (include_unloaded) and " +
        "load it with load_model.",
    );
  }
  throw new DecisionToolError(
    "ambiguous_decision_model",
    `Several decision models are loaded (${loadedList}); pass model to pick one.`,
  );
}

export async function systemOne(
  model: string,
  state: JsonValue,
  questions: Record<string, Question>,
): Promise<SystemOneResponse> {
  const data = await lmFetch("/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
  });
  if (!data?.answers || typeof data.answers !== "object") {
    throw new DecisionToolError("unexpected_response", "LM Studio returned no answers object.");
  }
  return data as SystemOneResponse;
}

function jsonResult(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

interface DecideArgs {
  task: string;
  context?: string;
  options: DecideOption[];
  model?: string;
}

export async function decideHandler(
  { task, context, options, model }: DecideArgs,
  extra: ToolExtra,
) {
  const notify = createStepNotifier(extra);
  try {
    const resolved = await resolveDecisionModel(model);
    await notify(`Asking '${resolved}' to choose among ${options.length} options...`);
    const data = await systemOne(resolved, decideState(task, context), {
      decision: decideQuestion(options),
    });
    const answer = data.answers.decision;
    if (answer?.type !== "choice") {
      throw new DecisionToolError("unexpected_response", "LM Studio returned no choice answer.");
    }
    const descriptions = new Map(options.map((o) => [o.id, o.description]));
    return jsonResult({
      ok: true,
      model: data.model ?? resolved,
      choice: answer.choice,
      probability: answer.probabilities[answer.choice] ?? 0,
      confidence: answer.confidence,
      ranking: rankProbabilities(answer.probabilities).map((r) => ({
        ...r,
        description: descriptions.get(r.id),
      })),
    });
  } catch (err) {
    return jsonResult(
      {
        ok: false,
        error: describeDecisionError(err),
        choice: null,
        probability: 0,
        confidence: 0,
        ranking: [],
      },
      true,
    );
  }
}

server.registerTool(
  "decide",
  {
    title: "Pick between options with a local decision model",
    description:
      "Ask a loaded LM Studio decision model which of 2-6 options best accomplishes a task given " +
      "some context. Returns the chosen option id, its probability, the model's confidence and the " +
      "full ranking. Describe options neutrally — the wording is the whole input. Never throws: on " +
      "any failure it returns ok:false with an error code and probability 0, so treat probability " +
      "as the gate for acting on the answer.",
    inputSchema: {
      task: z.string().min(1).describe("What needs to be decided, in one or two sentences"),
      context: z
        .string()
        .optional()
        .describe("Constraints and product context that should drive the choice"),
      options: decideOptionsSchema.describe("2-6 options, each {id, description}"),
      model: z
        .string()
        .optional()
        .describe(
          "Decision model id; defaults to the only loaded decision model. Find one with list_models (include_unloaded) and load it with load_model.",
        ),
    },
  },
  decideHandler,
);

interface AskDecisionArgs {
  state: JsonValue;
  questions: Record<string, Question>;
  model?: string;
}

export async function askDecisionHandler(
  { state, questions, model }: AskDecisionArgs,
  extra: ToolExtra,
) {
  const notify = createStepNotifier(extra);
  try {
    const resolved = await resolveDecisionModel(model);
    await notify(`Asking '${resolved}' ${Object.keys(questions).length} question(s)...`);
    const data = await systemOne(resolved, state, questions);
    return jsonResult({
      ok: true,
      model: data.model ?? resolved,
      answers: data.answers,
      input_tokens: data.usage?.input_tokens,
    });
  } catch (err) {
    return jsonResult({ ok: false, error: describeDecisionError(err), answers: {} }, true);
  }
}

server.registerTool(
  "ask_decision",
  {
    title: "Ask a decision model raw typed questions",
    description:
      "Send typed questions about one state straight to a loaded LM Studio decision model " +
      "(POST /v1/systemone) and get the raw answers with probabilities. Use it to prototype a " +
      "question before relying on it. Types: choice (criteria = {option: description|null}), " +
      "score (criteria = 2-10 ordered levels, lowest first) and noul (yes/no; optional criteria " +
      "{true, false}). Question ids are not shown to the model, so put the meaning in " +
      "instructions. Never throws: failures come back as ok:false with an error code.",
    inputSchema: {
      state: jsonValueSchema.describe("Content to judge: a string, or JSON with named parts"),
      questions: z
        .record(z.string(), questionSchema)
        .refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= 16, {
          message: "Ask between 1 and 16 questions.",
        })
        .describe("Map of your question id to a question"),
      model: z
        .string()
        .optional()
        .describe(
          "Decision model id; defaults to the only loaded decision model. Find one with list_models (include_unloaded) and load it with load_model.",
        ),
    },
  },
  askDecisionHandler,
);

/** Errors after which asking the remaining eval cases would only repeat the failure. */
const FATAL_EVAL_CODES = new Set([
  "lm_studio_unreachable",
  "timeout",
  "not_a_decision_model",
  "model_not_loaded",
]);

interface EvalDecisionsArgs {
  path: string;
  model?: string;
  target_accuracy?: number;
  min_support?: number;
  current_threshold?: number;
}

export async function evalDecisionsHandler(
  {
    path: filePath,
    model,
    target_accuracy = 0.9,
    min_support = 5,
    current_threshold,
  }: EvalDecisionsArgs,
  extra: ToolExtra,
) {
  const notify = createStepNotifier(extra);
  try {
    const { cases, errors: parseErrors } = parseEvalJsonl(await readEvalFile(filePath));
    if (cases.length === 0) {
      throw new DecisionToolError(
        "empty_dataset",
        `No valid cases in '${filePath}'.${parseErrors.length ? ` ${parseErrors.slice(0, 5).join("; ")}` : ""}`,
      );
    }
    const resolved = await resolveDecisionModel(model);
    await notify(`Running ${cases.length} case(s) against '${resolved}'...`);

    let fatal: DecisionErrorInfo | undefined;
    const failures: { id: string; error: DecisionErrorInfo }[] = [];
    const outcomes = await mapLimit(cases, 4, async (c: EvalCase): Promise<ScoredCase | null> => {
      if (fatal) return null;
      try {
        const data = await systemOne(resolved, c.state, { q: c.question });
        const answer = data.answers.q;
        if (!answer) throw new DecisionToolError("unexpected_response", "No answer returned.");
        const prediction = predictionFromAnswer(answer);
        return {
          id: c.id,
          label: c.label,
          predicted: prediction.label,
          probability: prediction.probability,
          correct: prediction.label === c.label,
        };
      } catch (err) {
        const error = describeDecisionError(err);
        failures.push({ id: c.id, error });
        if (FATAL_EVAL_CODES.has(error.code)) fatal = error;
        return null;
      }
    });
    if (fatal) throw new DecisionToolError(fatal.code, `Eval aborted: ${fatal.message}`);

    const scored = outcomes.filter((s): s is ScoredCase => s !== null);
    if (scored.length === 0) {
      throw new DecisionToolError(
        failures[0]?.error.code ?? "internal_error",
        `Every case failed. First error: ${failures[0]?.error.message ?? "unknown"}`,
      );
    }

    const accuracy = scored.filter((s) => s.correct).length / scored.length;
    const bands = accuracyByBand(scored);
    const suggested = suggestThreshold(scored, target_accuracy, min_support);
    const current =
      current_threshold === undefined ? undefined : statsAtThreshold(scored, current_threshold);
    const misses = scored
      .filter((s) => !s.correct)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 5);

    const lines = [
      `${scored.length} case(s) scored with '${resolved}' — accuracy ${pct(accuracy)}`,
      "",
      "| probability | cases | accuracy |",
      "| --- | --- | --- |",
      ...bands.map((b) => `| ${b.band} | ${b.n} | ${pct(b.accuracy)} |`),
      "",
      suggested
        ? `Suggested threshold: ${suggested.threshold.toFixed(2)} — acts alone on ${pct(suggested.coverage)} of cases with ${pct(suggested.accuracy)} accuracy (target ${pct(target_accuracy)}).`
        : `No threshold reaches ${pct(target_accuracy)} accuracy over at least ${min_support} case(s); keep asking a human or collect more labeled cases.`,
    ];
    if (current) {
      lines.push(
        `Current threshold ${current.threshold.toFixed(2)}: acts alone on ${pct(current.coverage)} of cases with ${pct(current.accuracy)} accuracy.`,
      );
    }
    if (scored.length < 30) {
      lines.push(`Only ${scored.length} case(s): treat these numbers as a rough signal.`);
    }
    if (misses.length) {
      lines.push(
        "",
        "Most confident misses:",
        ...misses.map(
          (m) => `- ${m.id}: picked ${m.predicted} (${m.probability.toFixed(2)}), label ${m.label}`,
        ),
      );
    }
    const skipped = [...parseErrors, ...failures.map((f) => `${f.id}: ${f.error.message}`)];
    if (skipped.length) {
      lines.push("", `Skipped ${skipped.length}:`, ...skipped.slice(0, 10).map((s) => `- ${s}`));
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      structuredContent: {
        ok: true,
        model: resolved,
        cases: scored.length,
        accuracy,
        bands,
        suggested_threshold: suggested?.threshold ?? null,
        suggested,
        current: current ?? null,
        skipped: skipped.length,
      },
    };
  } catch (err) {
    return jsonResult(
      { ok: false, error: describeDecisionError(err), accuracy: 0, suggested_threshold: null },
      true,
    );
  }
}

server.registerTool(
  "eval_decisions",
  {
    title: "Measure a decision model against labeled cases",
    description:
      "Run every case in a labeled .jsonl file through a loaded LM Studio decision model and " +
      "report overall accuracy, accuracy per probability band (0.5-0.6, 0.6-0.7, ...) and the " +
      "lowest probability threshold whose auto-decisions reach target_accuracy. Each line is " +
      "either a decide case {id?, task, context?, options: [{id, description}], label: <option " +
      "id>} or a raw question case {id?, state, question, label}. Use it to set the threshold " +
      "for acting on decide without asking a human.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path to the .jsonl dataset (max 5MB)"),
      model: z
        .string()
        .optional()
        .describe(
          "Decision model id; defaults to the only loaded decision model. Find one with list_models (include_unloaded) and load it with load_model.",
        ),
      target_accuracy: z
        .number()
        .min(0.5)
        .max(1)
        .optional()
        .describe("Accuracy auto-decisions must reach (0.9)"),
      min_support: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Minimum cases above a threshold before it can be suggested (5)"),
      current_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Threshold in use today, to compare against the suggestion"),
    },
  },
  evalDecisionsHandler,
);

// --- delegate_task: a scoped, filesystem-grounded agentic loop that hands a ---
// small mechanical coding task to a local model, keeping file contents and
// the back-and-forth out of the calling conversation entirely.

// Lexical-only path check: this does not resolve symlinks, so a symlink
// inside `dir` that points outside it would not be caught here. That's
// acceptable because `dir` is supplied by the user configuring this tool,
// not by untrusted input. Separately (and structurally, not enforced by this
// function): no Bash/shell tool is ever defined for the delegate_task loop,
// so there is no way to escape `dir` via a shell command even if a path did.
export function safeResolvePath(dir: string, requestedPath: string): string {
  const rootDir = path.resolve(dir);
  const candidate = path.resolve(rootDir, requestedPath);
  const rel = path.relative(rootDir, candidate);
  if (rel !== "" && (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel))) {
    throw new Error(`Path '${requestedPath}' escapes the allowed directory '${rootDir}'.`);
  }
  return candidate;
}

export const MAX_FILE_BYTES = 100 * 1024;

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List files and subdirectories directly inside a directory (non-recursive), relative to the task's root directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory path relative to the root directory. Use '.' for the root itself.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the full text contents of a file, relative to the task's root directory. Fails if the file exceeds the size limit or does not exist.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the root directory." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Apply a search-and-replace edit to an existing text file: replaces exactly one occurrence of old_string with new_string. Fails loudly (no change made) if old_string is not found, or is found more than once — in that case, include more surrounding context in old_string to uniquely identify the location. Cannot create new files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the root directory." },
          old_string: {
            type: "string",
            description: "Exact text to find; must appear exactly once in the file.",
          },
          new_string: { type: "string", description: "Text to replace it with." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
] as const;

/**
 * Executes one model-requested tool call against the filesystem, scoped to
 * `rootDir`. Every ordinary failure (bad path, missing file, no/ambiguous
 * match, bad JSON, unknown tool name) is caught and turned into an
 * `"Error: ..."` string returned as the tool result — never thrown — so the
 * agentic loop keeps going and the model gets a chance to self-correct.
 * Successful `edit_file` calls record their (relative) path into
 * `touchedFiles`, used as a fallback summary if the model's final answer
 * comes back empty (see `delegateTaskHandler`).
 */
async function runTool(
  rootDir: string,
  name: string,
  argsJson: string,
  touchedFiles: Set<string>,
): Promise<string> {
  let args: any;
  try {
    args = JSON.parse(argsJson);
  } catch (err) {
    return `Error: invalid JSON arguments: ${err instanceof Error ? err.message : String(err)}`;
  }

  const requiredFieldsByTool: Record<string, string[]> = {
    list_dir: ["path"],
    read_file: ["path"],
    edit_file: ["path", "old_string", "new_string"],
  };
  const required = requiredFieldsByTool[name];
  if (required) {
    const missing = required.filter((f) => typeof args?.[f] !== "string" || args[f] === "");
    if (missing.length > 0) {
      return `Error: missing or empty required argument(s) for ${name}: ${missing.join(", ")}.`;
    }
  }

  try {
    switch (name) {
      case "list_dir": {
        const resolved = safeResolvePath(rootDir, args.path);
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        if (entries.length === 0) return "(empty directory)";
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n");
      }
      case "read_file": {
        const resolved = safeResolvePath(rootDir, args.path);
        const stat = await fs.stat(resolved);
        if (stat.size > MAX_FILE_BYTES) {
          return `Error: file exceeds the 100KB size guard (${stat.size} bytes): ${args.path}`;
        }
        return await fs.readFile(resolved, "utf8");
      }
      case "edit_file": {
        const resolved = safeResolvePath(rootDir, args.path);
        const stat = await fs.stat(resolved);
        if (stat.size > MAX_FILE_BYTES) {
          return `Error: file exceeds the 100KB size guard (${stat.size} bytes): ${args.path}`;
        }
        const content = await fs.readFile(resolved, "utf8");
        const occurrences = content.split(args.old_string).length - 1;
        if (occurrences === 0) {
          return `Error: old_string not found in ${args.path}. Nothing was changed.`;
        }
        if (occurrences > 1) {
          return (
            `Error: old_string matches ${occurrences} times in ${args.path}; add more context ` +
            `to uniquely identify it. Nothing was changed.`
          );
        }
        const updated = content.replace(args.old_string, args.new_string);
        await fs.writeFile(resolved, updated, "utf8");
        touchedFiles.add(args.path);
        return `Replaced 1 occurrence in ${args.path}.`;
      }
      default:
        return `Error: unknown tool '${name}'.`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function buildSystemPrompt(rootDir: string): string {
  return (
    `You are a coding assistant working inside the directory '${rootDir}'. You have three tools: ` +
    `list_dir, read_file, and edit_file — all paths you pass to them must be relative to this ` +
    `directory (e.g. 'src/utils.ts', or '.' for the root itself). Use them as needed to explore, ` +
    `read, and make the requested change. When you are done — or if you determine no change is ` +
    `needed — respond with a concise final text summary of what you did and make no further tool ` +
    `calls.`
  );
}

/** Strips a leaked `<think>...</think>` reasoning block from final model output, if present. */
function stripThinking(content: string): string {
  return content.replace(/<think>.*?<\/think>/gis, "").trim();
}

/**
 * Builds the text returned to the caller once the model stops requesting
 * tool calls. Some reasoning models (e.g. Qwen3 via LM Studio) put their
 * entire response in a separate `reasoning_content` field and leave
 * `message.content` blank/whitespace-only even on a fully successful task —
 * so an empty `content` here does NOT mean nothing happened. Falls back to
 * a summary built from the files the loop actually touched, rather than
 * silently returning empty text.
 */
function finalSummary(content: string, touchedFiles: Set<string>): string {
  const stripped = stripThinking(content);
  if (stripped) return stripped;
  if (touchedFiles.size === 0) {
    return "Task completed with no summary text from the model, and no files were changed.";
  }
  return (
    `Task completed with no summary text from the model. Files changed: ` +
    `${[...touchedFiles].join(", ")}.`
  );
}

interface DelegateTaskArgs {
  task: string;
  model: string;
  dir: string;
  max_turns?: number;
  think?: boolean;
}

export async function delegateTaskHandler(
  { task, model, dir, max_turns = 15, think = true }: DelegateTaskArgs,
  extra: ToolExtra,
) {
  const notify = createStepNotifier(extra);

  await notify(`Validating directory '${dir}'...`);
  const rootDir = path.resolve(dir);
  const stat = await fs.stat(rootDir).catch(() => undefined);
  if (!stat?.isDirectory()) {
    throw new Error(`'${dir}' does not exist or is not a directory. Refusing to start.`);
  }

  await notify(`Verifying model '${model}' is loaded...`);
  await requireLoadedModel(model, "llm");

  const messages: any[] = [
    { role: "system", content: buildSystemPrompt(rootDir) },
    { role: "user", content: task },
  ];
  const touchedFiles = new Set<string>();

  for (let turn = 1; turn <= max_turns; turn++) {
    await notify(`Turn ${turn}/${max_turns}: sending request to LM Studio...`);
    const data = await lmFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: TOOL_DEFS,
        tool_choice: "auto",
        temperature: 0.1,
        ...(think === false ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
    });

    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("LM Studio returned no message in choices[0].");
    messages.push(message);

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      await notify(`Model returned a final answer with no further tool calls.`);
      return {
        content: [
          { type: "text" as const, text: finalSummary(message.content ?? "", touchedFiles) },
        ],
      };
    }

    for (const call of toolCalls) {
      await notify(`Turn ${turn}: calling ${call.function.name}(${call.function.arguments})`);
      const resultText = await runTool(
        rootDir,
        call.function.name,
        call.function.arguments,
        touchedFiles,
      );
      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }
  }

  await notify(`Reached max_turns (${max_turns}) without a final answer.`);
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Ran out of turns (${max_turns}) before the model finished. It may have made partial ` +
          `edits inside '${rootDir}' — review before relying on this. Increase max_turns to let it finish.`,
      },
    ],
  };
}

server.registerTool(
  "delegate_task",
  {
    title: "Delegate a mechanical coding task to a local model",
    description:
      "Delegate a small, mechanical, multi-step coding task (a variable rename, a boring " +
      "find/replace, a boilerplate first-draft) to a local model in LM Studio. The local model " +
      "runs its own read/list/edit-file loop directly against the filesystem, scoped to `dir` — " +
      "file contents and the back-and-forth never enter this conversation, only the final summary " +
      "does, so this saves context on rote work. Pass only a plain-language `task`, never file " +
      "contents. Do NOT use this for anything requiring nuanced judgment, understanding " +
      "relationships across many files, awareness of the current conversation, or high-stakes/hard-" +
      "to-verify correctness — treat the local model as fast and free but low-reliability " +
      "('Haiku-tier assistant, not a replacement'); review the summary before trusting it blindly. " +
      "Scope tasks the way you'd scope a surgical 1-2 file edit, not a refactor spanning the tree.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "Plain-language instruction for the local model, e.g. 'rename variable foo to bar in " +
            "utils.ts'. Do not include file contents — the model reads files itself via its own tools.",
        ),
      model: z.string().describe("LM Studio model id (from list_models); must already be loaded."),
      dir: z
        .string()
        .describe(
          "Absolute path to the directory the local model's file tools are scoped to. All " +
            "read_file/list_dir/edit_file calls that would resolve outside this directory are refused.",
        ),
      max_turns: z
        .number()
        .int()
        .positive()
        .max(50)
        .default(15)
        .optional()
        .describe("Cap on agentic-loop iterations before returning a best-effort summary."),
      think: z
        .boolean()
        .default(true)
        .optional()
        .describe(
          "Best-effort hint to disable the model's reasoning/thinking output for simple tasks " +
            "(set false for speed). Not guaranteed — LM Studio's Jinja prompt template is the " +
            "reliable control for this; see README.",
        ),
    },
  },
  delegateTaskHandler,
);

// Only start the stdio transport when this file is run directly (e.g. `node
// dist/index.js` or via the `subforge-mcp` bin), not when it's imported as a
// module by the test suite. Comparing realpaths (rather than the raw argv[1])
// matters because npm/pnpm always invoke the bin through a symlink, which
// import.meta.url resolves through but process.argv[1] does not — a naive
// string comparison would never match for a globally-installed package.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === `file://${realpathSync(process.argv[1])}`;

if (isEntryPoint) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

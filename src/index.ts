#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LMStudioClient, type LLM, type LLMInfo, type LoggerInterface } from "@lmstudio/sdk";

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

export async function lmFetch(path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, init);
  } catch (err) {
    throw new Error(
      `Cannot reach LM Studio at ${BASE_URL}. Is the local server running (LM Studio > Developer > Start Server)? ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LM Studio request failed: ${res.status} ${res.statusText} ${body}`);
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

export async function getLoadedModels(): Promise<LMStudioModel[]> {
  const data = await lmFetch("/api/v0/models");
  const models: LMStudioModel[] = data.data ?? [];
  return models.filter((m) => m.state === "loaded");
}

// --- lmstudio-js (WebSocket) client, used ONLY by the load_model tool ---
//
// LM Studio's REST API has no explicit "load model" endpoint: hitting
// /v1/chat/completions with an unloaded model silently JIT-loads it, which is
// exactly the implicit behavior this server avoids elsewhere. The official
// @lmstudio/sdk package talks to LM Studio over WebSocket and exposes an
// explicit client.llm.load(...) with progress feedback, so it's the only
// path used to bring a new model into memory — and only after elicitation.

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

export async function listModelsHandler(_args: Record<string, never>, extra: ToolExtra) {
  const notify = createStepNotifier(extra);
  await notify("Checking LM Studio for loaded models...");
  const loaded = await getLoadedModels();
  await notify(`Found ${loaded.length} loaded model(s).`);
  return {
    content: [
      {
        type: "text" as const,
        text: loaded.length
          ? loaded.map((m) => m.id).join("\n")
          : "No models are currently loaded in LM Studio. Load a model in the LM Studio app first, then try again.",
      },
    ],
  };
}

server.registerTool(
  "list_models",
  {
    title: "List LM Studio models",
    description: "List models currently loaded into memory in the local LM Studio server.",
    inputSchema: {},
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
  const loaded = await getLoadedModels();
  if (!loaded.some((m) => m.id === model)) {
    const loadedList = loaded.length
      ? loaded.map((m) => m.id).join(", ")
      : "(none currently loaded)";
    throw new Error(
      `Model '${model}' is not currently loaded in LM Studio. Currently loaded models: ${loadedList}. ` +
        `Load '${model}' in the LM Studio app first — this tool will not trigger an implicit load.`,
    );
  }

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
  let downloaded: LLMInfo[];
  try {
    downloaded = await client.system.listDownloadedModels("llm");
  } catch (err) {
    throw new Error(describeLmStudioWsError(err));
  }

  const match = downloaded.find((m) => m.modelKey === model || m.path === model);
  if (!match) {
    const available = downloaded.length
      ? downloaded.map((m) => m.modelKey).join(", ")
      : "(none downloaded)";
    throw new Error(
      `Model '${model}' was not found among downloaded LM Studio models. Downloaded models: ${available}`,
    );
  }

  await notify(`Checking whether '${match.modelKey}' is already loaded...`);
  let loadedInstances: LLM[];
  try {
    loadedInstances = await client.llm.listLoaded();
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
      `Load model '${match.modelKey}' (${sizeGb} GB) into LM Studio memory? ` +
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
  let llm: LLM;
  try {
    llm = await client.llm.load(match.modelKey, {
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

  await notify(`Model '${llm.identifier}' loaded successfully.`);

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Model '${match.modelKey}' loaded successfully as '${llm.identifier}'.` +
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
      "Explicitly load a downloaded-but-not-yet-loaded model into LM Studio memory. Requires user " +
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

// Only start the stdio transport when this file is run directly (e.g. `node
// dist/index.js` or via the `subforge-mcp` bin), not when it's imported as a
// module by the test suite.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

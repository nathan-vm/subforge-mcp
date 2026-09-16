#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
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

interface UnloadModelArgs {
  model: string;
}

export async function unloadModelHandler({ model }: UnloadModelArgs, extra: ToolExtra) {
  const notify = createStepNotifier(extra);
  const client = getLmStudioClient();

  await notify(`Checking whether '${model}' is loaded...`);
  let loadedInstances: LLM[];
  try {
    loadedInstances = await client.llm.listLoaded();
  } catch (err) {
    throw new Error(describeLmStudioWsError(err));
  }

  const match = loadedInstances.find(
    (m) => m.identifier === model || m.modelKey === model || m.path === model,
  );
  if (!match) {
    const loadedList = loadedInstances.length
      ? loadedInstances.map((m) => m.identifier).join(", ")
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

  await notify(`Unloading '${match.identifier}'...`);
  try {
    await client.llm.unload(match.identifier);
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
  const loaded = await getLoadedModels();
  if (!loaded.some((m) => m.id === model)) {
    const loadedList = loaded.length
      ? loaded.map((m) => m.id).join(", ")
      : "(none currently loaded)";
    throw new Error(
      `Model '${model}' is not currently loaded in LM Studio. Currently loaded models: ${loadedList}. ` +
        `Load '${model}' in the LM Studio app first.`,
    );
  }

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

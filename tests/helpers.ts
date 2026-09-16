import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A minimal stand-in for the MCP SDK's `RequestHandlerExtra` that each tool
 * handler receives. The handlers under test only ever call
 * `extra.sendNotification(...)` (via `createStepNotifier`) and read
 * `extra._meta?.progressToken`, so that's all this fake needs to provide.
 */
export function makeExtra(meta?: Record<string, unknown>) {
  const notifications: unknown[] = [];
  const extra = {
    sendNotification: async (n: unknown) => {
      notifications.push(n);
    },
    sendRequest: async () => {
      throw new Error("sendRequest is not implemented in tests");
    },
    signal: new AbortController().signal,
    requestId: "test-request",
    _meta: meta,
  };
  return { extra: extra as any, notifications };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
}

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * Installs a `fetch` mock for the duration of one test (auto-restored by
 * node:test's per-test MockTracker) that dispatches based on which LM Studio
 * REST endpoint is being hit. Any call to an endpoint without a configured
 * handler throws loudly, so an unexpected request (e.g. `chat` calling
 * `/v1/chat/completions` despite a not-loaded model) fails the test instead
 * of silently succeeding against real state.
 */
export function mockFetch(
  t: TestContext,
  handlers: {
    models?: () => Response | Promise<Response>;
    chatCompletions?: (body: any) => Response | Promise<Response>;
  },
): FetchCall[] {
  const calls: FetchCall[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/v0/models")) {
      if (!handlers.models) throw new Error(`Unexpected fetch call to ${url}`);
      return handlers.models();
    }
    if (url.endsWith("/v1/chat/completions")) {
      if (!handlers.chatCompletions) throw new Error(`Unexpected fetch call to ${url}`);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return handlers.chatCompletions(body);
    }
    throw new Error(`Unmocked fetch call to ${url}`);
  });
  return calls;
}

/**
 * Creates a real temporary directory, runs `fn` with its path, and always
 * removes it afterward — used by delegate_task tests that need a real
 * filesystem for read_file/edit_file/list_dir to operate against.
 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "subforge-mcp-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

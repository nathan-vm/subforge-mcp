import test from "node:test";
import assert from "node:assert/strict";
import { chatHandler, sessions } from "../src/index.ts";
import { jsonResponse, makeExtra, mockFetch } from "./helpers.ts";

test.beforeEach(() => {
  sessions.clear();
});

test("chat refuses a model that is not loaded, without ever calling /v1/chat/completions", async (t) => {
  const calls = mockFetch(t, {
    models: () => jsonResponse({ data: [{ id: "other-model", state: "loaded" }] }),
  });
  const { extra } = makeExtra();

  await assert.rejects(
    () => chatHandler({ message: "hi", model: "missing-model", session_id: "s1" }, extra),
    /not currently loaded/
  );

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/api/v0/models"));
  assert.equal(sessions.get("s1")?.some((m) => m.role === "assistant"), false);
});

test("chat maintains conversation history across calls with the same session_id", async (t) => {
  const bodies: any[] = [];
  mockFetch(t, {
    models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
    chatCompletions: (body) => {
      bodies.push(body);
      return jsonResponse({ choices: [{ message: { content: `reply-${bodies.length}` } }] });
    },
  });
  const { extra } = makeExtra();

  const r1 = await chatHandler({ message: "first", model: "m1", session_id: "s1" }, extra);
  assert.equal(r1.content[0].text, "reply-1");
  assert.deepEqual(
    bodies[0].messages.map((m: any) => m.content),
    ["first"]
  );

  const r2 = await chatHandler({ message: "second", model: "m1", session_id: "s1" }, extra);
  assert.equal(r2.content[0].text, "reply-2");
  assert.deepEqual(
    bodies[1].messages.map((m: any) => m.content),
    ["first", "reply-1", "second"]
  );
});

test("chat isolates history between different session_ids", async (t) => {
  const bodies: any[] = [];
  mockFetch(t, {
    models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
    chatCompletions: (body) => {
      bodies.push(body);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    },
  });
  const { extra } = makeExtra();

  await chatHandler({ message: "from A", model: "m1", session_id: "a" }, extra);
  await chatHandler({ message: "from B", model: "m1", session_id: "b" }, extra);

  assert.deepEqual(
    bodies[0].messages.map((m: any) => m.content),
    ["from A"]
  );
  assert.deepEqual(
    bodies[1].messages.map((m: any) => m.content),
    ["from B"]
  );
  assert.equal(sessions.size, 2);
});

test("chat applies system_prompt only once, when a session is first created", async (t) => {
  const bodies: any[] = [];
  mockFetch(t, {
    models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
    chatCompletions: (body) => {
      bodies.push(body);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    },
  });
  const { extra } = makeExtra();

  await chatHandler({ message: "hi", model: "m1", session_id: "s1", system_prompt: "be nice" }, extra);
  assert.deepEqual(bodies[0].messages[0], { role: "system", content: "be nice" });

  await chatHandler({ message: "again", model: "m1", session_id: "s1", system_prompt: "ignored" }, extra);
  assert.equal(
    bodies[1].messages.filter((m: any) => m.role === "system").length,
    1
  );
});

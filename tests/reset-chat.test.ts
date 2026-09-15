import test from "node:test";
import assert from "node:assert/strict";
import { resetChatHandler, sessions } from "../src/index.ts";

test.beforeEach(() => {
  sessions.clear();
});

test("reset_chat clears only the given session_id", async () => {
  sessions.set("a", [{ role: "user", content: "hi" }]);
  sessions.set("b", [{ role: "user", content: "hey" }]);

  const result = await resetChatHandler({ session_id: "a" });

  assert.equal(sessions.has("a"), false);
  assert.equal(sessions.has("b"), true);
  assert.match(result.content[0].text, /'a' cleared/);
});

test("reset_chat clears all sessions when no session_id is given", async () => {
  sessions.set("a", []);
  sessions.set("b", []);

  const result = await resetChatHandler({});

  assert.equal(sessions.size, 0);
  assert.match(result.content[0].text, /All sessions cleared/);
});

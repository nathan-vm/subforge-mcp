import test from "node:test";
import assert from "node:assert/strict";
import { BASE_URL, getLoadedModels } from "../src/index.ts";

test("a clear error is raised when LM Studio is unreachable (fetch throws)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(
    () => getLoadedModels(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Cannot reach LM Studio/);
      assert.ok(err.message.includes(BASE_URL));
      // A clear, single-line message — not a raw stack trace dumped as the message.
      assert.equal(err.message.includes("\n"), false);
      assert.equal(/\bat \S+\s*\(/.test(err.message), false);
      return true;
    },
  );
});

test("a clear error is raised for a non-OK HTTP response", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("model not found", { status: 404, statusText: "Not Found" }),
  );

  await assert.rejects(() => getLoadedModels(), /LM Studio request failed: 404/);
});

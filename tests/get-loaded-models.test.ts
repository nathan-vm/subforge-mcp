import test from "node:test";
import assert from "node:assert/strict";
import { getLoadedModels } from "../src/index.ts";
import { jsonResponse, mockFetch } from "./helpers.ts";

test("getLoadedModels filters to state === 'loaded' only", async (t) => {
  mockFetch(t, {
    models: () =>
      jsonResponse({
        data: [
          { id: "model-a", state: "loaded" },
          { id: "model-b", state: "not-loaded" },
          { id: "model-c", state: "loaded" },
        ],
      }),
  });

  const loaded = await getLoadedModels();

  assert.deepEqual(
    loaded.map((m) => m.id),
    ["model-a", "model-c"],
  );
});

test("getLoadedModels returns an empty array when nothing is loaded", async (t) => {
  mockFetch(t, { models: () => jsonResponse({ data: [] }) });

  const loaded = await getLoadedModels();

  assert.deepEqual(loaded, []);
});

test("getLoadedModels tolerates a response with no data field", async (t) => {
  mockFetch(t, { models: () => jsonResponse({}) });

  const loaded = await getLoadedModels();

  assert.deepEqual(loaded, []);
});

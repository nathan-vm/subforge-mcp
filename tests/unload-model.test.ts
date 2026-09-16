import test from "node:test";
import assert from "node:assert/strict";
import { __setLmStudioClientForTesting, unloadModelHandler } from "../src/index.ts";
import { makeExtra } from "./helpers.ts";

interface FakeLoaded {
  modelKey: string;
  path: string;
  identifier: string;
}

function fakeClient(opts: {
  loaded?: FakeLoaded[];
  unload?: (identifier: string) => Promise<void>;
}) {
  return {
    llm: {
      listLoaded: async () => opts.loaded ?? [],
      unload:
        opts.unload ??
        (async () => {
          throw new Error("client.llm.unload should not have been called");
        }),
    },
  } as any;
}

test.afterEach(() => {
  __setLmStudioClientForTesting(undefined);
});

test("unload_model unloads a currently-loaded model matched by identifier", async () => {
  const unload = test.mock.fn(async (_identifier: string) => {});
  __setLmStudioClientForTesting(
    fakeClient({
      loaded: [{ modelKey: "m1", path: "/models/m1", identifier: "m1:0" }],
      unload,
    }),
  );
  const { extra } = makeExtra();

  const result = await unloadModelHandler({ model: "m1:0" }, extra);

  assert.match(result.content[0].text, /unloaded successfully/);
  assert.equal(unload.mock.calls.length, 1);
  assert.equal(unload.mock.calls[0].arguments[0], "m1:0");
  assert.equal("isError" in result, false);
});

test("unload_model matches by modelKey or path, not just identifier", async () => {
  const unloadByModelKey = test.mock.fn(async (_identifier: string) => {});
  __setLmStudioClientForTesting(
    fakeClient({
      loaded: [{ modelKey: "m1", path: "/models/m1", identifier: "m1:0" }],
      unload: unloadByModelKey,
    }),
  );
  const { extra: extraForModelKey } = makeExtra();
  await unloadModelHandler({ model: "m1" }, extraForModelKey);
  assert.equal(unloadByModelKey.mock.calls[0].arguments[0], "m1:0");

  const unloadByPath = test.mock.fn(async (_identifier: string) => {});
  __setLmStudioClientForTesting(
    fakeClient({
      loaded: [{ modelKey: "m1", path: "/models/m1", identifier: "m1:0" }],
      unload: unloadByPath,
    }),
  );
  const { extra: extraForPath } = makeExtra();
  await unloadModelHandler({ model: "/models/m1" }, extraForPath);
  assert.equal(unloadByPath.mock.calls[0].arguments[0], "m1:0");
});

test("unload_model returns a plain (non-error) result listing loaded models when the requested model isn't loaded", async () => {
  const unload = test.mock.fn(async () => {
    throw new Error("unload should not have been called");
  });
  __setLmStudioClientForTesting(
    fakeClient({
      loaded: [{ modelKey: "m1", path: "/models/m1", identifier: "m1:0" }],
      unload,
    }),
  );
  const { extra } = makeExtra();

  const result = await unloadModelHandler({ model: "does-not-exist" }, extra);

  assert.match(result.content[0].text, /not currently loaded/);
  assert.match(result.content[0].text, /m1:0/);
  assert.equal(unload.mock.calls.length, 0);
  assert.equal("isError" in result, false);
});

test("unload_model reports when nothing is loaded at all", async () => {
  __setLmStudioClientForTesting(fakeClient({ loaded: [] }));
  const { extra } = makeExtra();

  const result = await unloadModelHandler({ model: "m1" }, extra);

  assert.match(result.content[0].text, /not currently loaded/);
  assert.match(result.content[0].text, /\(none currently loaded\)/);
});

test("unload_model wraps SDK errors via describeLmStudioWsError", async () => {
  __setLmStudioClientForTesting(
    fakeClient({
      loaded: [{ modelKey: "m1", path: "/models/m1", identifier: "m1:0" }],
      unload: async () => {
        throw Object.assign(new Error(""), { code: "ECONNREFUSED" });
      },
    }),
  );
  const { extra } = makeExtra();

  await assert.rejects(
    () => unloadModelHandler({ model: "m1:0" }, extra),
    /Cannot reach LM Studio.*WebSocket/,
  );
});

test("unload_model wraps a listLoaded SDK error via describeLmStudioWsError", async () => {
  __setLmStudioClientForTesting({
    llm: {
      listLoaded: async () => {
        throw Object.assign(new Error(""), { code: "ECONNREFUSED" });
      },
      unload: async () => {
        throw new Error("unload should not have been called");
      },
    },
  } as any);
  const { extra } = makeExtra();

  await assert.rejects(
    () => unloadModelHandler({ model: "m1" }, extra),
    /Cannot reach LM Studio.*WebSocket/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { __setLmStudioClientForTesting, loadModelHandler, server } from "../src/index.ts";
import { makeExtra } from "./helpers.ts";

interface FakeDownloaded {
  type?: "llm" | "embedding" | "decision";
  modelKey: string;
  path: string;
  sizeBytes: number;
}
interface FakeLoaded {
  modelKey: string;
  path: string;
  identifier: string;
}

function fakeClient(opts: {
  downloaded?: FakeDownloaded[];
  loaded?: FakeLoaded[];
  load?: (modelKey: string, options: unknown) => Promise<unknown>;
}) {
  const namespace = {
    listLoaded: async () => opts.loaded ?? [],
    load:
      opts.load ??
      (async () => {
        throw new Error("load should not have been called");
      }),
  };
  return {
    system: {
      listDownloadedModels: async () => (opts.downloaded ?? []).map((m) => ({ type: "llm", ...m })),
    },
    llm: namespace,
    embedding: namespace,
    decision: namespace,
  } as any;
}

test.afterEach(() => {
  __setLmStudioClientForTesting(undefined);
});

test("load_model refuses when the connected client does not support elicitation", async (t) => {
  t.mock.method(server.server, "getClientCapabilities", () => ({}));
  const listDownloaded = t.mock.fn(async () => [] as FakeDownloaded[]);
  __setLmStudioClientForTesting({
    system: { listDownloadedModels: listDownloaded },
    llm: {
      listLoaded: async () => [],
      load: async () => {
        throw new Error("unused");
      },
    },
  } as any);
  const { extra } = makeExtra();

  await assert.rejects(
    () => loadModelHandler({ model: "m1" }, extra),
    /did not declare the 'elicitation' capability/,
  );
  assert.equal(
    listDownloaded.mock.calls.length,
    0,
    "should refuse before ever contacting LM Studio",
  );
});

test("load_model short-circuits with no elicitation when the model is already loaded", async (t) => {
  t.mock.method(server.server, "getClientCapabilities", () => ({ elicitation: {} }));
  const elicitInput = t.mock.method(server.server, "elicitInput", async () => {
    throw new Error("elicitInput should not have been called");
  });
  __setLmStudioClientForTesting(
    fakeClient({
      downloaded: [{ modelKey: "m1", path: "/models/m1", sizeBytes: 1_000_000_000 }],
      loaded: [{ modelKey: "m1", path: "/models/m1", identifier: "m1:0" }],
    }),
  );
  const { extra } = makeExtra();

  const result = await loadModelHandler({ model: "m1" }, extra);

  assert.match(result.content[0].text, /already loaded/);
  assert.equal(elicitInput.mock.calls.length, 0);
});

test("load_model returns a non-error 'declined' result and never loads when the user declines", async (t) => {
  t.mock.method(server.server, "getClientCapabilities", () => ({ elicitation: {} }));
  t.mock.method(server.server, "elicitInput", async () => ({ action: "decline" }));
  const load = t.mock.fn(async () => {
    throw new Error("load should not have been called");
  });
  __setLmStudioClientForTesting(
    fakeClient({
      downloaded: [{ modelKey: "m1", path: "/models/m1", sizeBytes: 1_000_000_000 }],
      loaded: [],
      load,
    }),
  );
  const { extra } = makeExtra();

  const result = await loadModelHandler({ model: "m1" }, extra);

  assert.match(result.content[0].text, /declined/);
  assert.equal(load.mock.calls.length, 0);
  // A decline is a normal tool result, not a thrown error.
  assert.equal("isError" in result, false);
});

test("load_model invokes client.llm.load when the user accepts", async (t) => {
  t.mock.method(server.server, "getClientCapabilities", () => ({ elicitation: {} }));
  t.mock.method(server.server, "elicitInput", async () => ({
    action: "accept",
    content: { confirm: true },
  }));
  const load = t.mock.fn(async (modelKey: string, _options?: unknown) => ({
    identifier: `${modelKey}:1`,
  }));
  __setLmStudioClientForTesting(
    fakeClient({
      downloaded: [{ modelKey: "m1", path: "/models/m1", sizeBytes: 1_000_000_000 }],
      loaded: [],
      load,
    }),
  );
  const { extra } = makeExtra();

  const result = await loadModelHandler({ model: "m1", ttl_seconds: 300 }, extra);

  assert.match(result.content[0].text, /loaded successfully/);
  assert.equal(load.mock.calls.length, 1);
  assert.equal(load.mock.calls[0].arguments[0], "m1");
  assert.equal((load.mock.calls[0].arguments[1] as any).ttl, 300);
});

test("load_model rejects with a clear message when the model is not among downloaded models", async (t) => {
  t.mock.method(server.server, "getClientCapabilities", () => ({ elicitation: {} }));
  __setLmStudioClientForTesting(fakeClient({ downloaded: [] }));
  const { extra } = makeExtra();

  await assert.rejects(
    () => loadModelHandler({ model: "does-not-exist" }, extra),
    /was not found among downloaded LM Studio models/,
  );
});

test("load_model loads a decision model through the decision namespace after consent", async (t) => {
  t.mock.method(server.server, "getClientCapabilities", () => ({ elicitation: {} }));
  const elicitInput = t.mock.method(server.server, "elicitInput", async () => ({
    action: "accept",
    content: { confirm: true },
  }));
  const llmLoad = t.mock.fn(async () => {
    throw new Error("the llm namespace should not be used for a decision model");
  });
  const decisionLoad = t.mock.fn(async (modelKey: string, _options?: unknown) => ({
    identifier: modelKey,
  }));
  __setLmStudioClientForTesting({
    system: {
      listDownloadedModels: async () => [
        { type: "decision", modelKey: "d1-3b", path: "/models/d1-3b", sizeBytes: 3_700_000_000 },
      ],
    },
    llm: { listLoaded: async () => [], load: llmLoad },
    embedding: { listLoaded: async () => [], load: llmLoad },
    decision: { listLoaded: async () => [], load: decisionLoad },
  } as any);
  const { extra } = makeExtra();

  const result = await loadModelHandler({ model: "d1-3b" }, extra);

  assert.match(result.content[0].text, /decision model 'd1-3b' loaded successfully/);
  assert.match((elicitInput.mock.calls[0].arguments[0] as any).message, /decision model/);
  assert.equal(decisionLoad.mock.calls.length, 1);
  assert.equal(llmLoad.mock.calls.length, 0);
});

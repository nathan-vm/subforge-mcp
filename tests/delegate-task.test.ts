import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { delegateTaskHandler, safeResolvePath } from "../src/index.ts";
import { jsonResponse, makeExtra, mockFetch, withTempDir } from "./helpers.ts";

function toolCallResponse(id: string, name: string, args: unknown) {
  return jsonResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  });
}

function finalResponse(content: string) {
  return jsonResponse({ choices: [{ message: { role: "assistant", content } }] });
}

test("safeResolvePath accepts nested relative paths and '.'", () => {
  const root = "/tmp/some/root";
  assert.equal(safeResolvePath(root, "a/b.txt"), path.resolve(root, "a/b.txt"));
  assert.equal(safeResolvePath(root, "."), path.resolve(root));
});

test("safeResolvePath throws for a path that escapes the root", () => {
  assert.throws(
    () => safeResolvePath("/tmp/some/root", "../secret"),
    /escapes the allowed directory/,
  );
});

test("safeResolvePath throws for an absolute path", () => {
  assert.throws(
    () => safeResolvePath("/tmp/some/root", "/etc/passwd"),
    /escapes the allowed directory/,
  );
});

test("delegate_task refuses a model that is not loaded, without ever calling /v1/chat/completions", async (t) => {
  await withTempDir(async (dir) => {
    const calls = mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "other-model", state: "loaded" }] }),
    });
    const { extra } = makeExtra();

    await assert.rejects(
      () => delegateTaskHandler({ task: "do something", model: "missing-model", dir }, extra),
      /not currently loaded/,
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/api/v0/models"));
  });
});

test("delegate_task rejects a nonexistent dir before any fetch call", async (t) => {
  const calls = mockFetch(t, {});
  const { extra } = makeExtra();

  await assert.rejects(
    () =>
      delegateTaskHandler(
        { task: "do something", model: "m1", dir: "/no/such/path/subforge-test" },
        extra,
      ),
    /does not exist or is not a directory/,
  );
  assert.equal(calls.length, 0);
});

test("delegate_task rejects a dir that is a file, not a directory, before any fetch call", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "not-a-dir.txt");
    await writeFile(filePath, "hello", "utf8");

    const calls = mockFetch(t, {});
    const { extra } = makeExtra();

    await assert.rejects(
      () => delegateTaskHandler({ task: "do something", model: "m1", dir: filePath }, extra),
      /does not exist or is not a directory/,
    );
    assert.equal(calls.length, 0);
  });
});

test("delegate_task reads a real file via read_file and returns the model's final answer", async (t) => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "a.txt"), "hello world", "utf8");

    const bodies: any[] = [];
    mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
      chatCompletions: (body) => {
        bodies.push(body);
        if (bodies.length === 1) {
          return toolCallResponse("call_1", "read_file", { path: "a.txt" });
        }
        return finalResponse("The file contains 'hello world'.");
      },
    });
    const { extra } = makeExtra();

    const result = await delegateTaskHandler({ task: "read a.txt", model: "m1", dir }, extra);

    assert.equal(bodies.length, 2);
    const toolResultMsg = bodies[1].messages.find((m: any) => m.role === "tool");
    assert.equal(toolResultMsg.content, "hello world");
    assert.equal(result.content[0].text, "The file contains 'hello world'.");
  });
});

test("delegate_task falls back to a files-changed summary when the model's content is blank", async (t) => {
  // Some reasoning models (e.g. Qwen3 via LM Studio) put their answer in a
  // separate `reasoning_content` field and leave `message.content`
  // whitespace-only even on success — this must not surface as empty text.
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "a.txt");
    await writeFile(filePath, "const foo = 1;", "utf8");

    const bodies: any[] = [];
    mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
      chatCompletions: (body) => {
        bodies.push(body);
        if (bodies.length === 1) {
          return toolCallResponse("call_1", "edit_file", {
            path: "a.txt",
            old_string: "foo",
            new_string: "bar",
          });
        }
        return finalResponse("\n\n");
      },
    });
    const { extra } = makeExtra();

    const result = await delegateTaskHandler(
      { task: "rename foo to bar in a.txt", model: "m1", dir },
      extra,
    );

    assert.match(result.content[0].text, /no summary text/);
    assert.match(result.content[0].text, /a\.txt/);

    const onDisk = await readFile(filePath, "utf8");
    assert.equal(onDisk, "const bar = 1;");
  });
});

test("delegate_task falls back to a no-changes summary when content is blank and nothing was edited", async (t) => {
  await withTempDir(async (dir) => {
    mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
      chatCompletions: () => finalResponse(""),
    });
    const { extra } = makeExtra();

    const result = await delegateTaskHandler({ task: "look around", model: "m1", dir }, extra);

    assert.match(result.content[0].text, /no summary text/);
    assert.match(result.content[0].text, /no files were changed/);
  });
});

test("delegate_task's edit_file mutates a real file on disk", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "a.txt");
    await writeFile(filePath, "const foo = 1;", "utf8");

    const bodies: any[] = [];
    mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
      chatCompletions: (body) => {
        bodies.push(body);
        if (bodies.length === 1) {
          return toolCallResponse("call_1", "edit_file", {
            path: "a.txt",
            old_string: "foo",
            new_string: "bar",
          });
        }
        return finalResponse("Renamed foo to bar.");
      },
    });
    const { extra } = makeExtra();

    const result = await delegateTaskHandler(
      { task: "rename foo to bar in a.txt", model: "m1", dir },
      extra,
    );

    const onDisk = await readFile(filePath, "utf8");
    assert.equal(onDisk, "const bar = 1;");
    assert.equal(result.content[0].text, "Renamed foo to bar.");
  });
});

test("delegate_task's edit_file reports no match and leaves the file unchanged", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "a.txt");
    await writeFile(filePath, "const foo = 1;", "utf8");

    const bodies: any[] = [];
    mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
      chatCompletions: (body) => {
        bodies.push(body);
        if (bodies.length === 1) {
          return toolCallResponse("call_1", "edit_file", {
            path: "a.txt",
            old_string: "does-not-exist",
            new_string: "bar",
          });
        }
        return finalResponse("Could not find the target text.");
      },
    });
    const { extra } = makeExtra();

    await delegateTaskHandler({ task: "rename in a.txt", model: "m1", dir }, extra);

    const toolResultMsg = bodies[1].messages.find((m: any) => m.role === "tool");
    assert.match(toolResultMsg.content, /not found/);

    const onDisk = await readFile(filePath, "utf8");
    assert.equal(onDisk, "const foo = 1;");
  });
});

test("delegate_task's edit_file reports an ambiguous match and leaves the file unchanged", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "a.txt");
    await writeFile(filePath, "foo foo", "utf8");

    const bodies: any[] = [];
    mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
      chatCompletions: (body) => {
        bodies.push(body);
        if (bodies.length === 1) {
          return toolCallResponse("call_1", "edit_file", {
            path: "a.txt",
            old_string: "foo",
            new_string: "bar",
          });
        }
        return finalResponse("Ambiguous, did not edit.");
      },
    });
    const { extra } = makeExtra();

    await delegateTaskHandler({ task: "rename in a.txt", model: "m1", dir }, extra);

    const toolResultMsg = bodies[1].messages.find((m: any) => m.role === "tool");
    assert.match(toolResultMsg.content, /matches 2 times/);

    const onDisk = await readFile(filePath, "utf8");
    assert.equal(onDisk, "foo foo");
  });
});

test("delegate_task's list_dir returns real directory contents", async (t) => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "a.txt"), "a", "utf8");
    await writeFile(path.join(dir, "b.txt"), "b", "utf8");
    await mkdir(path.join(dir, "sub"));

    const bodies: any[] = [];
    mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
      chatCompletions: (body) => {
        bodies.push(body);
        if (bodies.length === 1) {
          return toolCallResponse("call_1", "list_dir", { path: "." });
        }
        return finalResponse("Listed the directory.");
      },
    });
    const { extra } = makeExtra();

    await delegateTaskHandler({ task: "list the root dir", model: "m1", dir }, extra);

    const toolResultMsg = bodies[1].messages.find((m: any) => m.role === "tool");
    assert.match(toolResultMsg.content, /a\.txt/);
    assert.match(toolResultMsg.content, /b\.txt/);
    assert.match(toolResultMsg.content, /sub\//);
  });
});

test("delegate_task refuses a path-escape attempt without crashing, and the loop continues", async (t) => {
  await withTempDir(async (dir) => {
    const bodies: any[] = [];
    mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
      chatCompletions: (body) => {
        bodies.push(body);
        if (bodies.length === 1) {
          return toolCallResponse("call_1", "read_file", { path: "../../../etc/passwd" });
        }
        return finalResponse("I cannot read outside the allowed directory.");
      },
    });
    const { extra } = makeExtra();

    const result = await delegateTaskHandler({ task: "read /etc/passwd", model: "m1", dir }, extra);

    const toolResultMsg = bodies[1].messages.find((m: any) => m.role === "tool");
    assert.match(toolResultMsg.content, /escapes the allowed directory/);
    assert.equal(result.content[0].text, "I cannot read outside the allowed directory.");
  });
});

test("delegate_task reports missing/empty arguments clearly instead of a raw TypeError", async (t) => {
  await withTempDir(async (dir) => {
    const bodies: any[] = [];
    mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
      chatCompletions: (body) => {
        bodies.push(body);
        if (bodies.length === 1) {
          return toolCallResponse("call_1", "edit_file", {});
        }
        return finalResponse("Realized I forgot the arguments; giving up.");
      },
    });
    const { extra } = makeExtra();

    await delegateTaskHandler({ task: "edit something", model: "m1", dir }, extra);

    const toolResultMsg = bodies[1].messages.find((m: any) => m.role === "tool");
    assert.match(toolResultMsg.content, /missing or empty required argument/);
    assert.match(toolResultMsg.content, /path/);
    assert.match(toolResultMsg.content, /old_string/);
    assert.match(toolResultMsg.content, /new_string/);
  });
});

test("delegate_task stops at max_turns and returns a best-effort summary", async (t) => {
  await withTempDir(async (dir) => {
    let calls = 0;
    mockFetch(t, {
      models: () => jsonResponse({ data: [{ id: "m1", state: "loaded" }] }),
      chatCompletions: () => {
        calls += 1;
        return toolCallResponse(`call_${calls}`, "list_dir", { path: "." });
      },
    });
    const { extra } = makeExtra();

    const result = await delegateTaskHandler(
      { task: "loop forever", model: "m1", dir, max_turns: 2 },
      extra,
    );

    assert.match(result.content[0].text, /[Rr]an out of turns/);
    assert.equal(calls, 2);
  });
});

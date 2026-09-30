import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assignResearchSubagentTaskID,
  createSubagentYieldExtension,
  formatSubagentToolInput,
  formatSubagentYieldLines,
  isAsyncSubagentReceipt,
  normalizeSubagentYield,
  projectSubagentTaskForRenderer,
  projectResearchSubagentUpdates,
  projectSubagentRosterEnd,
  projectSubagentRosterStart,
  projectSubagentToolResult,
  redactResearchText,
  readSubagentYieldField,
  researchSubagentLaunchBlockReason,
  validateSubagentYield,
} from "./bridge-subagent-yield.js";

function validYield(overrides = {}) {
  return {
    status: "succeeded",
    cwd: ".",
    files: ["a.ts"],
    findings: [{ path: "a.ts", note: "renamed" }],
    exitCode: 0,
    ...overrides,
  };
}

test("normalize and validate accept a complete yield", () => {
  const value = normalizeSubagentYield(validYield());
  assert.equal(value.status, "succeeded");
  assert.deepEqual(value.files, ["a.ts"]);
  assert.equal(value.findings[0].path, "a.ts");
  assert.equal(value.exitCode, 0);
  assert.equal(validateSubagentYield(value), value);
});

test("validate rejects missing required fields", () => {
  assert.throws(() => validateSubagentYield({
    status: "succeeded",
    cwd: ".",
    exitCode: 0,
  }), /missing files/);
  assert.throws(() => validateSubagentYield({
    status: "succeeded",
    files: ["a.ts"],
    findings: [],
    exitCode: 0,
  }), /cwd or worktreeId/);
  assert.throws(() => validateSubagentYield({
    cwd: ".",
    files: [],
    findings: [],
    exitCode: 0,
  }), /missing status/);
  assert.throws(() => validateSubagentYield({
    status: "succeeded",
    cwd: ".",
    files: [],
    findings: [],
  }), /missing exitCode/);
  assert.throws(
    () => normalizeSubagentYield({ status: "succeeded", cwd: ".", exitCode: 0 }, { requireFields: true }),
    /missing files or findings/,
  );
});

test("read-only roles reject writer worktree paths in files and findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "milksu-yield-"));
  const writer = join(root, "writer-1");
  assert.throws(
    () => validateSubagentYield(validYield({
      files: [join(writer, "a.ts")],
      findings: [{ path: join(writer, "a.ts"), note: "wrote" }],
    }), {
      role: "scout",
      writerWorktreePaths: [writer],
    }),
    /Read-only subagent yield cannot include writer worktree paths/,
  );
  assert.throws(
    () => normalizeSubagentYield(validYield({
      files: ["writer-1/a.ts"],
      findings: [{ path: "writer-1/src.ts", note: "edited" }],
    }), {
      role: "researcher",
      worktrees: [{ id: "writer-1", path: writer }],
    }),
    /Read-only subagent yield cannot include writer worktree paths/,
  );
  const allowed = normalizeSubagentYield(validYield({
    files: ["src/review.ts"],
    findings: [{ path: "src/review.ts", note: "looks fine" }],
  }), {
    role: "reviewer",
    workspace: root,
  });
  assert.deepEqual(allowed.files, ["src/review.ts"]);
});

test("strips keys, home directories, and relay credentials from yield", () => {
  const home = join(tmpdir(), "milksu-home-user");
  const worktree = join(home, "collab", "writer-1");
  const value = normalizeSubagentYield({
    status: "succeeded",
    cwd: worktree,
    worktreeId: "writer-1",
    files: [join(worktree, "src", "a.ts")],
    findings: [{
      path: join(home, "secret.ts"),
      note: "token sk-live-abcdef12345678 and key=TOKENFLUX_SECRET_VALUE",
    }],
    exitCode: 0,
  }, {
    worktrees: [{ id: "writer-1", path: worktree }],
    workspace: join(home, "repo"),
    homeDirectory: home,
    environment: {
      MILKSU_RELAY_KEY: "relay-secret-value-123456",
      TOKENFLUX_API_KEY: "unused-but-present-key",
    },
    role: "worker",
  });
  assert.equal(value.files[0], "src/a.ts");
  assert.equal(value.worktreeId, "writer-1");
  assert.equal(value.files[0].includes(home), false);
  assert.equal(JSON.stringify(value).includes(home), false);
  assert.equal(JSON.stringify(value).includes("sk-live-"), false);
  assert.equal(JSON.stringify(value).includes("relay-secret-value-123456"), false);
  assert.match(value.findings[0].note, /\[REDACTED\]/);
});

test("parent loop reads files[0] from structured tool_result without extra tools", () => {
  const wrapped = projectSubagentToolResult({
    toolName: "subagent",
    content: [{ type: "text", text: "I renamed the helper and updated the imports." }],
    details: {
      results: [{
        agent: "worker",
        exitCode: 0,
        files: ["a.ts"],
        findings: [{ path: "a.ts", note: "renamed" }],
        cwd: "/work/writer-1",
      }],
    },
    input: { agent: "worker", cwd: "/work/writer-1" },
  }, {
    workspace: "/work",
    collaboration: { worktrees: [{ id: "writer-1", path: "/work/writer-1" }] },
  });

  function fakeProviderReadFiles0(toolResult) {
    return readSubagentYieldField(toolResult, "files[0]");
  }

  assert.equal(fakeProviderReadFiles0(wrapped), "a.ts");
  assert.equal(readSubagentYieldField(wrapped, "findings[0].path"), "a.ts");
  assert.equal(readSubagentYieldField(wrapped, "exitCode"), 0);
  const visible = wrapped.content[0].text;
  assert.match(visible, /^files\[0\]=a\.ts/m);
  assert.match(visible, /"files":\s*\[\s*"a\.ts"\s*\]/);
  assert.equal(wrapped.details.yield.files[0], "a.ts");
  assert.equal(wrapped.details.schema, "milksu-subagent-yield/v1");
});

test("roster start appears and end becomes succeeded or failed", () => {
  const started = projectSubagentRosterStart({
    agent: "scout",
    task: "map the module",
  }, { toolCallId: "call-1" });
  assert.equal(started.length, 1);
  assert.equal(started[0].id, "call-1");
  assert.equal(started[0].role, "scout");
  assert.equal(started[0].status, "start");

  const succeeded = projectSubagentRosterEnd(started, {
    details: {
      results: [{
        agent: "scout",
        exitCode: 0,
        files: ["readme.md"],
        findings: [{ path: "readme.md", note: "entry" }],
        cwd: ".",
      }],
    },
  }, { durationMs: 1200, toolCallId: "call-1" });
  assert.equal(succeeded[0].status, "succeeded");
  assert.equal(succeeded[0].exitCode, 0);
  assert.equal(succeeded[0].yield.files[0], "readme.md");
  assert.equal(succeeded[0].durationMs, 1200);

  const failed = projectSubagentRosterEnd(started, {
    details: {
      results: [{
        agent: "scout",
        exitCode: 2,
        files: [],
        findings: [],
        cwd: ".",
      }],
    },
  }, { durationMs: 40, isError: true, toolCallId: "call-1" });
  assert.equal(failed[0].status, "failed");
  assert.equal(failed[0].exitCode, 2);
});

test("failed Research workers retain a bounded redacted diagnostic summary", () => {
  const started = projectSubagentRosterStart({
    agent: "scout",
    task: "collect one official source",
  }, { toolCallId: "call-failed" });
  const failed = projectSubagentRosterEnd(started, {
    details: {
      results: [{
        agent: "scout",
        exitCode: 1,
        files: [],
        findings: [],
        error: "Worker runtime rejected API_KEY=synthetic-worker-secret",
      }],
    },
  }, {
    toolCallId: "call-failed",
    isError: true,
    secrets: ["synthetic-worker-secret"],
  });

  assert.equal(failed[0].status, "failed");
  assert.match(failed[0].summary, /Worker runtime rejected/);
  assert.match(failed[0].summary, /\[REDACTED\]/);
  assert.doesNotMatch(failed[0].summary, /synthetic-worker-secret/);
});

test("failed Research launches retain a redacted preflight block reason", () => {
  const reason = "Research worker launch blocked: submitted length 24; pending prompt lengths: 18. API_KEY=synthetic-worker-secret";
  const started = projectSubagentRosterStart({
    agent: "scout",
    task: "Collect source evidence",
  }, { toolCallId: "call-blocked" });
  const wrapped = projectSubagentToolResult({
    toolName: "subagent",
    content: [{ type: "text", text: reason }],
    details: { results: [] },
    input: { agent: "scout", task: "Collect source evidence" },
  }, {
    workspace: "/work",
    secrets: ["synthetic-worker-secret"],
  });
  const failed = projectSubagentRosterEnd(started, wrapped, {
    toolCallId: "call-blocked",
    isError: true,
    secrets: ["synthetic-worker-secret"],
  });

  assert.match(failed[0].summary, /Research worker launch blocked/);
  assert.match(failed[0].summary, /pending prompt lengths: 18/);
  assert.match(failed[0].summary, /API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(failed[0].summary, /synthetic-worker-secret/);
});

test("research worker projection tracks only new lanes and redacts credentials", () => {
  const baseline = new Set(["old-call"]);
  const tracked = new Set();
  const first = projectResearchSubagentUpdates([
    { id: "old-call", prompt: "ignore", status: "running" },
    {
      id: "call-1",
      prompt: "Compare standards without printing Bearer synthetic-provider-key",
      runId: "async-1",
      status: "start",
      summary: "API_KEY=synthetic-result-key synthetic-anthropic-key",
    },
  ], baseline, tracked, {
    TOKENFLUX_API_KEY: "synthetic-provider-key",
    ANTHROPIC_API_KEY: "synthetic-anthropic-key",
  });

  assert.deepEqual([...tracked], ["call-1"]);
  assert.equal(first.length, 1);
  assert.equal(first[0].workerId, "async-1");
  assert.equal(first[0].status, "running");
  assert.doesNotMatch(first[0].prompt, /synthetic-provider-key/);
  assert.doesNotMatch(first[0].result, /synthetic-result-key/);
  assert.doesNotMatch(first[0].result, /synthetic-anthropic-key/);

  const terminal = projectResearchSubagentUpdates([
    {
      id: "call-1",
      prompt: "Compare standards",
      runId: "async-1",
      status: "succeeded",
      transcript: "The official sources agree.",
    },
  ], baseline, tracked, {});
  assert.equal(terminal[0].status, "succeeded");
  assert.equal(terminal[0].result, "The official sources agree.");
});

test("subagent tool results redact opaque and short provider keys", () => {
  const opaque = "opaque-custom-provider-value";
  const asyncResult = projectSubagentToolResult({
    content: [{
      type: "text",
      text: `Async: scout [run-1]\n${opaque}\nThe async run is detached and running in the background.`,
    }],
    details: {
      mode: "single",
      runId: "run-1",
      customProviderKey: opaque,
    },
  }, { environment: { MILKSU_CUSTOM_PROVIDER_KEY: opaque } });
  assert.doesNotMatch(JSON.stringify(asyncResult), /opaque-custom-provider-value/);

  const synchronous = projectSubagentToolResult({
    content: [{ type: "text", text: `The source returned ${opaque}` }],
    details: {
      results: [{ agent: "scout", exitCode: 0, files: [], findings: [], cwd: "." }],
    },
  }, { secrets: [opaque] });
  assert.doesNotMatch(JSON.stringify(synchronous), /opaque-custom-provider-value/);

  const shortResult = projectSubagentToolResult({
    content: [{ type: "text", text: "The value xy is short; xylophone remains ordinary text." }],
    details: { results: [{ agent: "scout", exitCode: 0, files: [], findings: [], cwd: "." }] },
  }, { environment: { OPENAI_API_KEY: "xy" } });
  assert.doesNotMatch(JSON.stringify(shortResult), /value xy/);
  assert.match(JSON.stringify(shortResult), /xylophone/);
  assert.doesNotMatch(
    redactResearchText(`A query with ${opaque}`, { MILKSU_CUSTOM_PROVIDER_KEY: opaque }),
    /opaque-custom-provider-value/,
  );
});

test("research redaction removes signed URL credentials and secret object fields", () => {
  const text = redactResearchText(
    "https://storage.example.test/file?X-Amz-Credential=aws-id%2Fscope&X-Amz-Signature=aws-signature&X-Amz-Security-Token=aws-session&X-Goog-Signature=google-signature&AWSAccessKeyId=google-id&sig=azure-sig&keep=visible",
    {},
  );
  assert.doesNotMatch(text, /aws-id|aws-signature|aws-session|google-signature|google-id|azure-sig/);
  assert.match(text, /keep=visible/);

  const structured = redactResearchText({
    X_Amz_Signature: "structured-signature",
    apiKey: "structured-key",
    label: "ordinary value",
  }, {});
  assert.equal(structured.X_Amz_Signature, "[REDACTED]");
  assert.equal(structured.apiKey, "[REDACTED]");
  assert.equal(structured.label, "ordinary value");
});

test("renderer task snapshots redact credentials from async worker text", () => {
  const task = projectSubagentTaskForRenderer({
    id: "task-1",
    role: "scout",
    status: "running",
    summary: "API_KEY=synthetic-summary-key",
    transcript: "Found https://example.test/?token=synthetic-query-key",
    yield: { findings: [{ note: "Bearer synthetic-bearer-key" }] },
  }, {
    TOKENFLUX_API_KEY: "synthetic-summary-key",
  }, ["synthetic-query-key", "synthetic-bearer-key"]);

  assert.equal(task.id, "task-1");
  assert.doesNotMatch(JSON.stringify(task), /synthetic-(?:summary|query|bearer)-key/);
  assert.match(task.summary, /\[REDACTED\]/);
  assert.match(task.transcript, /\[REDACTED\]/);
});

test("research worker association requires an explicitly registered prompt", () => {
  const context = {
    baseline: new Set(["old-call"]),
    pending: new Map([["Collect source A", ["research_task_a", "research_task_b"]]]),
    workerTaskIDs: new Map(),
  };
  assert.equal(assignResearchSubagentTaskID({
    id: "old-call",
    prompt: "Collect source A",
  }, context), "");
  assert.equal(assignResearchSubagentTaskID({
    id: "unrelated-call",
    prompt: "Inspect another module",
  }, context), "");
  assert.equal(assignResearchSubagentTaskID({
    id: "call-a",
    prompt: "Collect source A",
  }, context), "research_task_a");
  assert.equal(assignResearchSubagentTaskID({
    id: "call-a",
    prompt: "updated transcript omitted the prompt",
  }, context), "research_task_a");
  assert.equal(assignResearchSubagentTaskID({
    id: "call-b",
    prompt: "Collect source A",
  }, context), "research_task_b");
});

test("research run blocks unregistered and non-scout worker launches", () => {
  const contexts = [{
    cancelled: false,
    pending: new Map([["Collect source A", ["research_task_a"]]]),
  }];
  assert.equal(researchSubagentLaunchBlockReason({
    agent: "scout",
    task: "Collect source A",
  }, contexts), "");
  assert.match(researchSubagentLaunchBlockReason({
    agent: "scout",
    task: "Inspect an unrelated module",
  }, contexts), /submitted length \d+; pending prompt lengths: 16/);
  assert.match(researchSubagentLaunchBlockReason({
    agent: "scout",
    task: "",
  }, contexts), /missing its registered task prompt/);
  assert.match(researchSubagentLaunchBlockReason({
    agent: "scout",
    task: "Collect source A",
  }, [{ cancelled: false, pending: new Map() }]), /no pending registered prompt is visible/);
  const startedContext = {
    cancelled: false,
    pending: new Map([["Collect source A", ["research_task_a"]]]),
    workerTaskIDs: new Map(),
    workerPrompts: new Map(),
  };
  assert.equal(assignResearchSubagentTaskID({
    id: "call-bound",
    prompt: "Collect source A",
  }, startedContext), "research_task_a");
  assert.equal(researchSubagentLaunchBlockReason({
    agent: "scout",
    task: "Collect source A",
  }, [startedContext], "call-bound"), "");
  assert.match(researchSubagentLaunchBlockReason({
    agent: "scout",
    task: "different prompt",
  }, [startedContext], "call-bound"), /no pending registered prompt is visible/);
  assert.match(researchSubagentLaunchBlockReason({
    agent: "scout",
    task: "Collect source A",
  }, [startedContext], "call-unbound"), /no pending registered prompt is visible/);
  assert.match(researchSubagentLaunchBlockReason({
    agent: "worker",
    task: "Collect source A",
  }, contexts), /scout/);
  assert.equal(researchSubagentLaunchBlockReason({ action: "status" }, contexts), "");
  assert.match(researchSubagentLaunchBlockReason({ action: "resume", id: "run-1" }, contexts), /cancel_research_run/);
  assert.equal(researchSubagentLaunchBlockReason({
    agent: "worker",
    task: "regular coding delegation",
  }, [{ cancelled: true, pending: new Map() }]), "");
});

test("management results keep the package text and do not open a failed roster row", () => {
  const result = {
    content: [{ type: "text", text: "Executable agents:\n- scout" }],
    details: { mode: "management", results: [] },
    input: { action: "list" },
  };
  const wrapped = projectSubagentToolResult(result, { workspace: "/work" });
  assert.equal(wrapped.details.mode, "management");
  assert.equal(wrapped.details.yield, undefined);
  assert.equal(wrapped.content[0].text, "Executable agents:\n- scout");
  assert.deepEqual(projectSubagentRosterEnd([], wrapped, { toolCallId: "call-list" }), []);
});

test("an async receipt stays running and is not rewritten as a failed yield", () => {
  const started = projectSubagentRosterStart({
    agent: "scout",
    task: "map the module",
  }, { toolCallId: "call-async" });
  const result = {
    content: [{
      type: "text",
      text: "Async: scout [run-1]\n\nThe async run is detached and running in the background.",
    }],
    details: {
      mode: "single",
      runId: "run-1",
      asyncDir: "/tmp/milksu-run",
    },
  };
  assert.equal(isAsyncSubagentReceipt(result)?.runId, "run-1");
  const running = projectSubagentRosterEnd(started, result, { toolCallId: "call-async" });
  assert.equal(running[0].status, "running");
  assert.equal(running[0].asyncDir, "/tmp/milksu-run");
  const wrapped = projectSubagentToolResult(result, { workspace: "/work" });
  assert.equal(wrapped.details.asyncDir, "/tmp/milksu-run");
  assert.equal(wrapped.details.yield, undefined);
});

test("normalize falls back to session workspace then dot when Pi omits location", () => {
  const withWorkspace = normalizeSubagentYield({
    content: [{ type: "text", text: "scouted the module" }],
    details: {
      results: [{
        agent: "scout",
        text: "mapped the tree",
      }],
    },
  }, { workspace: "/work" });
  assert.equal(withWorkspace.cwd, ".");
  assert.deepEqual(withWorkspace.files, []);
  assert.deepEqual(withWorkspace.findings, []);
  assert.ok(Number.isSafeInteger(withWorkspace.exitCode));

  const emptyContext = normalizeSubagentYield({
    content: [{ type: "text", text: "scouted the module" }],
  }, {});
  assert.equal(emptyContext.cwd, ".");
});

test("tool_result hook only wraps subagent results", async () => {
  const listeners = new Map();
  const asyncSecret = "opaque-turn-provider-secret";
  const extension = createSubagentYieldExtension({
    workspace: "/work",
    secrets: [asyncSecret],
  });
  extension({
    on(type, handler) {
      listeners.set(type, handler);
    },
  });
  const handler = listeners.get("tool_result");
  assert.equal(await handler({ toolName: "bash", content: [{ type: "text", text: "ok" }] }), undefined);
  const wrapped = await handler({
    toolName: "subagent",
    content: [{ type: "text", text: "done" }],
    details: {
      results: [{
        agent: "worker",
        exitCode: 0,
        files: ["a.ts"],
        findings: [],
        cwd: ".",
      }],
    },
    input: { agent: "worker" },
  });
  assert.equal(readSubagentYieldField(wrapped, "files[0]"), "a.ts");

  const unstructured = await handler({
    toolName: "subagent",
    content: [{ type: "text", text: "scouted the module" }],
    details: {
      results: [{
        agent: "scout",
        text: "looked at src/",
      }],
    },
  });
  assert.ok(unstructured);
  assert.equal(unstructured.details.schema, "milksu-subagent-yield/v1");
  assert.equal(unstructured.details.yield.cwd, ".");
  assert.deepEqual(unstructured.details.yield.files, []);
  assert.equal(String(unstructured.content[0].text).includes("requires cwd"), false);
  assert.equal(String(unstructured.content[0].text).includes("worktreeId"), false);

  const asyncWrapped = await handler({
    toolName: "subagent",
    content: [{
      type: "text",
      text: `Async: scout [async-1] ${asyncSecret}\nThe async run is detached and running in the background.`,
    }],
    details: {
      mode: "single",
      runId: "async-1",
      asyncDir: ".milksu/async-1",
      providerKey: asyncSecret,
    },
  });
  assert.doesNotMatch(JSON.stringify(asyncWrapped), /opaque-turn-provider-secret/);
  assert.equal(asyncWrapped.details.asyncDir, ".milksu/async-1");
  assert.equal(asyncWrapped.details.yield, undefined);

  const emptyContextListeners = new Map();
  createSubagentYieldExtension({})({
    on(type, handler) {
      emptyContextListeners.set(type, handler);
    },
  });
  const emptyHandler = emptyContextListeners.get("tool_result");
  const emptyWrapped = await emptyHandler({
    toolName: "subagent",
    content: [{ type: "text", text: "scouted" }],
    details: { results: [{ text: "no location" }] },
  });
  assert.ok(emptyWrapped);
  assert.equal(emptyWrapped.details.yield.cwd, ".");
  assert.equal(emptyWrapped.details.yield.status, "failed");
});

test("formatSubagentToolInput stays compact", () => {
  assert.equal(formatSubagentToolInput({ agent: "scout", task: "look" }), "scout");
  assert.equal(formatSubagentToolInput({
    agent: "worker",
    cwd: "/work/writer-1",
    task: "edit",
  }, {
    worktrees: [{ id: "writer-1", path: "/work/writer-1" }],
  }), "worker · writer-1");
});

test("field lines stay stable for a fake provider", () => {
  const lines = formatSubagentYieldLines(validYield());
  assert.equal(lines.split("\n")[0], "files[0]=a.ts");
});

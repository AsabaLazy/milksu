import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { applyRequestBudgetToRuntime } from "./bridge-request-budget-stream.js";

/** 假 SSE 服务器：可控制「首字节延迟」与「首字节后断流」。 */
function startFakeServer({ headersDelayMs = 0, stallAfterFirstMs = 0 } = {}) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const respond = () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        const finish = () => {
          res.write("data: [DONE]\n\n");
          res.end();
        };
        if (stallAfterFirstMs > 0) setTimeout(finish, stallAfterFirstMs);
        else finish();
      };
      if (headersDelayMs > 0) setTimeout(respond, headersDelayMs);
      else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** 模拟 pi-ai 的 provider.streamSimple：真发 HTTP，失败时发 error 事件。 */
function fakeRuntime(port, payloadBytes) {
  return {
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      void (async () => {
        const output = { role: "assistant", provider: model.provider, model: model.id, errorMessage: undefined };
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "x".repeat(payloadBytes),
            signal: options?.signal,
          });
          stream.push({ type: "start", partial: output });
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            output.text = String(value?.length ?? 0);
            stream.push({ type: "text_delta", delta: output.text, partial: output });
          }
          stream.push({ type: "done", reason: "stop", message: output });
          stream.end();
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
          stream.end();
        }
      })();
      return stream;
    },
  };
}

async function drain(runtime, payloadBytes) {
  const events = [];
  for await (const event of runtime.streamSimple(
    { provider: "milksu-account", id: "deepseek/deepseek-flash" },
    { systemPrompt: "", messages: [], tools: [] },
    {},
  )) events.push(event);
  return events;
}

test("a small request with a slow first byte is killed by the first-byte budget", async () => {
  const { server, port } = await startFakeServer({ headersDelayMs: 1500 });
  try {
    const runtime = fakeRuntime(port, 64 * 1024);
    assert.equal(applyRequestBudgetToRuntime(runtime, {
      thresholds: { ttfbBaseMs: 300, ttfbPerMbMs: 0, ttfbMaxMs: 5000, stallMs: 2000 },
      estimateBytes: () => 64 * 1024,
    }), true);
    const events = await drain(runtime);
    const error = events.at(-1);
    assert.equal(error.type, "error");
    assert.equal(error.error.stopReason, "error");
    assert.match(error.error.errorMessage, /before the first byte/);
    assert.match(error.error.errorMessage, /timed out/);
  } finally {
    server.close();
  }
});

test("a 4MB request with the same 1.5s first byte is allowed through", async () => {
  const { server, port } = await startFakeServer({ headersDelayMs: 1500 });
  try {
    const runtime = fakeRuntime(port, 4 * 1024 * 1024);
    applyRequestBudgetToRuntime(runtime, {
      // 4MB ⇒ 300ms + 4 × 600ms = 2.7s 预算，1.5s 首字节在预算内。
      thresholds: { ttfbBaseMs: 300, ttfbPerMbMs: 600, ttfbMaxMs: 10_000, stallMs: 2000 },
      estimateBytes: () => 4 * 1024 * 1024,
    });
    const events = await drain(runtime, 4 * 1024 * 1024);
    assert.equal(events.some(event => event.type === "error"), false);
    assert.equal(events.at(-1).type, "done");
  } finally {
    server.close();
  }
});

test("a stream that goes silent after the first byte is killed by stall detection", async () => {
  const { server, port } = await startFakeServer({ stallAfterFirstMs: 1500 });
  try {
    const runtime = fakeRuntime(port, 64 * 1024);
    applyRequestBudgetToRuntime(runtime, {
      thresholds: { ttfbBaseMs: 2000, ttfbPerMbMs: 0, ttfbMaxMs: 5000, stallMs: 300 },
      estimateBytes: () => 64 * 1024,
    });
    const events = await drain(runtime);
    const error = events.at(-1);
    assert.equal(error.type, "error");
    assert.match(error.error.errorMessage, /stalled/);
    assert.match(error.error.errorMessage, /after the first byte/);
  } finally {
    server.close();
  }
});

test("a normal stream is not falsely killed", async () => {
  const { server, port } = await startFakeServer({});
  try {
    const runtime = fakeRuntime(port, 64 * 1024);
    applyRequestBudgetToRuntime(runtime, {});
    const events = await drain(runtime);
    assert.equal(events.some(event => event.type === "error"), false);
    assert.equal(events.at(-1).type, "done");
  } finally {
    server.close();
  }
});

test("patching is idempotent and not applied twice", async () => {
  const { server, port } = await startFakeServer({});
  try {
    const runtime = fakeRuntime(port, 1024);
    assert.equal(applyRequestBudgetToRuntime(runtime, {}), true);
    const patched = runtime.streamSimple;
    assert.equal(applyRequestBudgetToRuntime(runtime, {}), true);
    assert.equal(runtime.streamSimple, patched);
  } finally {
    server.close();
  }
});

test("a runtime without streamSimple is left alone", () => {
  assert.equal(applyRequestBudgetToRuntime({}, {}), false);
  assert.equal(applyRequestBudgetToRuntime(null, {}), false);
});

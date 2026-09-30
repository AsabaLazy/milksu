import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_REQUEST_BUDGET } from "./bridge-request-budget.js";
import { connectTimeoutMs, installRequestHttpDispatcher } from "./bridge-http-dispatcher.js";

test("the connect timeout matches the first-byte budget ceiling", () => {
  assert.equal(connectTimeoutMs({}), DEFAULT_REQUEST_BUDGET.ttfbMaxMs);
  assert.equal(connectTimeoutMs({ MILKSU_PI_REQUEST_TTFB_MAX_MS: "45000" }), 45_000);
});

test("installing uses a MilkSU-owned agent with the raised connect timeout", () => {
  const seen = [];
  const result = installRequestHttpDispatcher({
    environment: {},
    createAgent: options => {
      seen.push(options);
      return { kind: "agent", options };
    },
    setDispatcher: agent => {
      seen.push({ kind: "set", agent });
    },
  });

  assert.equal(result.installed, true);
  assert.equal(result.connectTimeoutMs, DEFAULT_REQUEST_BUDGET.ttfbMaxMs);
  assert.deepEqual(seen[0], { connect: { timeout: DEFAULT_REQUEST_BUDGET.ttfbMaxMs } });
  assert.equal(seen[1].kind, "set");
  assert.equal(seen[1].agent, result.agent);
});

test("a dispatcher that cannot be installed does not stop the sidecar", () => {
  const failure = new Error("undici unavailable");
  let reported = null;
  const result = installRequestHttpDispatcher({
    createAgent: () => {
      throw failure;
    },
    setDispatcher: () => {},
    onError: error => {
      reported = error;
    },
  });
  assert.equal(result.installed, false);
  assert.equal(result.error, failure);
  assert.equal(reported, failure);
});

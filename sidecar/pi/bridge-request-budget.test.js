import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REQUEST_BUDGET,
  RequestBudgetError,
  createRequestBudgetGuard,
  estimateRequestBytes,
  requestBudgetThresholds,
  resolveRequestBudget,
} from "./bridge-request-budget.js";

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    api: {
      setTimeout: (callback, ms) => {
        const id = nextId++;
        pending.set(id, { callback, ms });
        return id;
      },
      clearTimeout: id => {
        pending.delete(id);
      },
    },
    pending,
    /** Fire the single armed timer, newest first (stall timer replaces the ttfb one). */
    fire(ms) {
      for (const [id, timer] of [...pending].reverse()) {
        if (ms === undefined || timer.ms === ms) {
          pending.delete(id);
          timer.callback();
          return true;
        }
      }
      return false;
    },
    delays() {
      return [...pending.values()].map(timer => timer.ms);
    },
  };
}

test("defaults give a 10s base that grows 2.5s per MB and caps at 120s", () => {
  const small = resolveRequestBudget({ payloadBytes: 0 });
  assert.equal(small.ttfbMs, 10_000);
  assert.equal(small.stallMs, 30_000);

  const fourMb = resolveRequestBudget({ payloadBytes: 4 * 1024 * 1024 });
  assert.equal(fourMb.ttfbMs, 20_000);

  // 4MB ≈ 8.3s of real first-byte latency must fit comfortably inside the budget.
  assert.ok(fourMb.ttfbMs > 8_300);

  const huge = resolveRequestBudget({ payloadBytes: 512 * 1024 * 1024 });
  assert.equal(huge.ttfbMs, DEFAULT_REQUEST_BUDGET.ttfbMaxMs);
});

test("thresholds are env-overridable and bad values fall back to defaults", () => {
  const overridden = requestBudgetThresholds({
    MILKSU_PI_REQUEST_TTFB_BASE_MS: "1000",
    MILKSU_PI_REQUEST_TTFB_PER_MB_MS: "500",
    MILKSU_PI_REQUEST_TTFB_MAX_MS: "5000",
    MILKSU_PI_REQUEST_STALL_MS: "700",
  });
  assert.deepEqual(overridden, {
    ttfbBaseMs: 1000,
    ttfbPerMbMs: 500,
    ttfbMaxMs: 5000,
    stallMs: 700,
  });

  const broken = requestBudgetThresholds({
    MILKSU_PI_REQUEST_TTFB_BASE_MS: "-5",
    MILKSU_PI_REQUEST_STALL_MS: "not-a-number",
  });
  assert.equal(broken.ttfbBaseMs, DEFAULT_REQUEST_BUDGET.ttfbBaseMs);
  assert.equal(broken.stallMs, DEFAULT_REQUEST_BUDGET.stallMs);
});

test("estimateRequestBytes tracks the serialized size without building it", () => {
  const value = { systemPrompt: "a".repeat(1000), messages: [{ role: "user", content: "b".repeat(2000) }] };
  const estimate = estimateRequestBytes(value);
  const actual = Buffer.byteLength(JSON.stringify(value));
  assert.ok(estimate >= actual * 0.9 && estimate <= actual * 1.2, `estimate ${estimate} vs actual ${actual}`);
});

test("the ttfb alarm fires before the first byte and aborts with a readable budget error", () => {
  const timers = fakeTimers();
  const guard = createRequestBudgetGuard({ payloadBytes: 4 * 1024 * 1024, timerApi: timers.api });

  assert.deepEqual(timers.delays(), [20_000]);
  assert.equal(guard.stage, "ttfb");
  assert.equal(guard.signal.aborted, false);

  assert.equal(timers.fire(20_000), true);
  assert.equal(guard.signal.aborted, true);
  const error = guard.timeoutError();
  assert.ok(error instanceof RequestBudgetError);
  assert.equal(error.kind, "ttfb");
  assert.equal(error.budgetMs, 20_000);
  assert.match(error.message, /before the first byte/);
  assert.match(error.message, /timed out/);
  guard.stop();
  assert.deepEqual(timers.delays(), []);
});

test("the first byte switches to stall detection, and each event resets it", () => {
  const timers = fakeTimers();
  const guard = createRequestBudgetGuard({ payloadBytes: 0, timerApi: timers.api });
  assert.deepEqual(timers.delays(), [10_000]);

  guard.note();
  assert.equal(guard.stage, "stream");
  // The ttfb alarm is gone, replaced by the stall alarm.
  assert.deepEqual(timers.delays(), [30_000]);

  guard.note();
  guard.note();
  assert.deepEqual(timers.delays(), [30_000]);

  assert.equal(timers.fire(30_000), true);
  const error = guard.timeoutError();
  assert.equal(error?.kind, "stall");
  assert.match(error.message, /stalled/);
  guard.stop();
  assert.deepEqual(timers.delays(), []);
});

test("a stream that never starts is a ttfb death, not a stall death", () => {
  const timers = fakeTimers();
  const guard = createRequestBudgetGuard({ payloadBytes: 0, timerApi: timers.api });
  guard.note();
  // Only the stall timer survives; firing it must not claim a ttfb death.
  assert.equal(timers.fire(10_000), false);
  assert.equal(timers.fire(30_000), true);
  assert.equal(guard.timeoutError()?.kind, "stall");
  guard.stop();
});

test("the caller's own abort stays the caller's abort, not a budget death", () => {
  const timers = fakeTimers();
  const parent = new AbortController();
  const guard = createRequestBudgetGuard({ payloadBytes: 0, parentSignal: parent.signal, timerApi: timers.api });
  parent.abort(new Error("user stopped the turn"));
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.timeoutError(), null);
  guard.stop();
});

test("stop clears both alarms even after a stage switch", () => {
  const timers = fakeTimers();
  const guard = createRequestBudgetGuard({ payloadBytes: 0, timerApi: timers.api });
  guard.note();
  guard.note();
  guard.stop();
  assert.deepEqual(timers.delays(), []);
  assert.equal(timers.fire(), false);
});

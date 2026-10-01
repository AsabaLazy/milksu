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
    /** Fire the oldest armed timer (the soft warn alarm precedes the hard kill alarm). */
    fire(ms) {
      for (const [id, timer] of pending) {
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

/** 小数字阈值，避免单测真的等几分钟。 */
const TEST_THRESHOLDS = Object.freeze({
  ttfbBaseMs: 1000,
  ttfbPerMbMs: 0,
  ttfbMaxMs: 5000,
  stallMs: 700,
  killGraceMs: 2000,
  killMaxMs: 60_000,
});

// 组合口径（#212 数值 + #213 机制）：base 20s、每 MB 10s、软预算封顶 300s。
// killMaxMs ≥ ttfbMaxMs + killGraceMs 是组合约束：封顶区间（≥28MB）的宽限不许归零。
test("defaults give a 20s base that grows 10s per MB and caps at 300s", () => {
  const small = resolveRequestBudget({ payloadBytes: 0 });
  assert.equal(small.ttfbMs, 20_000);
  assert.equal(small.stallMs, 30_000);
  // 硬掐 = 软阈值 + 宽限，且不超过绝对上限。
  assert.equal(small.ttfbKillMs, 140_000);
  assert.equal(small.stallKillMs, 150_000);

  const fourMb = resolveRequestBudget({ payloadBytes: 4 * 1024 * 1024 });
  assert.equal(fourMb.ttfbMs, 60_000);
  assert.equal(fourMb.ttfbKillMs, 180_000);

  // 2026-10-01 教训（#212）：DeepSeek 上 2.78MB 请求首字节超过 16.9s 才回来。
  const slowDay = resolveRequestBudget({ payloadBytes: 2.78 * 1024 * 1024 });
  assert.equal(slowDay.ttfbMs, 47_800);
  assert.ok(slowDay.ttfbMs > 16_900);

  const huge = resolveRequestBudget({ payloadBytes: 512 * 1024 * 1024 });
  assert.equal(huge.ttfbMs, DEFAULT_REQUEST_BUDGET.ttfbMaxMs);
  assert.equal(huge.ttfbKillMs, DEFAULT_REQUEST_BUDGET.ttfbMaxMs + DEFAULT_REQUEST_BUDGET.killGraceMs);
  // 封顶区间也不许零宽限：硬掐必须晚于软告警。
  assert.ok(huge.ttfbKillMs > huge.ttfbMs, `kill ${huge.ttfbKillMs}ms must come after the soft warning ${huge.ttfbMs}ms`);

  // 软阈值 + 宽限越过绝对上限时，以上限为准（默认 480s）。
  const capped = resolveRequestBudget({
    payloadBytes: 0,
    thresholds: {
      ttfbBaseMs: 400_000, ttfbPerMbMs: 0, ttfbMaxMs: 400_000, stallMs: 30_000,
      killGraceMs: 120_000, killMaxMs: DEFAULT_REQUEST_BUDGET.killMaxMs,
    },
  });
  assert.equal(capped.ttfbKillMs, DEFAULT_REQUEST_BUDGET.killMaxMs);
});

test("thresholds are env-overridable and bad values fall back to defaults", () => {
  const overridden = requestBudgetThresholds({
    MILKSU_PI_REQUEST_TTFB_BASE_MS: "1000",
    MILKSU_PI_REQUEST_TTFB_PER_MB_MS: "500",
    MILKSU_PI_REQUEST_TTFB_MAX_MS: "5000",
    MILKSU_PI_REQUEST_STALL_MS: "700",
    MILKSU_PI_REQUEST_KILL_GRACE_MS: "2000",
    MILKSU_PI_REQUEST_KILL_MAX_MS: "60000",
  });
  assert.deepEqual(overridden, {
    ttfbBaseMs: 1000,
    ttfbPerMbMs: 500,
    ttfbMaxMs: 5000,
    stallMs: 700,
    killGraceMs: 2000,
    killMaxMs: 60000,
  });

  const broken = requestBudgetThresholds({
    MILKSU_PI_REQUEST_TTFB_BASE_MS: "-5",
    MILKSU_PI_REQUEST_STALL_MS: "not-a-number",
    MILKSU_PI_REQUEST_KILL_GRACE_MS: "0",
  });
  assert.equal(broken.ttfbBaseMs, DEFAULT_REQUEST_BUDGET.ttfbBaseMs);
  assert.equal(broken.stallMs, DEFAULT_REQUEST_BUDGET.stallMs);
  assert.equal(broken.killGraceMs, DEFAULT_REQUEST_BUDGET.killGraceMs);
});

test("a partial threshold object falls back to the defaults for the kill fields", () => {
  // 老调用点只覆盖软阈值；硬掐字段不能因此变成 NaN。
  const budget = resolveRequestBudget({
    payloadBytes: 0,
    thresholds: { ttfbBaseMs: 1000, ttfbPerMbMs: 0, ttfbMaxMs: 5000, stallMs: 700 },
  });
  assert.equal(budget.ttfbMs, 1000);
  assert.equal(budget.ttfbKillMs, 1000 + DEFAULT_REQUEST_BUDGET.killGraceMs);
});

test("estimateRequestBytes tracks the serialized size without building it", () => {
  const value = { systemPrompt: "a".repeat(1000), messages: [{ role: "user", content: "b".repeat(2000) }] };
  const estimate = estimateRequestBytes(value);
  const actual = Buffer.byteLength(JSON.stringify(value));
  assert.ok(estimate >= actual * 0.9 && estimate <= actual * 1.2, `estimate ${estimate} vs actual ${actual}`);
});

test("the first-byte budget only warns; the hard kill is a later, separate alarm", () => {
  const timers = fakeTimers();
  const warnings = [];
  const guard = createRequestBudgetGuard({
    payloadBytes: 0,
    thresholds: TEST_THRESHOLDS,
    timerApi: timers.api,
    onWarn: warning => warnings.push(warning),
  });

  // 只有软告警一个闹钟，还没有硬掐。
  assert.deepEqual(timers.delays(), [1000]);
  assert.equal(guard.stage, "ttfb");
  assert.equal(guard.signal.aborted, false);

  // 软阈值到点：发告警、不 abort，接着武装 2s 宽限的硬掐。
  assert.equal(timers.fire(1000), true);
  assert.equal(guard.signal.aborted, false);
  assert.equal(guard.timeoutError(), null);
  assert.equal(guard.warned, true);
  assert.deepEqual(warnings, [{ stage: "ttfb", kind: "ttfb", budgetMs: 1000, payloadBytes: 0 }]);
  assert.deepEqual(timers.delays(), [2000]);

  // 宽限到点才判死。
  assert.equal(timers.fire(2000), true);
  assert.equal(guard.signal.aborted, true);
  const error = guard.timeoutError();
  assert.ok(error instanceof RequestBudgetError);
  assert.equal(error.kind, "ttfb");
  assert.equal(error.budgetMs, 1000);
  assert.equal(error.waitedMs, 3000);
  assert.match(error.message, /before the first byte/);
  assert.match(error.message, /timed out/);
  guard.stop();
  assert.deepEqual(timers.delays(), []);
});

test("a warning followed by the first byte cancels the pending hard kill", () => {
  const timers = fakeTimers();
  const guard = createRequestBudgetGuard({
    payloadBytes: 0,
    thresholds: TEST_THRESHOLDS,
    timerApi: timers.api,
  });

  timers.fire(1000);
  assert.deepEqual(timers.delays(), [2000]);

  // 首字节来了：这次请求活着，硬掐作废，改用断流软阈值。
  guard.note();
  assert.equal(guard.stage, "stream");
  assert.equal(guard.warned, false);
  assert.deepEqual(timers.delays(), [700]);
  assert.equal(timers.fire(2000), false);
  guard.stop();
});

test("the stream phase warns on the stall budget and kills only after the grace", () => {
  const timers = fakeTimers();
  const warnings = [];
  const guard = createRequestBudgetGuard({
    payloadBytes: 0,
    thresholds: TEST_THRESHOLDS,
    timerApi: timers.api,
    onWarn: warning => warnings.push(warning),
  });

  guard.note();
  assert.deepEqual(timers.delays(), [700]);
  guard.note();
  guard.note();
  assert.deepEqual(timers.delays(), [700]);

  assert.equal(timers.fire(700), true);
  assert.equal(guard.signal.aborted, false);
  assert.deepEqual(warnings, [{ stage: "stream", kind: "stall", budgetMs: 700, payloadBytes: 0 }]);
  assert.deepEqual(timers.delays(), [2000]);

  assert.equal(timers.fire(2000), true);
  const error = guard.timeoutError();
  assert.equal(error?.kind, "stall");
  assert.equal(error.waitedMs, 2700);
  assert.match(error.message, /stalled/);
  guard.stop();
  assert.deepEqual(timers.delays(), []);
});

test("a stalled stream that never resumes dies with a stall error, not a ttfb error", () => {
  const timers = fakeTimers();
  const guard = createRequestBudgetGuard({
    payloadBytes: 0,
    thresholds: TEST_THRESHOLDS,
    timerApi: timers.api,
  });
  guard.note();
  // 断流软阈值先到：只告警。宽限里没有新事件，硬掐才判死，且必须报 stall。
  assert.equal(timers.fire(700), true);
  assert.equal(guard.signal.aborted, false);
  assert.equal(timers.fire(2000), true);
  assert.equal(guard.timeoutError()?.kind, "stall");
  guard.stop();
});

test("the caller's own abort stays the caller's abort, not a budget death", () => {
  const timers = fakeTimers();
  const parent = new AbortController();
  const guard = createRequestBudgetGuard({
    payloadBytes: 0,
    parentSignal: parent.signal,
    thresholds: TEST_THRESHOLDS,
    timerApi: timers.api,
  });
  parent.abort(new Error("user stopped the turn"));
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.timeoutError(), null);
  guard.stop();
});

test("stop clears the warn and kill alarms even after a stage switch and a warning", () => {
  const timers = fakeTimers();
  const guard = createRequestBudgetGuard({
    payloadBytes: 0,
    thresholds: TEST_THRESHOLDS,
    timerApi: timers.api,
  });
  guard.note();
  timers.fire(700);
  guard.note();
  guard.stop();
  assert.deepEqual(timers.delays(), []);
  assert.equal(timers.fire(), false);
});

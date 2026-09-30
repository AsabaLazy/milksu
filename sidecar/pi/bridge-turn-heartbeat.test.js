import assert from "node:assert/strict";
import test from "node:test";
import { TURN_HEARTBEAT_MS, startTurnHeartbeat, withTurnHeartbeat } from "./bridge-turn-heartbeat.js";

test("a live turn keeps emitting heartbeats until it is stopped", () => {
  const events = [];
  let tick = null;
  let cleared = null;
  const stop = startTurnHeartbeat({
    emit: (conversationId, type) => events.push([conversationId, type]),
    conversationId: "conversation-1",
    intervalMs: 42,
    setIntervalImpl: (callback, interval) => {
      tick = { callback, interval };
      return "timer-1";
    },
    clearIntervalImpl: timer => {
      cleared = timer;
    },
  });

  assert.equal(tick.interval, 42);
  tick.callback();
  tick.callback();
  assert.deepEqual(events, [
    ["conversation-1", "turn.heartbeat"],
    ["conversation-1", "turn.heartbeat"],
  ]);

  stop();
  assert.equal(cleared, "timer-1");
});

test("the default heartbeat is slow enough not to be a stream event", () => {
  assert.equal(TURN_HEARTBEAT_MS, 5000);
  const timers = [];
  const stop = startTurnHeartbeat({
    emit: () => {},
    conversationId: "conversation-2",
    setIntervalImpl: (callback, interval) => {
      timers.push({ callback, interval });
      return 1;
    },
    clearIntervalImpl: () => {},
  });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].interval, TURN_HEARTBEAT_MS);
  stop();
});

test("withTurnHeartbeat keeps the heartbeat armed for the whole run and stops it after it resolves", async () => {
  const events = [];
  let tick = null;
  let cleared = null;
  const result = await withTurnHeartbeat({
    emit: (conversationId, type) => events.push([conversationId, type]),
    conversationId: "conversation-1",
    intervalMs: 42,
    setIntervalImpl: (callback, interval) => {
      tick = { callback, interval };
      return "timer-1";
    },
    clearIntervalImpl: timer => { cleared = timer; },
  }, async () => {
    // The run is still in flight, so the heartbeat must already be armed.
    assert.ok(tick, "heartbeat must be armed before the run starts");
    assert.equal(tick.interval, 42);
    tick.callback();
    return "done";
  });

  assert.equal(result, "done");
  assert.deepEqual(events, [["conversation-1", "turn.heartbeat"]]);
  assert.equal(cleared, "timer-1");
});

test("withTurnHeartbeat stops the heartbeat and rethrows when the run fails", async () => {
  let cleared = null;
  await assert.rejects(
    withTurnHeartbeat({
      emit: () => {},
      conversationId: "conversation-2",
      intervalMs: 42,
      setIntervalImpl: () => "timer-2",
      clearIntervalImpl: timer => { cleared = timer; },
    }, async () => {
      throw new Error("model connection died");
    }),
    /model connection died/,
  );
  // A prompt that rejects must not leave a heartbeat behind for ever.
  assert.equal(cleared, "timer-2");
});

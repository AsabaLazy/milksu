export const TURN_HEARTBEAT_MS = 5_000;

/**
 * A turn that is alive keeps saying so. The UI used to infer "the engine is not responding"
 * from silence alone, which turned a long tool or a slow model call into a false alarm: the
 * heartbeat is the engine-side signal that separates "busy" from "gone".
 *
 * The interval is unref'd so it never holds the sidecar process open on its own.
 */
export function startTurnHeartbeat({
  emit,
  conversationId,
  intervalMs = TURN_HEARTBEAT_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const timer = setIntervalImpl(() => {
    emit(conversationId, "turn.heartbeat");
  }, intervalMs);
  timer?.unref?.();
  return () => clearIntervalImpl(timer);
}

/**
 * Run one turn's work with the heartbeat wrapped around it.
 *
 * This is the seam the bridge uses, and it is deliberately separate from the timer so the
 * lifecycle is testable: the heartbeat must start before the model work and stop whenever
 * that work settles — on resolve **and** on reject. A merge once dropped the call site in
 * bridge.js entirely, so no heartbeat was ever emitted and the renderer could not tell a
 * busy engine from a dead one; keeping the decision here means a regression fails a unit
 * test instead of silently going quiet again.
 */
export async function withTurnHeartbeat({
  emit,
  conversationId,
  intervalMs = TURN_HEARTBEAT_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}, run) {
  const stop = startTurnHeartbeat({
    emit,
    conversationId,
    intervalMs,
    setIntervalImpl,
    clearIntervalImpl,
  });
  try {
    return await run();
  } finally {
    stop();
  }
}

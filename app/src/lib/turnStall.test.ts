import { describe, expect, it } from 'vitest'
import {
  TURN_STALL_DEFAULTS,
  decideTurnStall,
  resolveTurnStallConfig,
} from '@/lib/turnStall'

describe('turnStall thresholds', () => {
  it('defaults to a conservative budget and keeps the two death modes apart', () => {
    expect(TURN_STALL_DEFAULTS.quietMs).toBe(18_000)
    expect(TURN_STALL_DEFAULTS.heartbeatGraceMs).toBe(15_000)
    // engine-gone is detected faster: no heartbeat is a hard signal.
    expect(TURN_STALL_DEFAULTS.engineGoneMs).toBe(45_000)
    // model-stalled waits longer: the process is alive, only the request is quiet.
    expect(TURN_STALL_DEFAULTS.modelStallMs).toBe(120_000)
    expect(TURN_STALL_DEFAULTS.modelStallMs).toBeGreaterThan(TURN_STALL_DEFAULTS.engineGoneMs)
  })

  it('lets a machine override every threshold but falls back on nonsense', () => {
    const config = resolveTurnStallConfig({
      VITE_MILKSU_TURN_QUIET_MS: '5000',
      VITE_MILKSU_HEARTBEAT_GRACE_MS: '7000',
      VITE_MILKSU_ENGINE_GONE_MS: '0',
      VITE_MILKSU_MODEL_STALL_MS: 'not-a-number',
    })
    expect(config.quietMs).toBe(5000)
    expect(config.heartbeatGraceMs).toBe(7000)
    expect(config.engineGoneMs).toBe(TURN_STALL_DEFAULTS.engineGoneMs)
    expect(config.modelStallMs).toBe(TURN_STALL_DEFAULTS.modelStallMs)
  })
})

describe('decideTurnStall', () => {
  const base = {
    running: true,
    toolRunning: false,
    queuedBehind: false,
    engineAlive: false,
    quietMs: 0,
    hasEvent: true,
  }

  it('never reports a stall before there has been any engine event', () => {
    expect(decideTurnStall({ ...base, hasEvent: false, quietMs: 999_999 })).toBe('')
  })

  it('never reports a stall when the conversation is not running', () => {
    expect(decideTurnStall({ ...base, running: false, quietMs: 999_999 })).toBe('')
  })

  it('stays quiet while the quiet clock is under the quiet threshold', () => {
    expect(decideTurnStall({ ...base, quietMs: 17_000 })).toBe('')
  })

  it('declares engine-gone once the heartbeat has stopped past the fast budget', () => {
    expect(decideTurnStall({ ...base, engineAlive: false, quietMs: 44_000 })).toBe('')
    expect(decideTurnStall({ ...base, engineAlive: false, quietMs: 45_000 })).toBe('engine-gone')
  })

  it('declares model-stalled when the heartbeat is alive but the request is silent for long', () => {
    // A live process past the quiet point is still just "waiting", not stalled.
    expect(decideTurnStall({ ...base, engineAlive: true, quietMs: 60_000 })).toBe('')
    expect(decideTurnStall({ ...base, engineAlive: true, quietMs: 119_000 })).toBe('')
    expect(decideTurnStall({ ...base, engineAlive: true, quietMs: 120_000 })).toBe('model-stalled')
  })

  it('never reports a running tool as stalled, however long it runs', () => {
    expect(decideTurnStall({ ...base, toolRunning: true, quietMs: 3_600_000 })).toBe('')
    // Even with the heartbeat gone: the tool is the thing we are waiting on.
    expect(decideTurnStall({ ...base, toolRunning: true, engineAlive: true, quietMs: 3_600_000 })).toBe('')
  })

  it('never reports a queued conversation as stalled', () => {
    expect(decideTurnStall({ ...base, queuedBehind: true, quietMs: 3_600_000 })).toBe('')
  })
})

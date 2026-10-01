import { describe, expect, it } from 'vitest'
import {
  ENGINE_RESTART_DEFAULTS,
  decideEngineRestart,
  resolveEngineRestartConfig,
} from '@/lib/engineRestart'

describe('engineRestart thresholds', () => {
  it('defaults to a 15s abort-response grace and lets a machine override it', () => {
    expect(ENGINE_RESTART_DEFAULTS.abortResponseGraceMs).toBe(15_000)
    expect(resolveEngineRestartConfig({ VITE_MILKSU_ABORT_RESPONSE_GRACE_MS: '3000' }).abortResponseGraceMs)
      .toBe(3000)
    expect(resolveEngineRestartConfig({ VITE_MILKSU_ABORT_RESPONSE_GRACE_MS: '0' }).abortResponseGraceMs)
      .toBe(ENGINE_RESTART_DEFAULTS.abortResponseGraceMs)
    expect(resolveEngineRestartConfig({ VITE_MILKSU_ABORT_RESPONSE_GRACE_MS: 'nope' }).abortResponseGraceMs)
      .toBe(ENGINE_RESTART_DEFAULTS.abortResponseGraceMs)
  })
})

describe('decideEngineRestart', () => {
  const NOW = 1_000_000

  it('offers a restart whenever the heartbeat is gone', () => {
    expect(decideEngineRestart({
      running: true,
      stallKind: 'engine-gone',
      abortSentAt: 0,
      lastEventAt: 0,
      now: NOW,
    })).toBe(true)
  })

  it('never offers a restart for a conversation that is not running', () => {
    expect(decideEngineRestart({
      running: false,
      stallKind: 'engine-gone',
      abortSentAt: 0,
      lastEventAt: 0,
      now: NOW,
    })).toBe(false)
  })

  it('offers a restart only after an abort has gone unanswered past the grace', () => {
    const base = {
      running: true,
      stallKind: 'model-stalled' as const,
      abortSentAt: NOW - 15_000,
      lastEventAt: NOW - 60_000,
      now: NOW,
    }
    // 还没到宽限：不给入口。
    expect(decideEngineRestart({ ...base, abortSentAt: NOW - 14_000 })).toBe(false)
    // 到点且期间没有任何事件：abort 没人接。
    expect(decideEngineRestart(base)).toBe(true)
  })

  it('does not offer a restart when the process answered the abort with progress', () => {
    expect(decideEngineRestart({
      running: true,
      stallKind: 'model-stalled',
      abortSentAt: NOW - 60_000,
      // abort 之后来过真实事件 ⇒ 进程在动，不是不响应。
      lastEventAt: NOW - 10_000,
      now: NOW,
    })).toBe(false)
  })

  it('never offers a restart without a stall, and never without a prior abort', () => {
    expect(decideEngineRestart({
      running: true,
      stallKind: '',
      abortSentAt: NOW - 60_000,
      lastEventAt: 0,
      now: NOW,
    })).toBe(false)
    expect(decideEngineRestart({
      running: true,
      stallKind: 'model-stalled',
      abortSentAt: 0,
      lastEventAt: 0,
      now: NOW,
    })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import { decideTaskNotify, type TaskNotifySwitch } from './taskNotifyTrigger'

const allOn: TaskNotifySwitch = { needsInput: true, failed: true, completed: true, stalled: true }

describe('decideTaskNotify', () => {
  it('三类各自触发', () => {
    expect(decideTaskNotify({ needsDecision: true, enabled: allOn })).toEqual({ notify: true, kind: 'needs-input', reason: 'ok' })
    expect(decideTaskNotify({ turn: 'failed', enabled: allOn })).toEqual({ notify: true, kind: 'failed', reason: 'ok' })
    expect(decideTaskNotify({ turn: 'completed', enabled: allOn })).toEqual({ notify: true, kind: 'completed', reason: 'ok' })
  })

  it('第四类 stalled（模型疑似挂死）单列，有自己的开关，不复用 needs_input', () => {
    expect(decideTaskNotify({ stalled: true, enabled: allOn })).toEqual({ notify: true, kind: 'stalled', reason: 'ok' })
    // 自己的开关关掉 ⇒ disabled（不发）
    expect(decideTaskNotify({ stalled: true, enabled: { ...allOn, stalled: false } })).toEqual({ notify: false, kind: 'stalled', reason: 'disabled' })
    // 两类目的不同 ⇒ 开关互不影响：needsInput 关不影响 stalled，stalled 关不影响 needs-input
    expect(decideTaskNotify({ stalled: true, enabled: { ...allOn, needsInput: false } }).kind).toBe('stalled')
    expect(decideTaskNotify({ needsDecision: true, enabled: { ...allOn, stalled: false } }).kind).toBe('needs-input')
  })

  it('优先级：stalled（系统告警） > needs-input > failed > completed', () => {
    // 同时成立时取更急的
    expect(decideTaskNotify({ stalled: true, needsDecision: true, turn: 'failed', enabled: allOn }).kind).toBe('stalled')
    expect(decideTaskNotify({ needsDecision: true, turn: 'completed', enabled: allOn }).kind).toBe('needs-input')
    expect(decideTaskNotify({ needsDecision: true, turn: 'failed', enabled: allOn }).kind).toBe('needs-input')
  })

  it('开关逐项关掉 ⇒ disabled', () => {
    expect(decideTaskNotify({ needsDecision: true, enabled: { ...allOn, needsInput: false } })).toEqual({ notify: false, kind: 'needs-input', reason: 'disabled' })
    expect(decideTaskNotify({ turn: 'failed', enabled: { ...allOn, failed: false } }).reason).toBe('disabled')
    expect(decideTaskNotify({ turn: 'completed', enabled: { ...allOn, completed: false } }).reason).toBe('disabled')
    expect(decideTaskNotify({ stalled: true, enabled: { ...allOn, stalled: false } }).reason).toBe('disabled')
  })

  it('无信号 ⇒ no-signal', () => {
    expect(decideTaskNotify({ enabled: allOn })).toEqual({ notify: false, reason: 'no-signal' })
    expect(decideTaskNotify({ needsDecision: false, enabled: allOn }).reason).toBe('no-signal')
  })

  // 读者 2026-09-28 拍板：不做“强制停轮”这一类（通知功能要独立于受限文件夹）⇒ stopped 不再是终态。
  // （原来这里有 stopped 视同 failed 的用例，随功能一起删。）
  it('未支持的终态（如 stopped）不触发通知', () => {
    expect(decideTaskNotify({ turn: 'stopped' as never, enabled: allOn })).toEqual({ notify: false, reason: 'unknown-turn' })
  })

  it('未知/非法 turn ⇒ unknown-turn（不崩）', () => {
    expect(decideTaskNotify({ turn: 'nope' as never, enabled: allOn })).toEqual({ notify: false, reason: 'unknown-turn' })
    expect(decideTaskNotify({ turn: '' as never, enabled: allOn }).reason).toBe('unknown-turn')
    expect(decideTaskNotify({} as never).reason).toBe('no-signal')
  })
})

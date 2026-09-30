import { describe, expect, it } from 'vitest'

import { taskNotifyAllOn, taskNotifySettingsAll, taskNotifyDraftFromSettings, taskNotifySettingsPatch } from './taskNotifySettingsDraft'

describe('taskNotifyDraftFromSettings（缺字段 ⇒ 默认全关，零打扰）', () => {
  it('没有任何设置 ⇒ 五类全关', () => {
    const expected = { needsInput: false, failed: false, completed: false, stalled: false, sound: false }
    expect(taskNotifyDraftFromSettings(null)).toEqual(expected)
    expect(taskNotifyDraftFromSettings(undefined)).toEqual(expected)
    expect(taskNotifyDraftFromSettings({})).toEqual(expected)
    expect(taskNotifyDraftFromSettings({ task_notify: {} })).toEqual(expected)
  })

  it('部分字段缺失 ⇒ 缺的用默认，有的照实', () => {
    expect(taskNotifyDraftFromSettings({ task_notify: { needs_input: true } })).toEqual({
      needsInput: true, failed: false, completed: false, stalled: false, sound: false,
    })
  })

  it('非法值（字符串/数字）⇒ 回落默认，不抛', () => {
    const draft = taskNotifyDraftFromSettings({ task_notify: { needs_input: 'no' as never, failed: 0 as never } })
    expect(draft).toEqual({ needsInput: false, failed: false, completed: false, stalled: false, sound: false })
  })

  it('显式 true 的 completed / stalled 会被读到（不是永远默认关）', () => {
    expect(taskNotifyDraftFromSettings({ task_notify: { completed: true } }).completed).toBe(true)
    expect(taskNotifyDraftFromSettings({ task_notify: { stalled: true } }).stalled).toBe(true)
  })
})

describe('taskNotifySettingsPatch（勾选 ⇒ 写入形状）', () => {
  it('只改被点的那一个，其余保持', () => {
    const current = { needsInput: true, failed: false, completed: false, stalled: false, sound: false }
    expect(taskNotifySettingsPatch(current, 'completed', true)).toEqual({
      needs_input: true, failed: false, completed: true, stalled: false, sound: false,
    })
  })

  it('四种类型开关都能单独改（stalled 单独改不动别的）', () => {
    const current = { needsInput: true, failed: true, completed: false, stalled: false, sound: false }
    const patch = taskNotifySettingsPatch(current, 'stalled', true)
    expect(patch.stalled).toBe(true)
    expect(patch.needs_input).toBe(true)
    expect(patch.failed).toBe(true)
    expect(patch.completed).toBe(false)
  })

  it('写出的键名与 Go 一致（needs_input / failed / completed / stalled / sound）', () => {
    const patch = taskNotifySettingsPatch({ needsInput: true, failed: true, completed: false, stalled: false, sound: false }, 'failed', false)
    expect(Object.keys(patch).sort()).toEqual(['completed', 'failed', 'needs_input', 'sound', 'stalled'])
    expect(patch.failed).toBe(false)
  })

  it('值做布尔化（组件 Switch 传进来的真值 / 假值都收）', () => {
    const current = { needsInput: true, failed: true, completed: false, stalled: false, sound: false }
    expect(taskNotifySettingsPatch(current, 'needsInput', 0).needs_input).toBe(false)
    expect(taskNotifySettingsPatch(current, 'needsInput', 'yes').needs_input).toBe(true)
  })
})

describe('总开关（收纳语义：含 stalled 这一类）', () => {
  it('任一类子项（含 stalled）开着 ⇒ 总开关算开', () => {
    expect(taskNotifyAllOn({ needsInput: true, failed: false, completed: false, stalled: false, sound: false })).toBe(true)
    expect(taskNotifyAllOn({ needsInput: false, failed: false, completed: true, stalled: false, sound: false })).toBe(true)
    // stalled 是任务状况通知的一种 ⇒ 单独开着也算总开关开，口径与其它三类一致
    expect(taskNotifyAllOn({ needsInput: false, failed: false, completed: false, stalled: true, sound: false })).toBe(true)
    // sound 是修饰项，不参与总开关
    expect(taskNotifyAllOn({ needsInput: false, failed: false, completed: false, stalled: false, sound: true })).toBe(false)
  })

  it('拨总开关：四类子项（含 stalled）一起变，提示音的值保持不动', () => {
    const current = { needsInput: true, failed: false, completed: false, stalled: true, sound: true }
    expect(taskNotifySettingsAll(current, false)).toEqual({
      needs_input: false, failed: false, completed: false, stalled: false, sound: true,
    })
    expect(taskNotifySettingsAll(current, true)).toEqual({
      needs_input: true, failed: true, completed: true, stalled: true, sound: true,
    })
  })
})

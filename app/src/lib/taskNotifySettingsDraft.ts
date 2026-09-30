/**
 * 设置页"任务通知"开关的**纯映射**（读草稿 ⇄ 写补丁）。
 *
 * 刻意不 import 渲染层的 taskNotifyBridge（避免循环依赖 ✓）、也不 import 组件：
 * 只吃一个结构化对象、吐一个结构化对象 ⇒ 可在 node 里单测 ✓。
 * 字段名/JSON 名照 Go 侧 AppSettings.task_notify：needs_input / failed / completed / stalled / sound ✓（不许改名 ✗）。
 * 缺字段/非法值 ⇒ 回落默认 **开/开/关/关/静默** ✓（与 Go 的 TaskNotifyPreferences 默认一致 ✓）。
 * stalled（模型疑似挂死）默认 **false（关）**：新通知类型默认不打扰，想收的人自己去设置里打开 ✓。
 * sound 默认 **false（静默）**：提示音是强提醒，读者反馈太吵 ⇒ 想响的人自己打开 ✓。
 */

export interface TaskNotifyStored {
  needs_input?: boolean
  failed?: boolean
  completed?: boolean
  stalled?: boolean
  sound?: boolean
}

export interface TaskNotifyDraft {
  needsInput: boolean
  failed: boolean
  completed: boolean
  stalled: boolean
  sound: boolean
}

export type TaskNotifyKey = 'needsInput' | 'failed' | 'completed' | 'stalled' | 'sound'

const DEFAULTS: TaskNotifyDraft = { needsInput: false, failed: false, completed: false, stalled: false, sound: false }

/** 缺字段/非法 ⇒ 默认全关（零打扰，不抛）。 */
export function taskNotifyDraftFromSettings(
  settings?: { task_notify?: TaskNotifyStored | null } | null,
): TaskNotifyDraft {
  const stored = settings?.task_notify
  if (!stored || typeof stored !== 'object') return { ...DEFAULTS }
  const pick = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
  return {
    needsInput: pick(stored.needs_input, DEFAULTS.needsInput),
    failed: pick(stored.failed, DEFAULTS.failed),
    completed: pick(stored.completed, DEFAULTS.completed),
    stalled: pick(stored.stalled, DEFAULTS.stalled),
    sound: pick(stored.sound, DEFAULTS.sound),
  }
}

/**
 * 只改被点的那一个，其余保持当前草稿值（不是整体覆盖 ✗）。
 * 返回值就是可以写回 `working.task_notify` 的形状（JSON 名 ✓）。
 */
/**
 * 总开关「任务状况通知」是否开着：**任一子项开着就算开着**。
 * 这样"旧配置里只把跑完关了"也能正确显示为开，不会让 UI 与真实行为不一致 ✓。
 * stalled（模型疑似挂死）也算一类子项：它是任务状况通知的一种，收纳语义必须一致。
 */
export function taskNotifyAllOn(draft: TaskNotifyDraft): boolean {
  return draft.needsInput || draft.failed || draft.completed || draft.stalled
}

/**
 * 拨总开关：**四类子项**（待拍板/失败/跑完/停滞）一次性设成同一个值。
 * sound 不跟着动 —— 总开关关掉时提示音只是"不可选"，不改变用户选过的值 ✓。
 */
export function taskNotifySettingsAll(current: TaskNotifyDraft, value: unknown): TaskNotifyStored {
  const on = Boolean(value)
  return { needs_input: on, failed: on, completed: on, stalled: on, sound: current.sound }
}

export function taskNotifySettingsPatch(current: TaskNotifyDraft, key: TaskNotifyKey, value: unknown): TaskNotifyStored {
  const next: TaskNotifyDraft = { ...current, [key]: Boolean(value) }
  return { needs_input: next.needsInput, failed: next.failed, completed: next.completed, stalled: next.stalled, sound: next.sound }
}

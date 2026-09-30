/**
 * 该不该弹"任务完成通知" —— 纯决策（批次 2 最小一片）。
 *
 * 只做输入→输出，不 import React/DOM、不调 window.milksu、不发通知：
 * 真正弹窗由外壳侧（desktop/main.cjs 的 NotifyTask 分支）负责。
 *
 * 优先级：stalled（系统告警：模型疑似挂死） > needs-input（等你拍板，最急）> failed > completed。
 * （“强制停轮”这一类按读者要求**不做** ⇒ 不再有 stopped 分支。）
 * 文案不在这里拼：外壳侧已有中英前缀，本模块只给出 kind，中英由调用方决定。
 *
 * 注意 stalled 与 needs-input 是**两种目的不同的提醒**，不能互相替代：
 *   needs-input  = “有事等你拍板”（审批卡 / ask）；
 *   stalled      = “系统告警：模型疑似挂死，需要你重试或停止”（看门狗在停滞边沿触发）。
 * 因此 stalled 单列一类、单配开关，不复用 needs_input。
 */

export type TaskNotifyKind = 'stalled' | 'needs-input' | 'failed' | 'completed'

export type TaskNotifyReason = 'disabled' | 'no-signal' | 'unknown-turn' | 'ok'

export interface TaskNotifySwitch {
  needsInput: boolean
  failed: boolean
  completed: boolean
  /** 模型疑似挂死（停滞看门狗）：**默认 false**。缺省/未给 ⇒ 视为关。 */
  stalled?: boolean
  /** 是否播放提示音（默认 false=静默）。与 Go 的 task_notify.sound 一一对应。 */
  sound?: boolean
}

export interface TaskNotifyInput {
  turn?: 'completed' | 'failed'
  needsDecision?: boolean
  /** 停滞看门狗在**进入停滞的边沿**显式点名这一类（不走 needsDecision）。 */
  stalled?: boolean
  enabled: TaskNotifySwitch
}

export interface TaskNotifyDecision {
  notify: boolean
  kind?: TaskNotifyKind
  reason: TaskNotifyReason
}

const KNOWN_TURNS = new Set(['completed', 'failed'])

function switchFor(kind: TaskNotifyKind, enabled: TaskNotifySwitch): boolean {
  if (kind === 'stalled') return enabled?.stalled === true
  if (kind === 'needs-input') return enabled?.needsInput === true
  if (kind === 'failed') return enabled?.failed === true
  return enabled?.completed === true
}

export function decideTaskNotify(input: TaskNotifyInput): TaskNotifyDecision {
  const turn = input?.turn
  if (turn !== undefined && !KNOWN_TURNS.has(String(turn))) {
    return { notify: false, reason: 'unknown-turn' }
  }
  const needsDecision = input?.needsDecision === true
  const stalled = input?.stalled === true
  const failedSignal = turn === 'failed'
  const completedSignal = turn === 'completed'
  // 顺序就是优先级：先最急的，再次急的。停滞是系统告警，排在最前。
  let kind: TaskNotifyKind | undefined
  if (stalled) kind = 'stalled'
  else if (needsDecision) kind = 'needs-input'
  else if (failedSignal) kind = 'failed'
  else if (completedSignal) kind = 'completed'
  if (!kind) return { notify: false, reason: 'no-signal' }
  if (!switchFor(kind, input?.enabled)) return { notify: false, kind, reason: 'disabled' }
  return { notify: true, kind, reason: 'ok' }
}

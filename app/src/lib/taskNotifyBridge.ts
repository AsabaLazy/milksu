/**
 * 把「会话状态 ⇒ 通知决策 ⇒ 调外壳 NotifyTask」串起来（批次 2 · 接线片）。
 *
 * 分工：
 *  - 判定"该不该发、发哪一类"由 app/src/lib/taskNotifyTrigger.ts 的纯函数 decideTaskNotify 负责 ✓
 *  - "在等读者拍板吗"复用既有入口 conversationNeedsDecision（app/src/lib/needsDecision.ts:25 ✓），
 *    这里**不复制一份判断逻辑** ✗
 *  - 真正调 window.milksu 的那一步做成**注入的依赖**（invokeMessage ✓）⇒ 本模块可在 node 里单测 ✓，
 *    纯函数里**不碰 window** ✗
 *
 * 去重不在这里做 ✗：外壳侧（desktop/main.cjs 的 NotifyTask 分支）已有 Set 去重 ✓。
 */

import { conversationNeedsDecision } from '@/lib/needsDecision'
import { t } from '@/lib/uiLocale'
import {
  decideTaskNotify,
  type TaskNotifyDecision,
  type TaskNotifyInput,
  type TaskNotifyKind,
  type TaskNotifySwitch,
} from '@/lib/taskNotifyTrigger'

type DecisionMessage = {
  approvalState?: string
  approvalRequestId?: string
  toolName?: string
}

export interface TaskNotifyConversation {
  id: string
  title?: string
  messages?: DecisionMessage[]
}

/**
 * 设置读不到时的默认开关：**全关（零打扰）**（与 Go 侧 TaskNotifyPreferences 默认值一致）。
 * 抽出来是为了可测，也避免把默认值散在调用点。
 */
export function defaultTaskNotifySwitch(): TaskNotifySwitch {
  return { needsInput: false, failed: false, completed: false, stalled: false, sound: false }
}

/**
 * 把落盘的设置映射成开关（纯函数）。
 * 缺失/非法 ⇒ 回默认 全关（与 Go 侧 TaskNotifyPreferences 一一对应）。
 * 单独抽出来是因为 App.tsx 的 ref 镜像需要一个可测的映射，而不是又一串字面量。
 */
export function taskNotifySwitchFromSettings(
  settings?: { task_notify?: { needs_input?: boolean; failed?: boolean; completed?: boolean; stalled?: boolean; sound?: boolean } } | null,
): TaskNotifySwitch {
  const stored = settings?.task_notify
  if (!stored) return defaultTaskNotifySwitch()
  const pick = (value: boolean | undefined, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback
  return {
    needsInput: pick(stored.needs_input, false),
    failed: pick(stored.failed, false),
    completed: pick(stored.completed, false),
    // 模型疑似挂死：**默认关**。缺字段/旧配置 ⇒ 关（新通知类型默认不打扰）。
    stalled: pick(stored.stalled, false),
    // 提示音默认关（静默）：读者反馈系统提示音太打扰 ⇒ 想响的人自己去设置里打开。
    sound: pick(stored.sound, false),
  }
}

export interface TaskNotifySnapshot {
  /** 回合终态：completed / failed。 */
  turn?: TaskNotifyInput['turn']
  /** 后台任务终态：只传**失败**（成功/被取消在规划层就拦下了，不会到这里）。 */
  backgroundTask?: TaskNotifyInput['backgroundTask']
  conversation: TaskNotifyConversation
  enabled: TaskNotifySwitch
  /**
   * 显式声明"这是需要用户拍板"（如审批卡 / ask 没有对应消息时）。
   * 审批卡那条走的是 `conversationNeedsDecision(messages)`（消息里有 pending 审批）。
   */
  needsDecision?: boolean
  /**
   * 显式声明"进入停滞态了"（系统告警：模型疑似挂死）。
   * 与 needsDecision **分开**：停滞不是等你拍板，而是“模型可能挂了，可重试或停止”。
   * 它有自己的开关（task_notify.stalled），不走 needs_input。
   */
  stalled?: boolean
/**
 * 终态事件（运行失败 / 被拦停）：**不要**用"等你拍板"盖过它自己的类型。
 * 理由：这几类发生时对话里可能恰好有张未处理的审批卡，而优先级会把 kind 改写成
 * needs-input ⇒ 明明在报"失败"，弹出来的却是"等你拍板" ✗。
 */
  terminalEvent?: boolean
}

export interface TaskNotifyPlan {
  decision: TaskNotifyDecision
  conversationId: string
  conversationTitle: string
}

/**
 * 纯规划：把会话快照 + 开关 ⇒ 决策 + 定位信息。不调任何外部 API ✓。
 * `needsDecision` 从会话消息里**复用** conversationNeedsDecision 得出 ✓。
 */
export function planTaskNotify(snapshot: TaskNotifySnapshot): TaskNotifyPlan {
  const conversation = snapshot?.conversation
  const decision = decideTaskNotify({
    turn: snapshot?.turn,
    backgroundTask: snapshot?.backgroundTask,
    needsDecision: snapshot?.terminalEvent === true
      ? false
      : snapshot?.needsDecision === true || conversationNeedsDecision(conversation?.messages),
    // 终态事件（失败/被拦停）不能被停滞告警盖成 stalled（同 needsDecision 的道理）。
    stalled: snapshot?.terminalEvent === true ? false : snapshot?.stalled === true,
    enabled: snapshot?.enabled,
  })
  return {
    decision,
    conversationId: String(conversation?.id ?? ''),
    conversationTitle: String(conversation?.title ?? ''),
  }
}

export interface TaskNotifyDeps {
  /** 注入：通常是 (method, args) => window.milksu.invoke(method, args)。 */
  invoke: (method: string, args: Record<string, unknown>) => unknown
  /** 一句话摘要（中英由调用方决定 ✓）。缺省时不带该字段。 */
  summary?: string
  silent?: boolean
  /**
   * 本次事件的标识（会话 + 类型 + 标识 ⇒ 外壳的去重键）。
   * 必须与渲染层自己去重键里用的那个值**同源**（例如同一个 `at`），
   * 否则同一事件的重复投递会被当成两次不同事件而重复弹窗 ✗。
   */
  turnKey?: string | number
}

/**
 * 内部 kind ⇒ 外壳线格式（**契约对齐点**）。
 *
 * 真机实测到的 bug：内部决策模块给出的是 `needs-input`，而外壳
 * （desktop/task-notify.cjs 的 TASK_NOTIFY_KINDS）只认
 * `completed / failed / needs-decision` ⇒ `needs-input` 被判 invalid 直接丢弃
 * ⇒ 审批卡通知永远不弹（监听实测：kind=needs-input）。
 * 这里做一次性翻译，并在测试里钉住“发出去的 kind 必须在外壳的白名单里”。
 */
export function wireKindFor(kind: TaskNotifyKind | undefined): 'completed' | 'failed' | 'needs-decision' | 'stalled' | undefined {
  if (kind === 'stalled') return 'stalled'
  if (kind === 'needs-input') return 'needs-decision'
  if (kind === 'failed') return 'failed'
  if (kind === 'completed') return 'completed'
  return undefined
}

/** 外壳允许的 kind（与 desktop/task-notify.cjs 的 TASK_NOTIFY_KINDS 一致）。 */
export const SHELL_NOTIFY_KINDS = Object.freeze(['completed', 'failed', 'needs-decision', 'stalled'] as const)

/**
 * 缺省摘要（调用方没给 summary 时用）。
 *
 * 真机实测：审批卡那条没传摘要 ⇒ 外壳回落到 `prefix.en` ⇒ 中文界面里弹出英文
 * “Needs your decision” ✗。所以这里给每一类都配好读者语言的默认值，并保证
 * 摘要**总是存在**（外壳的英文兜底从此不会被走到）。
 */
export function defaultNotifySummary(kind: 'completed' | 'failed' | 'needs-decision' | 'stalled'): string {
  if (kind === 'stalled') return t('模型疑似挂死', 'Model appears stalled')
  if (kind === 'needs-decision') return t('需要你的决定', 'Needs your decision')
  if (kind === 'failed') return t('任务被异常终止', 'Task terminated unexpectedly')
  return t('任务已完成', 'Task finished')
}

/**
 * 停滞通知的正文（纯函数 ✓）：写清**停滞类型 + 时长 + 用户可以做什么**。
 * 只陈述事实，不替用户下指令（"可回到会话选择重试或停止"是给出口，不是命令）。
 * 时长四舍五入到分钟、至少 1 分钟——看门狗最早也要静默 45s 以上才判停滞，说"0 分钟"没意义。
 * 两种停滞措辞不同：`engine-gone` 是进程心跳没了，`model-stalled` 是请求静默。
 */
export function turnStallNotifySummary(kind: 'engine-gone' | 'model-stalled', quietMs: number): string {
  const minutes = Math.max(1, Math.round((Number(quietMs) || 0) / 60_000))
  const duration = t(`${minutes} 分钟`, `${minutes} min`)
  if (kind === 'engine-gone') {
    return t(
      `引擎进程疑似挂死，已 ${duration} 无响应，可回到会话选择重试或停止`,
      `The engine appears stalled after ${duration} with no response. You can go back to the conversation to retry or stop`,
    )
  }
  return t(
    `模型请求疑似挂死，已 ${duration} 无响应，可回到会话选择重试或停止`,
    `The model request appears stalled after ${duration} with no response. You can go back to the conversation to retry or stop`,
  )
}

/**
 * 规划 + 该发就发一次。返回决策，便于调用方记日志/断言。
 */
export function notifyTaskIfNeeded(snapshot: TaskNotifySnapshot, deps: TaskNotifyDeps): TaskNotifyDecision {
  const plan = planTaskNotify(snapshot)
  if (!plan.decision.notify || !plan.decision.kind) return plan.decision
  const wireKind = wireKindFor(plan.decision.kind)
  if (!wireKind) return plan.decision
  const args: Record<string, unknown> = {
    kind: wireKind,
    conversationId: plan.conversationId,
    conversationTitle: plan.conversationTitle,
  }
  if (deps?.summary) args.summary = deps.summary
  // 摘要总是给（缺省用读者语言的默认值）⇒ 不让外壳走到英文兜底
  args.summary = String(deps?.summary ?? '').trim() || defaultNotifySummary(wireKind)
  // 提示音：默认**静默**（不带声音）。只有设置里明确打开 sound 才让系统响。
  // deps.silent 仍可覆盖（true=强制静默、false=强制有声），便于测试与将来复用。
  const wantsSound = typeof deps?.silent === 'boolean'
    ? deps.silent === false
    : snapshot?.enabled?.sound === true
  if (!wantsSound) args.silent = true
  const turnKey = String(deps?.turnKey ?? '').trim()
  if (turnKey) args.turnKey = turnKey
  deps?.invoke?.('NotifyTask', args)
  return plan.decision
}

export type BackgroundOutcomeKind = 'failed' | 'cancelled' | 'completed'

/**
 * 后台任务终态的通知规划（纯函数 ✓）。
 * - 终态那一刻传进来的任务列表**已经是空的** ⇒ **拿不到 taskId** ✗ ⇒ 去重键用
 *   `${conversationId}:${kind}:${at}` ✓（at 来自本次终态时刻 ⇒ 同一次终态重放不发 ✓，
 *   而"用户再跑一次又失败"是新的一次终态、新 at ⇒ **会再发** ✓）。
 * - `cancelled`（读者主动取消）**不发** ✗ —— 与主动停止一个口径：主动停不算失败。
 * - `completed`（正常跑完）**也不发** ✗ —— 读者口径（2026-09-27 真机验收时定）：
 *   后台任务成功不需要打扰（界面下方的任务条已经能看到情况），只有**失败**才值得弹。
 *   失败仍走 `failed` 开关（语义也对：失败就是失败）。
 */
export function planBackgroundTaskNotify(input: {
  conversationId: string
  outcome?: { kind: BackgroundOutcomeKind; at: number } | null
  seen?: { has(key: string): boolean }
}): { notify: boolean; key: string; backgroundTask?: 'failed' | 'completed' } {
  const outcome = input?.outcome
  if (!outcome) return { notify: false, key: '' }
  const kind = outcome.kind
  const key = `${String(input?.conversationId ?? '')}:${kind}:${Number(outcome.at) || 0}`
  if (input?.seen?.has(key)) return { notify: false, key }
  if (kind === 'cancelled') return { notify: false, key }
  if (kind === 'completed') return { notify: false, key }
  return { notify: true, key, backgroundTask: 'failed' }
}

/**
 * "只发一次"由**状态**保证（不靠时间戳 ✗）：终态形成时"在跑集合必须刚从非空变空"。
 * 第二次调用（重放，或将来上游让两条路径都算出非 null）读到的都已是清空集合 ⇒ hadRunning=false ⇒ 不发。
 */
export function shouldNotifySettledBackgroundTask(input: {
  settled?: { kind: BackgroundOutcomeKind; at: number } | null
  hadRunning: boolean
}): boolean {
  return Boolean(input?.settled) && input?.hadRunning === true
}

/** 会被通知的问题来源白名单 —— **只在这一处改**。
 *  要放开"守卫告警（受限路径被拦 / 思考重复）也弹" ⇒ 这里加上 `'guard-alert'` 一行即可。 */
export const NOTIFYING_PROBLEM_SOURCES = Object.freeze(['run-failure'] as const)

export type ProblemNotifySource = 'run-failure' | 'guard-alert'

/**
 * 失败类判据（纯函数 ✓）：这次 notice 与已存的同一份吗？
 * - 同一份 ⇒ 重复投递 ⇒ 不发；
 * - 不同一份 ⇒ 要么是守卫告警之后的真失败，要么是新一回失败 ⇒ 要发。
 * 抽出来是为了可测：调用方只需把"写之前读到的现有 problem"传进来。
 */
export function isAlreadySameProblem(input: {
  existing?: { notice?: string | null } | null
  notice?: string
}): boolean {
  if (!input?.existing) return false
  return String(input.existing?.notice ?? '') === String(input?.notice ?? '')
}

/** 失败类去重键（与外壳键的 `turnKey` 分量同源 ✓）。 */
export function problemNotifyKey(conversationId: string, at: number): string {
  return `${String(conversationId ?? '').trim()}:failed:${Number(at) || 0}`
}


/** 回合完成类去重键。 */
export function completedNotifyKey(conversationId: string, at: number): string {
  return `${String(conversationId ?? '').trim()}:completed:${Number(at) || 0}`
}

/**
 * 失败类通知规划（纯函数 ✓）。
 * - 判据是**状态跃迁**：`alreadySameProblem` 为真（同一份 notice 已在本轮标过）⇒ 不发；
 *   这样重复投递不发，而"守卫告警（不同 notice）之后的真失败"照发 ✓。
 * - `source` 必须在白名单里 ⇒ 守卫告警默认不发（改白名单即可放开 ✓）。
 */
export function planProblemNotify(input: {
  conversationId: string
  alreadySameProblem: boolean
  source: ProblemNotifySource
  at: number
  seen?: { has(key: string): boolean }
}): { notify: boolean; key: string } {
  const conversationId = String(input?.conversationId ?? '').trim()
  const key = problemNotifyKey(conversationId, Number(input?.at) || 0)
  if (!conversationId) return { notify: false, key }
  if (input?.alreadySameProblem === true) return { notify: false, key }
  if (!NOTIFYING_PROBLEM_SOURCES.includes(input?.source as 'run-failure')) return { notify: false, key }
  if (input?.seen?.has(key)) return { notify: false, key }
  return { notify: true, key }
}

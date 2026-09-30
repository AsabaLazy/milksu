import { describe, expect, it, vi } from 'vitest'

import { notifyTaskIfNeeded, planTaskNotify, turnStallNotifySummary } from './taskNotifyBridge'
import type { TaskNotifySwitch } from './taskNotifyTrigger'

const allOn: TaskNotifySwitch = { needsInput: true, failed: true, completed: true, stalled: true }
const pendingAsk = [{ toolName: 'milksu_ask', approvalRequestId: 'ask-1', approvalState: 'pending' }]
const answeredAsk = [{ toolName: 'milksu_ask', approvalRequestId: 'ask-1', approvalState: 'approved' }]
const conversation = { id: 'c1', title: '对话 A' }

describe('planTaskNotify', () => {
  it('会话里有未决审批/ask ⇒ needs-input（复用 conversationNeedsDecision，不另写一套）', () => {
    const plan = planTaskNotify({ conversation: { ...conversation, messages: pendingAsk }, enabled: allOn })
    expect(plan.decision).toEqual({ notify: true, kind: 'needs-input', reason: 'ok' })
    expect(plan.conversationId).toBe('c1')
    expect(plan.conversationTitle).toBe('对话 A')
  })

  it('已答复（approved）⇒ 不算待决策', () => {
    expect(planTaskNotify({ conversation: { ...conversation, messages: answeredAsk }, enabled: allOn }).decision.reason).toBe('no-signal')
  })

  it('回合终态透传 + 优先级：待决策压过 completed', () => {
    expect(planTaskNotify({ turn: 'completed', conversation, enabled: allOn }).decision.kind).toBe('completed')
    expect(planTaskNotify({ turn: 'completed', conversation: { ...conversation, messages: pendingAsk }, enabled: allOn }).decision.kind).toBe('needs-input')
  })

  it('开关关掉 ⇒ disabled（不调外壳）', () => {
    expect(planTaskNotify({ conversation: { ...conversation, messages: pendingAsk }, enabled: { ...allOn, needsInput: false } }).decision.reason).toBe('disabled')
  })

  it('显式 needsDecision（无审批消息的拍板类）：判成 needs-input', () => {
    const plan = planTaskNotify({ needsDecision: true, conversation, enabled: allOn })
    expect(plan.decision).toEqual({ notify: true, kind: 'needs-input', reason: 'ok' })
  })

  it('显式 needsDecision 也受 needsInput 开关管（关 ⇒ disabled，不调外壳）', () => {
    expect(planTaskNotify({ needsDecision: true, conversation, enabled: { ...allOn, needsInput: false } }).decision)
      .toEqual({ notify: false, kind: 'needs-input', reason: 'disabled' })
  })

  it('显式 stalled（停滞看门狗）：判成独立的第四类 stalled，不走 needs-input', () => {
    const plan = planTaskNotify({ stalled: true, conversation, enabled: allOn })
    expect(plan.decision).toEqual({ notify: true, kind: 'stalled', reason: 'ok' })
  })

  it('显式 stalled 受自己的 stalled 开关管（needsInput 关不影响；stalled 关 ⇒ disabled）', () => {
    expect(planTaskNotify({ stalled: true, conversation, enabled: { ...allOn, stalled: false } }).decision)
      .toEqual({ notify: false, kind: 'stalled', reason: 'disabled' })
    expect(planTaskNotify({ stalled: true, conversation, enabled: { ...allOn, needsInput: false } }).decision.kind)
      .toBe('stalled')
  })

  it('终态事件优先：stalled 也不能把 failed 盖成 stalled', () => {
    expect(planTaskNotify({ turn: 'failed', terminalEvent: true, stalled: true, conversation, enabled: allOn }).decision.kind)
      .toBe('failed')
  })

  it('终态事件优先：显式 needsDecision 也不能把 failed 盖成 needs-input', () => {
    expect(planTaskNotify({ turn: 'failed', terminalEvent: true, needsDecision: true, conversation, enabled: allOn }).decision.kind)
      .toBe('failed')
  })
})

describe('turnStallNotifySummary', () => {
  it('写清停滞类型与时长（至少 1 分钟），并给出可选的出口', () => {
    const modelStalled = turnStallNotifySummary('model-stalled', 130_000)
    expect(modelStalled).toContain('模型请求疑似挂死')
    expect(modelStalled).toContain('2 分钟')
    expect(modelStalled).toContain('可回到会话选择重试或停止')
    const engineGone = turnStallNotifySummary('engine-gone', 50_000)
    expect(engineGone).toContain('引擎进程疑似挂死')
    expect(engineGone).toContain('1 分钟')
    // 两类措辞必须不同：引擎进程没了 vs 请求静默，用户要能分清
    expect(engineGone).not.toBe(modelStalled)
    // 只陈述事实，不替用户下指令：不得出现命令式“需要你的决定”
    expect(modelStalled).not.toContain('需要你的决定')
    expect(engineGone).not.toContain('需要你的决定')
  })
})

describe('notifyTaskIfNeeded', () => {
  it('该发时用注入的 invoke 调 NotifyTask，并带上四件套', () => {
    const invoke = vi.fn()
    const decision = notifyTaskIfNeeded(
      { conversation: { ...conversation, messages: pendingAsk }, enabled: allOn },
      { invoke, summary: '等你拍板' },
    )
    expect(decision).toEqual({ notify: true, kind: 'needs-input', reason: 'ok' })
    expect(invoke).toHaveBeenCalledTimes(1)
    // 内部决策是 needs-input，但**发出去的线格式**必须是外壳认的 needs-decision ✗
    // （真机实测：直接发 needs-input 会被外壳判 invalid 丢弃 ⇒ 审批卡通知永远不弹）
    expect(invoke).toHaveBeenCalledWith('NotifyTask', {
      kind: 'needs-decision',
      conversationId: 'c1',
      conversationTitle: '对话 A',
      summary: '等你拍板',
      // 提示音默认关（静默）⇒ 默认就带 silent: true（读者反馈提示音太打扰）。
      silent: true,
    })
  })

  it('设置里打开提示音 ⇒ 不带 silent（系统才会响）', () => {
    const invoke = vi.fn()
    notifyTaskIfNeeded(
      { conversation: { ...conversation, messages: pendingAsk }, enabled: { ...allOn, sound: true } },
      { invoke, summary: '等你拍板' },
    )
    const args = invoke.mock.calls[0]?.[1] as Record<string, unknown>
    expect(args).not.toHaveProperty('silent')
  })

  it('不该发时不调外壳', () => {
    for (const snapshot of [
      { conversation, enabled: allOn },
      { conversation: { ...conversation, messages: pendingAsk }, enabled: { ...allOn, needsInput: false } },
    ]) {
      const invoke = vi.fn()
      notifyTaskIfNeeded(snapshot, { invoke })
      expect(invoke).not.toHaveBeenCalled()
    }
  })

  it('silent 只在显式 true 时带上', () => {
    const invoke = vi.fn()
    notifyTaskIfNeeded({ turn: 'completed', conversation, enabled: allOn }, { invoke, silent: false })
    expect(invoke.mock.calls[0][1]).not.toHaveProperty('silent')
  })
})

// 源码级守卫：确认调用点真的挂在"会话状态变化处"（审批卡到达时），且只挂这一处。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

describe('调用点守卫（源码级）', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../composables/useConversations.ts'),
    'utf8',
  )

  it('在 approval.requested 分支里调用一次 notifyTaskIfNeeded，且只调用一处', () => {
    expect(source).toMatch(/import \{[^}]*notifyTaskIfNeeded[^}]*\} from '@\/lib\/taskNotifyBridge'/)
    expect(source).toMatch(/if \(type === 'approval\.requested' && requestId\) \{/)
    expect(source).toMatch(/notifyTaskIfNeeded\(/)
    // 每类触发源各挂一处（调用点计数）：
    //   1) 审批卡到达（needs-input）
    //   2) 终态事件统一发送器 notifyTerminalTurn（失败类 + 完成类共用**同一条发送路径**）
    //   3) 停滞看门狗 notifyTurnStall（边沿发一次，kind = stalled）
    // 新增类别时这里要同步 +1，并由各自的守卫断言落在正确的分支里。
    // 共用发送器是故意的：不允许为某一类另开第二条发送路径（那会绕过去重与开关）。
    expect(source.match(/notifyTaskIfNeeded\(/g)?.length).toBe(3)
    // 不轮询：调用点必须落在 approval.requested 分支内（其后紧跟 approval.resolved 分支）
    // 从 approval 分支入口起算：调用必须在**该分支内**，且其后紧接 approval.resolved 分支（不轮询）。
    expect(source).toMatch(/if \(type === 'approval\.requested' && requestId\) \{[\s\S]{0,1200}?notifyTaskIfNeeded\([\s\S]{0,1200}?\} else if \(type === 'approval\.resolved' && requestId\) \{/)
  })
})

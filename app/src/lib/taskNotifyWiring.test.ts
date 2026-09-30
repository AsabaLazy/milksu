import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  SHELL_NOTIFY_KINDS,
  defaultNotifySummary,
  defaultTaskNotifySwitch,
  isAlreadySameProblem,
  notifyTaskIfNeeded,
  planProblemNotify,
  planTaskNotify,
  wireKindFor,
} from './taskNotifyBridge'
import { applyUiLocale } from './uiLocale'

const useConversationsSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../composables/useConversations.ts'),
  'utf8',
)
const typesSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../types.ts'),
  'utf8',
)

/**
 * 剥掉行注释后再做源码守卫匹配。
 * 真根因：守卫直接匹配原文时，把调用行**注掉**仍会命中 ⇒ 必须先剥行注释
 * 注释里仍含那段文字 ⇒ 正则照样命中 ⇒ 守卫变不了红 ✗（假守卫）。
 */
const stripLineComments = (text: string) =>
  text
    .split('\n')
    .map(line => {
      const at = line.indexOf('//')
      return at === -1 ? line : line.slice(0, at)
    })
    .join('\n')

const useConversationsCode = stripLineComments(useConversationsSource)

describe('通知文案必须两两不同（真机反馈：共用一句会误导）', () => {
  it('任务被异常终止 / 任务已完成 两句不重复', () => {
    const pick = (re: RegExp) => useConversationsCode.match(re)?.[1]?.trim() ?? ''
    const runFailed = pick(/summary: t\('([^']*任务被异常终止[^']*)'/) || pick(/summary: t\('([^']+)', 'Task terminated unexpectedly'\)/)
    const turnDone = pick(/summary: t\('([^']+)', 'Task finished'\)/)
    for (const [name, value] of Object.entries({ runFailed, turnDone })) {
      expect(value, `${name} 的文案应存在`).not.toBe('')
    }
    const all = [runFailed, turnDone]
    expect(new Set(all).size, `两句必须不同，实际: ${JSON.stringify(all)}`).toBe(2)
    // 用户 2026-09-28 拍板：回合完成就写“任务已完成”。
    expect(turnDone).toBe('任务已完成')
  })
})

describe('回合完成通知（新接）：默认关，只在干净跑完时发', () => {
  it('completed 开关默认关 ⇒ 不发（不打扰）；打开 ⇒ 发', () => {
    const conversation = { id: 'c1', title: 'A' }
    expect(planTaskNotify({ turn: 'completed', terminalEvent: true, conversation, enabled: defaultTaskNotifySwitch() }).decision)
      .toEqual({ notify: false, kind: 'completed', reason: 'disabled' })
    expect(planTaskNotify({ turn: 'completed', terminalEvent: true, conversation, enabled: { needsInput: true, failed: true, completed: true } }).decision)
      .toEqual({ notify: true, kind: 'completed', reason: 'ok' })
  })

  it('发出去的 kind = completed（在外壳白名单里）', () => {
    const seen: Array<Record<string, unknown>> = []
    notifyTaskIfNeeded(
      { turn: 'completed', terminalEvent: true, conversation: { id: 'c1', title: 'A' }, enabled: { needsInput: true, failed: true, completed: true } },
      { invoke: (_m, args) => seen.push(args), turnKey: 12345 },
    )
    expect(seen[0]?.kind).toBe('completed')
    expect(SHELL_NOTIFY_KINDS).toContain(seen[0]?.kind as string)
    expect(seen[0]?.turnKey).toBe('12345')
  })

  it('接线守卫：接在回合结算之后，且只在“本回合没有失败/中止标记”时发', () => {
    const start = useConversationsCode.indexOf("type === 'assistant.settled'")
    expect(start).toBeGreaterThan(-1)
    const block = useConversationsCode.slice(start, start + 2600)
    expect(block).toMatch(/finishRun\(sessionId\)[\s\S]{0,400}?notifyCompletedTurn\(settledConversationId\)/)
    expect(block).toMatch(/!turnNotCleanIds\.has\(settledConversationId\)/)
    expect(useConversationsCode.match(/notifyCompletedTurn\(/g)?.length).toBe(2) // 定义 + 调用各一处
  })
})

describe('摘要文案：跟随界面语言，且不会漏出外壳的英文兜底', () => {
  it('中文界面 ⇒ 四类默认摘要都是中文', () => {
    applyUiLocale('zh')
    expect(defaultNotifySummary('needs-decision')).toBe('需要你的决定')
    expect(defaultNotifySummary('failed')).toBe('任务被异常终止')
    expect(defaultNotifySummary('completed')).toBe('任务已完成')
    expect(defaultNotifySummary('stalled')).toBe('模型疑似挂死')
  })

  it('英文界面 ⇒ 跟随设置变英文（不是写死中文）', () => {
    applyUiLocale('en')
    try {
      expect(defaultNotifySummary('needs-decision')).toBe('Needs your decision')
      expect(defaultNotifySummary('stalled')).toBe('Model appears stalled')
    } finally {
      applyUiLocale('zh')
    }
  })

  it('调用方没给 summary ⇒ 发出去的参数也带摘要（真机上曾因缺它弹出英文 Needs your decision）', () => {
    applyUiLocale('zh')
    const seen: Array<Record<string, unknown>> = []
    notifyTaskIfNeeded(
      {
        conversation: {
          id: 'c1',
          title: 'A',
          messages: [{ toolName: 'milksu_ask', approvalRequestId: 'a', approvalState: 'pending' }],
        },
        enabled: { needsInput: true, failed: true, completed: true },
      },
      { invoke: (_m, args) => seen.push(args) },
    )
    expect(seen[0]?.summary).toBe('需要你的决定')
  })

  it('调用方给了 summary ⇒ 用调用方的（不被默认值覆盖）', () => {
    const seen: Array<Record<string, unknown>> = []
    notifyTaskIfNeeded(
      { turn: 'failed', terminalEvent: true, conversation: { id: 'c', title: 'A' }, enabled: { needsInput: true, failed: true, completed: true } },
      { invoke: (_m, args) => seen.push(args), summary: '自定义摘要' },
    )
    expect(seen[0]?.summary).toBe('自定义摘要')
  })
})

describe('发出去的 kind 必须在外壳白名单里（契约对齐；真机实测过这个 bug）', () => {
  it('内部 needs-input ⇒ 线格式 needs-decision（否则外壳判 invalid 直接丢弃）；stalled 单列', () => {
    expect(wireKindFor('needs-input')).toBe('needs-decision')
    expect(wireKindFor('failed')).toBe('failed')
    expect(wireKindFor('completed')).toBe('completed')
    expect(wireKindFor('stalled')).toBe('stalled')
    expect(wireKindFor(undefined)).toBeUndefined()
  })

  it('审批卡快照发出去的实际 kind 是外壳认的那种（不再是 needs-input）', () => {
    const seen: Array<Record<string, unknown>> = []
    notifyTaskIfNeeded(
      {
        conversation: {
          id: 'c1',
          title: 'A',
          messages: [{ toolName: 'milksu_ask', approvalRequestId: 'a', approvalState: 'pending' }],
        },
        enabled: { needsInput: true, failed: true, completed: true },
      },
      { invoke: (_m, args) => seen.push(args) },
    )
    expect(seen[0]?.kind).toBe('needs-decision')
    expect(SHELL_NOTIFY_KINDS).toContain(seen[0]?.kind as string)
  })

  it('终态事件发出去的 kind 也在白名单里', () => {
    for (const turn of ['failed', 'completed'] as const) {
      const seen: Array<Record<string, unknown>> = []
      notifyTaskIfNeeded(
        { turn, terminalEvent: true, conversation: { id: 'c', title: 'A' }, enabled: { needsInput: true, failed: true, completed: true } },
        { invoke: (_m, args) => seen.push(args) },
      )
      expect(SHELL_NOTIFY_KINDS).toContain(seen[0]?.kind as string)
    }
  })
})

describe('开关默认值（可测纯函数）', () => {
  it('默认全关（零打扰，与 Go 侧一致）', () => {
    expect(defaultTaskNotifySwitch()).toEqual({ needsInput: false, failed: false, completed: false, stalled: false, sound: false })
  })
})

describe('设置值 ⇒ enabled（读取函数现读）', () => {
  it('needsInput 关 ⇒ disabled', () => {
    const enabled = { ...defaultTaskNotifySwitch(), needsInput: false }
    const plan = planTaskNotify({
      conversation: { id: 'c1', title: 'A', messages: [{ toolName: 'milksu_ask', approvalRequestId: 'a', approvalState: 'pending' }] },
      enabled,
    })
    expect(plan.decision).toEqual({ notify: false, kind: 'needs-input', reason: 'disabled' })
  })

  it('completed 开着也不影响：触发源是审批卡 ⇒ 仍按 needs-input 优先', () => {
    const plan = planTaskNotify({
      conversation: { id: 'c1', title: 'A', messages: [{ toolName: 'milksu_ask', approvalRequestId: 'a', approvalState: 'pending' }] },
      enabled: { needsInput: true, failed: true, completed: true },
    })
    expect(plan.decision.kind).toBe('needs-input')
  })
})

describe('接线源码守卫（不写组件 class/文案断言）', () => {
  it('调用点现读设置（不用快照）+ 默认函数，且旧的硬编码已消失；来源可注入', () => {
    // 计数断言，不用 toMatch（只要存在就通过 ⇒ 注掉其中一处仍然绿 ✗ 假守卫）：
    //   三处都必须现读：① 审批卡到达 ② 终态事件统一发送器 notifyTerminalTurn
    //   ③ 停滞看门狗 notifyTurnStall
    expect(useConversationsCode.match(/enabled: taskNotifySource\?\.\(\) \?\? defaultTaskNotifySwitch\(\)/g)?.length).toBe(3)
    expect(useConversationsCode).not.toMatch(/needsInput: true, failed: false, completed: false/)
    expect(useConversationsCode).toMatch(/let taskNotifySource/)
    expect(useConversationsCode).toMatch(/setTaskNotifySource: \(source\?/)
  })

  it('前端 AppSettings 的 task_notify 字段名与 Go 侧 JSON 名一致', () => {
    expect(typesSource).toMatch(/task_notify\?: \{ needs_input\?: boolean; failed\?: boolean; completed\?: boolean; stalled\?: boolean; sound\?: boolean \}/)
  })
})

describe('失败类：判据必须能区分"同一份失败"与"告警之后的真失败"', () => {
  it('没有历史 problem ⇒ 不是同一份（要发）', () => {
    expect(isAlreadySameProblem({ existing: undefined, notice: 'run failed' })).toBe(false)
  })

  it('同一个 notice 再来一次（重复投递）⇒ 是同一份（不发）', () => {
    expect(isAlreadySameProblem({ existing: { notice: 'run failed' }, notice: 'run failed' })).toBe(true)
  })

  it('守卫告警在前（不同 notice）、随后真失败 ⇒ 不是同一份（必须发）', () => {
    expect(isAlreadySameProblem({ existing: { notice: '思考陷入重复' }, notice: 'run failed' })).toBe(false)
  })

  it('planProblemNotify：run-failure 且非同一份 ⇒ 发；同一份 ⇒ 不发', () => {
    expect(planProblemNotify({ conversationId: 'c', alreadySameProblem: false, source: 'run-failure', at: 1 }).notify).toBe(true)
    expect(planProblemNotify({ conversationId: 'c', alreadySameProblem: true, source: 'run-failure', at: 1 }).notify).toBe(false)
  })

  it('planProblemNotify：source 白名单只有 run-failure；守卫告警不发（要放开只改白名单一处）', () => {
    expect(planProblemNotify({ conversationId: 'c', alreadySameProblem: false, source: 'guard-alert', at: 1 }).notify).toBe(false)
  })

  it('planProblemNotify：空会话 id ⇒ 不发（markProblemTurn 的早退挡不住外面）', () => {
    expect(planProblemNotify({ conversationId: '   ', alreadySameProblem: false, source: 'run-failure', at: 1 }).notify).toBe(false)
  })

  it('planProblemNotify：已记过的 key ⇒ 不发（第二层）', () => {
    const key = planProblemNotify({ conversationId: 'c', alreadySameProblem: false, source: 'run-failure', at: 1 }).key
    expect(planProblemNotify({ conversationId: 'c', alreadySameProblem: false, source: 'run-failure', at: 1, seen: new Set([key]) }).notify).toBe(false)
  })
})

describe('事件标识（turnKey）与渲染层去重键同源', () => {
  it('传了 turnKey ⇒ 进 args；空/空白 ⇒ 不入 args', () => {
    const seen: Array<Record<string, unknown>> = []
    notifyTaskIfNeeded(
      { turn: 'failed', terminalEvent: true, conversation: { id: 'c', title: 'A' }, enabled: { needsInput: true, failed: true, completed: true } },
      { invoke: (_m, args) => seen.push(args), turnKey: 42 },
    )
    expect(seen[0]?.turnKey).toBe('42')
    notifyTaskIfNeeded(
      { turn: 'failed', terminalEvent: true, conversation: { id: 'c', title: 'A' }, enabled: { needsInput: true, failed: true, completed: true } },
      { invoke: (_m, args) => seen.push(args), turnKey: '   ' },
    )
    expect(seen[1] && 'turnKey' in seen[1]).toBe(false)
  })

  it('渲染层传的 turnKey 与自己去重键里的 at 同源（两类各看一处）', () => {
    // 失败：统一发送器用 input.at，而 input.at 就是各自 key 里的 at
    expect(useConversationsCode).toMatch(/turnKey: input\.at/)
    expect(useConversationsCode).toMatch(/key: plan\.key/) // 失败类：键与 at 同一次计算
  })
})

describe('触发源挂点守卫（每类各一处 + 位置正确）', () => {
  it('失败类：判据在写失败内容之前读，且在 engine.error 分支内', () => {
    const marker = 'const existingNotice = failedNoticeByConversation.get(problemId)'
    expect(useConversationsCode.indexOf(marker)).toBeGreaterThan(-1)
    // 读判据 → 写内容 → 发通知：顺序不能反（写之后再读就永远"同一份"了）
    expect(useConversationsCode.indexOf(marker)).toBeLessThan(useConversationsCode.indexOf('failedNoticeByConversation.set(problemId'))
    const callAt = useConversationsCode.indexOf('notifyRunFailure({ conversationId: problemId, alreadySameProblem })')
    expect(callAt).toBeGreaterThan(-1)
    expect(useConversationsCode.indexOf('failedNoticeByConversation.set(problemId')).toBeLessThan(callAt)
    // 这三行必须落在 engine.error 的 `if (!bubble.stopped) {` 块内（主动停下不算失败）
    const blockStart = useConversationsCode.indexOf('if (!bubble.stopped) {')
    expect(blockStart).toBeGreaterThan(-1)
    const block = useConversationsCode.slice(blockStart, blockStart + 900)
    expect(block).toMatch(/const alreadySameProblem = isAlreadySameProblem\(\{ existing: existingNotice \? \{ notice: existingNotice \} : undefined, notice: bubble\.content \}\)/)
    expect(block).toMatch(/notifyRunFailure\(\{ conversationId: problemId, alreadySameProblem \}\)/)
    expect(useConversationsCode.match(/notifyRunFailure\(/g)?.length).toBe(2) // 定义 + 调用各一处
  })

  it('守卫示警分支（guard.alarm）内没有通知调用', () => {
    const start = useConversationsCode.indexOf("type === 'guard.alarm'")
    expect(start).toBeGreaterThan(-1)
    const guardBlock = useConversationsCode.slice(start, start + 900)
    expect(guardBlock).not.toMatch(/notify(TaskIfNeeded|RunFailure|StoppedTurn|TerminalTurn)\(/)
  })
})

describe('设置页：通知收纳成“总开关 + 停滞一类 + 提示音”（stalled 单列一行）', () => {
  it('总开关 + 「模型疑似挂死」+「通知提示音」三项；旧的三类开关不再单列', async () => {
    const settingsSource = (await import('../components/SettingsPage.tsx?raw')).default as string
    // 总开关存在，且拨它走 setTaskNotifyAll（一次改四类）
    expect(settingsSource).toContain("t('任务状况通知'")
    expect(settingsSource).toMatch(/store\.setTaskNotifyAll\(Boolean\(value\)\)/)
    // 停滞单独一行，绑定 stalled 子开关；上级关掉时不可选
    expect(settingsSource).toContain("t('模型疑似挂死'")
    expect(settingsSource).toMatch(/store\.taskNotifyDraft\(\)\.stalled/)
    expect(settingsSource).toMatch(/store\.setTaskNotifyStalled\(Boolean\(value\)\)/)
    // 提示音存在，且**上级关掉时不可选**
    expect(settingsSource).toContain("t('通知提示音（默认关）'")
    expect(settingsSource).toMatch(/disabled=\{!store\.taskNotifyAllOn\(\)\}/)
    // 旧的三类开关文案必须消失（否则 UI 又变回四项）
    for (const gone of ['需要我拍板时通知', '任务失败时通知', '对话跑完时通知']) {
      expect(settingsSource).not.toContain(gone)
    }
  })
})

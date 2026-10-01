import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_STRIP_SETTLED_MS,
  backgroundStripDigest,
  outcomeForTasks,
  runningTasks,
} from '@/lib/backgroundStripDigest'

const tasks = (...statuses: string[]) => statuses.map((status, index) => ({ id: `t${index}`, name: `任务${index}`, status }))

describe('background strip digest', () => {
  // 终态映射优先级（用户拍定）：failed/timed_out > cancelled > running > succeeded。
  it('maps the complete task list to an outcome by the agreed priority', () => {
    expect(outcomeForTasks(tasks('succeeded', 'succeeded'), 1)?.kind).toBe('completed')
    expect(outcomeForTasks(tasks('succeeded', 'cancelled'), 1)?.kind).toBe('cancelled')
    expect(outcomeForTasks(tasks('cancelled', 'failed'), 1)?.kind).toBe('failed')
    expect(outcomeForTasks(tasks('timed_out'), 1)?.kind).toBe('failed')
    // 优先级：有 failed ⇒ 失败（**即使还有在跑的**，按用户拍定的顺序）。
    expect(outcomeForTasks(tasks('running', 'failed'), 1)?.kind).toBe('failed')
    // 只有在跑、没有终态可言 ⇒ 没有 outcome（那时窄带显示"进行中"）。
    expect(outcomeForTasks(tasks('running', 'running'), 1)).toBeNull()
    // 空列表 ⇒ 没有终态（不许无中生有）。
    expect(outcomeForTasks([], 1)).toBeNull()
  })

  it('keeps only the running tasks as the live fact', () => {
    const live = runningTasks(tasks('running', 'succeeded', 'running'))
    expect(live).toHaveLength(2)
    expect(live.every(task => task.status === 'running')).toBe(true)
  })

  // 在跑 ⇒ 四行那套：件数、第一件名字、moreCount = N-1、statusKind running。
  it('digests the running state with a count and the first name', () => {
    const digest = backgroundStripDigest({ running: tasks('running', 'running'), outcome: null, now: 1_000 })
    expect(digest).toEqual({ visible: true, mode: 'running', count: 2, firstName: '任务0', moreCount: 1, statusKind: 'running' })
    // 只有一件 ⇒ moreCount 0（组件据此不写"（还有 …）"）。
    expect(backgroundStripDigest({ running: tasks('running'), outcome: null, now: 1_000 }))
      .toMatchObject({ count: 1, moreCount: 0, mode: 'running' })
  })

  // 真机截图指出：一批 11 个里只有 1 个失败，却写成“共 11 个”✗ ⇒ 必须单独算失败个数。
  it('counts only the failed ones (a batch of many with one failure reports failedCount=1)', () => {
    const outcome = outcomeForTasks([
      { id: 'a', name: '打包', status: 'succeeded' },
      { id: 'b', name: '部署', status: 'failed' },
      { id: 'c', name: '清理', status: 'succeeded' },
    ], 1_000)
    expect(outcome).toMatchObject({ kind: 'failed', count: 3, failedCount: 1, firstName: '打包' })
    // 通知正文要报第一个**失败**任务，不是整批第一个（它可能是成功的）。
    expect(outcome).toMatchObject({ firstFailedName: '部署' })
    // 超时也算失败；两 个失败时才报 2。
    const two = outcomeForTasks([
      { id: 'a', name: '打包', status: 'failed' },
      { id: 'b', name: '部署', status: 'timed_out' },
      { id: 'c', name: '清理', status: 'succeeded' },
    ], 1_000)
    expect(two).toMatchObject({ kind: 'failed', count: 3, failedCount: 2, firstFailedName: '打包' })
  })

  // 终态停 15 秒（用户拍）；过期后 visible 变 false（收起）。
  it('shows a settled outcome for fifteen seconds and then hides it', () => {
    const outcome = { kind: 'failed' as const, count: 3, firstName: '打包', at: 1_000 }
    expect(BACKGROUND_STRIP_SETTLED_MS).toBe(15_000)
    // 14.9 秒仍可见；15.1 秒收起（窗口整数边界写清，避免下次又被读错）。
    const fresh = backgroundStripDigest({ running: [], outcome, now: 1_000 + 14_900 })
    expect(fresh).toMatchObject({ visible: true, mode: 'settled', count: 3, firstName: '打包', statusKind: 'failed' })
    expect(backgroundStripDigest({ running: [], outcome, now: 1_000 + 15_100 }).visible).toBe(false)
    expect(backgroundStripDigest({ running: [], outcome: null, now: 99_999 }).visible).toBe(false)
  })

  // 终态显示期间又开始新任务 ⇒ 立刻切回"进行中"（并让定时器失效）。
  it('prefers a new running task over a settled outcome', () => {
    const digest = backgroundStripDigest({
      running: tasks('running'),
      outcome: { kind: 'cancelled', count: 2, firstName: '旧任务', at: 1_000 },
      now: 1_100,
    })
    expect(digest).toMatchObject({ mode: 'running', count: 1, firstName: '任务0', statusKind: 'running' })
  })
})

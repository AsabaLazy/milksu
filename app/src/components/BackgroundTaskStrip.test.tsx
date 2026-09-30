// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const commandCalls: Array<{ command: string; args: unknown }> = []
let stopShouldFail = false

vi.mock('@/desktop', () => ({
  invokeCommand: vi.fn(async (command: string, args?: unknown) => {
    commandCalls.push({ command, args })
    if (command === 'stop_coding_background_task' && stopShouldFail) throw new Error('nope')
    return null
  }),
}))
import { BackgroundTaskStrip } from '@/components/BackgroundTaskStrip'

const task = (name: string, status = 'running') => ({ id: `t-${name}`, name, status })

async function setLocale(value: 'zh' | 'en') {
  const { applyUiLocale } = await import('@/lib/uiLocale')
  applyUiLocale(value)
}

describe('background task strip', () => {
  beforeEach(async () => {
    await setLocale('zh')
    vi.useRealTimers()
  })

  // 这个仓库没有开 testing-library 的自动清理 ⇒ 显式清，避免多次 render 命中多个窄带。
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  // 有在跑 ⇒ 三行：标题 / 件数·名字 / 状态（用户拍：**删掉**「请不要关机」那一行 ✗）。
  it('shows three lines while tasks are running, without the shutdown line', () => {
    render(<BackgroundTaskStrip running={[task('打包'), task('verify')]} outcome={null} />)
    const strip = screen.getByTestId('background-task-strip')
    expect(strip).not.toBeNull()
    expect(strip.textContent).toContain('后台任务进行中')
    expect(strip.textContent).toContain('2 件 · 打包（还有 1 件）')
    expect(strip.textContent).toContain('进行中')
    // 那一行已被用户拍掉。
    expect(strip.textContent).not.toContain('请不要关机')
    expect(strip.getAttribute('data-mode')).toBe('running')
  })

  // M=0（只有一件）⇒ **不写**「（还有 …）」。
  it('omits the "more" part when only one task is running', () => {
    render(<BackgroundTaskStrip running={[task('打包')]} outcome={null} />)
    const text = screen.getByTestId('background-task-strip').textContent ?? ''
    expect(text).toContain('1 件 · 打包')
    expect(text).not.toContain('还有')
  })

  // 英文界面成对（仓库硬约定）；「停止全部」按钮也在。
  it('is bilingual, and offers the stop-all button while running', async () => {
    await setLocale('en')
    render(<BackgroundTaskStrip running={[task('打包')]} outcome={null} conversationId="conv-1" />)
    const text = screen.getByTestId('background-task-strip').textContent ?? ''
    expect(text).toContain('Background task running')
    expect(text).toContain('Running')
    expect(text).not.toContain('Please do not shut down')
    expect(screen.getByTestId('background-task-stop-all').textContent).toContain('Stop all')
  })

  // 点「停止全部」⇒ 对**每个**在跑任务各发一次命令，且会话与任务 id 都传对。
  it('stops every running task with the right conversation and task ids', async () => {
    commandCalls.length = 0
    const onStopped = vi.fn()
    render(
      <BackgroundTaskStrip
        running={[task('打包'), task('verify')]}
        outcome={null}
        conversationId="conv-1"
        onStopped={onStopped}
      />,
    )
    act(() => { screen.getByTestId('background-task-stop-all').click() })
    await act(async () => { await Promise.resolve() })
    const calls = commandCalls.filter(call => call.command === 'stop_coding_background_task')
    expect(calls.map(call => call.args)).toEqual([
      { conversationId: 'conv-1', taskId: 't-打包' },
      { conversationId: 'conv-1', taskId: 't-verify' },
    ])
    expect(onStopped).toHaveBeenCalledWith(['t-打包', 't-verify'])
  })

  // 失败路径：命令 reject ⇒ 有**可见**反馈，不许静默吞掉。
  it('says so when stopping a task fails', async () => {
    commandCalls.length = 0
    stopShouldFail = true
    try {
      render(<BackgroundTaskStrip running={[task('打包')]} outcome={null} conversationId="conv-1" />)
      act(() => { screen.getByTestId('background-task-stop-all').click() })
      await act(async () => { await Promise.resolve() })
      expect(screen.getByTestId('background-task-stop-failed')).not.toBeNull()
    } finally {
      stopShouldFail = false
    }
  })

  // 终态模式：**没有**停止按钮（那时已经没有东西可停）。
  it('has no stop-all button in the settled mode', () => {
    render(<BackgroundTaskStrip running={[]} outcome={{ kind: 'cancelled', count: 1, firstName: '打包', at: Date.now() }} conversationId="conv-1" />)
    expect(screen.queryByTestId('background-task-stop-all')).toBeNull()
    expect(screen.getByTestId('background-task-strip').textContent).toContain('已取消')
  })

  // 终态：显示状态那行、不显示"请不要关机"，并在 15 秒后自动收起（假定时器）。
  it('shows a settled outcome and hides it after thirty seconds', () => {
    vi.useFakeTimers()
    render(<BackgroundTaskStrip running={[]} outcome={{ kind: 'completed', count: 1, firstName: '打包', at: Date.now() }} />)
    const strip = screen.getByTestId('background-task-strip')
    expect(strip.getAttribute('data-mode')).toBe('settled')
    expect(strip.textContent).toContain('已完成')
    expect(strip.textContent).toContain('1 件 · 打包')
    expect(strip.textContent).not.toContain('请不要关机')
    act(() => { vi.advanceTimersByTime(15_000 + 100) })
    expect(screen.queryByTestId('background-task-strip')).toBeNull()
  })

  // 终态显示期间又开始新任务 ⇒ 立刻切回"进行中"，旧定时器清掉（不会把新任务一并收起）。
  it('switches back to running when a new task starts during a settled window', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <BackgroundTaskStrip running={[]} outcome={{ kind: 'failed', count: 1, firstName: '打包', at: Date.now() }} />,
    )
    expect(screen.getByTestId('background-task-strip').textContent).toContain('失败')
    rerender(<BackgroundTaskStrip running={[task('新打包')]} outcome={{ kind: 'failed', count: 1, firstName: '打包', at: Date.now() }} />)
    const strip = screen.getByTestId('background-task-strip')
    expect(strip.getAttribute('data-mode')).toBe('running')
    expect(strip.textContent).toContain('新打包')
    act(() => { vi.advanceTimersByTime(15_000 + 100) })
    // 新任务还在跑 ⇒ 不许被旧定时器收起。
    expect(screen.getByTestId('background-task-strip')).not.toBeNull()
  })

  // 没有在跑也没有终态 ⇒ 整条不出现。
  it('renders nothing without a task or an outcome', () => {
    render(<BackgroundTaskStrip running={[]} outcome={null} />)
    expect(screen.queryByTestId('background-task-strip')).toBeNull()
  })
})

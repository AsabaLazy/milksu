import { describe, expect, it, vi } from 'vitest'
import { createStore } from '@/lib/reactStore'

describe('reactStore', () => {
  it('keeps getState stable until a write', () => {
    const store = createStore({ count: 0, label: 'a' })
    const first = store.getState()
    expect(store.getState()).toBe(first)
    store.setState({ count: 1 })
    expect(store.getState()).not.toBe(first)
    expect(store.getState().count).toBe(1)
    expect(store.getState().label).toBe('a')
  })

  it('does not notify when setState writes the same fields', () => {
    const store = createStore({ count: 1, label: 'a' })
    const listener = vi.fn()
    store.subscribe(listener)
    store.setState({ count: 1 })
    store.setState(state => state)
    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies subscribers after a real write', () => {
    const store = createStore({ count: 0 })
    const seen: number[] = []
    store.subscribe(() => {
      seen.push(store.getState().count)
    })
    store.setState({ count: 2 })
    expect(seen).toEqual([2])
  })

  // 第五单：schedulePublish 只合并「通知订阅者」，不改变「状态同步更新」这条语义。
  // 会话 store 用它把流式爆发期一帧内的多次写入合成一次 React 渲染。
  it('schedulePublish 合并一次调度内的多次写入为一次通知，状态仍同步可见', () => {
    const flushes: Array<() => void> = []
    const store = createStore({ count: 0 }, {
      schedulePublish: (flush) => {
        flushes.push(flush)
        return () => undefined
      },
    })
    const listener = vi.fn()
    store.subscribe(listener)

    store.setState({ count: 1 })
    store.setState({ count: 2 })
    store.setState({ count: 3 })

    expect(store.getState().count).toBe(3) // 状态同步更新
    expect(listener).not.toHaveBeenCalled() // 通知被合并到调度里
    expect(flushes).toHaveLength(1)

    flushes[0]!()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().count).toBe(3)

    // 下一次写入重新调度一次。
    store.setState({ count: 4 })
    expect(flushes).toHaveLength(2)
    flushes[1]!()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

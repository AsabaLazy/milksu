// @vitest-environment jsdom
// 第五单：流式爆发期把一帧内的多次状态写入合并成**一次**订阅者通知（= 一次 React 渲染）。
// 关键语义：`getState()` / 各 getter 仍然同步可见，被合并的只是渲染通知。
import { beforeEach, describe, expect, it, vi } from 'vitest'

type EventHandler = (event: { payload: unknown }) => void

const handlers = new Map<string, EventHandler>()
let stored: Record<string, unknown>[] = []

const invokeCommand = vi.fn(async (command: string, _args?: unknown) => {
  if (command === 'list_conversations') return stored
  if (command === 'get_coding_project_memory') return { recents: [], lastWorkspacePath: '' }
  return null
})

vi.mock('@/desktop', () => ({
  invokeCommand: (command: string, args?: unknown) => invokeCommand(command, args),
  listenEvent: vi.fn(async (name: string, handler: EventHandler) => {
    handlers.set(name, handler)
    return () => handlers.delete(name)
  }),
}))

function storedConversation(id: string) {
  return { id, title: id, createdAt: 1, messages: [] }
}

function emit(sessionId: string, payload: Record<string, unknown>) {
  handlers.get('engine-event')?.({ payload: { sessionId, ...payload } })
}

describe('useConversations 流式发布合批', () => {
  beforeEach(() => {
    handlers.clear()
    invokeCommand.mockClear()
  })

  it('一帧内的多个 assistant.delta 只通知一次订阅者，内容照旧累加', async () => {
    const { useConversations } = await import('@/composables/useConversations')
    const conversations = useConversations()
    stored = [storedConversation('conversation-1')]
    await conversations.load()
    await conversations.listen()
    conversations.activeId = 'conversation-1'

    const listener = vi.fn()
    const unsubscribe = conversations.store.subscribe(listener)
    try {
      emit('conversation-1', { type: 'assistant.started' })
      for (let i = 0; i < 6; i += 1) {
        emit('conversation-1', { type: 'assistant.delta', text: `${i}` })
      }

      // 状态同步可见：正文已经累加完毕，业务逻辑（与断言）不受合批影响。
      const messages = conversations.conversations.find(item => item.id === 'conversation-1')?.messages ?? []
      const last = messages.at(-1)
      expect(last?.role).toBe('assistant')
      expect(last?.content).toBe('012345')

      // 渲染通知被合并：此刻还没有通知订阅者。
      expect(listener).not.toHaveBeenCalled()

      // 下一帧（jsdom 用定时器实现 rAF）只通知一次。
      await new Promise(resolve => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve(undefined)); else setTimeout(resolve, 0) })
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })
})

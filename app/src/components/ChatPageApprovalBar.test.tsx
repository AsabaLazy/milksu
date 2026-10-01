// @vitest-environment jsdom
// 审批条底色的可读性回归：**底色必须不透明**，不许再出现半透明底。
// 病根同「问题横幅」（361eaf6e，读者真机反馈）：半透明底压在深色／花哨背景上读不清；
// 审批条还更吃亏 —— 它 `sticky` 压在滚动的转写上面，透出来的正是下面的正文；
// 原来的 `bg-background/95` 同样算透（`--background` 夜间只有 0.94 不透明度）⇒ 换成实色 `bg-popover`。
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/types'

const runtimeStub = {
  activeProblemTurn: null as unknown,
  conversations: [] as Conversation[],
  pendingWorkspaceHome: null as unknown,
  forceStopConversation: vi.fn(),
  wakeStuckTurn: vi.fn(async () => true),
  toggleDshPlanMode: () => undefined,
  streamStaleSeconds: 0,
  streamStale: false,
  activeStallKind: '' as '' | 'engine-gone' | 'model-stalled',
  store: { subscribe: () => () => undefined, getSnapshot: () => ({}) },
  setMultitask: () => undefined,
  selectedMultitask: false,
  runningConversationIds: [] as string[],
  dismissProblemTurn: () => undefined,
  dismissCrossConversationNotice: () => undefined,
  busySend: false,
  activeToolRunning: false,
  activeQueuedBehind: null as string | null,
  activeId: 'approval-bar-conversation',
  activeForceStopReady: false,
  activeEngineAlive: true,
  activeCrossConversationNotices: [] as unknown[],
  abortWorkingItem: () => undefined,
  abortWorkingAll: () => undefined,
}

vi.mock('@/stores/conversationsStore', () => ({
  useConversations: () => runtimeStub,
  ConversationsProvider: ({ children }: { children: unknown }) => children,
}))

vi.mock('@/desktop', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop')>()
  return {
    ...actual,
    // 审批卡挂载时会问一次决策层风险分（提示显隐用）；这里让它永不 resolve，保持渲染安静。
    invokeCommand: () => new Promise(() => undefined),
    listenEvent: () => Promise.resolve(() => undefined),
  }
})

vi.mock('@/modelCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/modelCatalog')>()
  return {
    ...actual,
    useLiveModelCatalog: () => ({
      snapshot: { providers: [], relay: null, includeUnconfigured: false },
      providers: [],
      providerGroups: [],
      pickerGroups: [],
      providerModelLabel: () => '',
      pickerModelLabel: () => '',
    }),
  }
})

const mountedRoots: Root[] = []

class FakeResizeObserver {
  constructor(_callback: () => void) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
class FakeIntersectionObserver {
  constructor(_callback: () => void) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 任何带透明度的底色 token：`bg-red-500/10`、`bg-background/95` …（边框的 `/40` 不算）。 */
const TRANSLUCENT_BG = /\bbg-[^\s"']*\/\d/g

function approvalConversation(command: string): Conversation {
  return {
    id: 'approval-bar-conversation',
    title: '审批条底色',
    createdAt: 0,
    messages: [
      { id: 'a-1', role: 'assistant', content: '', timestamp: 1, toolName: 'bash' },
      {
        id: 't-1',
        role: 'tool',
        content: command,
        timestamp: 2,
        toolName: 'bash',
        approvalState: 'pending',
        approvalRequestId: 'req-1',
      },
    ],
  }
}

async function renderApprovalBar(command: string) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push(root)
  const ChatPage = (await import('@/components/ChatPage')).default
  const conversation = approvalConversation(command)
  runtimeStub.conversations = [conversation]
  runtimeStub.activeId = conversation.id
  await act(async () => {
    root.render(
      <ChatPage
        conversation={conversation}
        settings={null}
        workspacePath="/tmp/probe"
        running={false}
        aborting={false}
        sessionReady
        resumed={false}
        compacting={false}
        ctfSession={false}
        ensureConversation={() => conversation.id}
      />,
    )
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  const bar = host.querySelector<HTMLElement>('[data-testid="approval-bar"]')
  expect(bar).not.toBeNull()
  return { host, bar: bar as HTMLElement }
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver = FakeResizeObserver
  ;(globalThis as unknown as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver
  if (typeof CSS === 'undefined') (globalThis as unknown as Record<string, unknown>).CSS = { escape: (value: string) => value }
  else if (typeof CSS.escape !== 'function') (CSS as unknown as Record<string, unknown>).escape = value => value
  window.localStorage.clear()
})

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  window.localStorage.clear()
})

describe('审批条底色', () => {
  it('底座是不透底的实色（不再是 bg-background/95）', async () => {
    const { bar } = await renderApprovalBar('ls -la /tmp/probe')
    expect(bar.className).toContain('bg-popover')
    expect(bar.className).not.toContain('bg-background/95')
    expect(bar.className.match(TRANSLUCENT_BG)).toBeNull()
    // sticky 必须带 top 偏移（`--chat-edge-top`）：没有 top 的 sticky 不吸顶，条会随正文滚走。
    // （重放本修复时这行曾被误删 ⇒ 这里守着，别让它再静默丢失。）
    expect(bar.getAttribute('style') ?? '').toContain('--chat-edge-top')
  })

  it('破坏性命令时也不换回半透明底（提示照旧，底色仍是实色）', async () => {
    const { bar } = await renderApprovalBar('rm -rf "$TARGET"')
    expect(bar.className).toContain('bg-popover')
    expect(bar.className.match(TRANSLUCENT_BG)).toBeNull()
  })
})

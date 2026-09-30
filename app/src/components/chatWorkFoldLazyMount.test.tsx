// @vitest-environment jsdom
// 第五单回归：折叠块**收起时不再挂载子内容**（惰性挂载）。
//
// 真机里一个收起的大工具输出 / markdown 全文有几十 KB：以前它们一直挂在 DOM 里、
// 只靠 <details> 的 UA 样式隐藏 ⇒ 每次挂载/重渲染都付全额渲染费，RSS 也白白涨。
// 这条测试卡住两个语义：收起时子内容不在 DOM；点开/受控 open 时必须出现（正确性不变）。
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useUiLocale', () => ({
  useT: () => (zh: string) => zh,
}))

import ChatWorkFold from '@/components/ChatWorkFold'
import ChatProcessFold from '@/components/ChatProcessFold'
import type { ChatActivityBlock, ChatProcessFoldBlock } from '@/lib/chatActivity'

const MODEL = { entries: [], thinkingMs: 0, thinkingRunning: false, liveLabel: '' }
const EMPTY: ReadonlySet<string> = new Set()
const NOOP = () => undefined

const mountedRoots: Root[] = []
beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  if (typeof CSS === 'undefined') (globalThis as unknown as Record<string, unknown>).CSS = { escape: (v: string) => v }
})
afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

function mount(): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push(root)
  return { host, root }
}

describe('折叠块收起时惰性挂载', () => {
  it('ChatWorkFold：受控 open 控制子内容是否挂载', async () => {
    const { host, root } = mount()
    await act(async () => {
      root.render(
        <ChatWorkFold model={MODEL} open={false} onToggle={NOOP}>
          <div data-testid="fold-body">很长的工具输出</div>
        </ChatWorkFold>,
      )
    })
    expect(host.querySelector('[data-testid="fold-body"]')).toBeNull()

    await act(async () => {
      root.render(
        <ChatWorkFold model={MODEL} open onToggle={NOOP}>
          <div data-testid="fold-body">很长的工具输出</div>
        </ChatWorkFold>,
      )
    })
    expect(host.querySelector('[data-testid="fold-body"]')).not.toBeNull()

    // 再收起 ⇒ 子内容撤下（点开的正确性由上面的受控路径保证）
    await act(async () => {
      root.render(
        <ChatWorkFold model={MODEL} open={false} onToggle={NOOP}>
          <div data-testid="fold-body">很长的工具输出</div>
        </ChatWorkFold>,
      )
    })
    expect(host.querySelector('[data-testid="fold-body"]')).toBeNull()
  })

  it('ChatProcessFold：默认收起，内部的工具条目内容不挂载', async () => {
    const activity = {
      kind: 'activity',
      id: 'act-1',
      running: false,
      messages: [
        { id: 't1', role: 'tool', content: '$ cat huge.log', toolName: 'read', toolCallId: 'c1', status: 'done', timestamp: 1 },
        { id: 't2', role: 'tool', content: 'X'.repeat(5000), toolName: 'read', toolCallId: 'c1', status: 'done', timestamp: 2 },
      ],
    } as unknown as ChatActivityBlock
    const processBlock = {
      kind: 'process',
      id: 'process:u1',
      blocks: [activity],
    } as unknown as ChatProcessFoldBlock

    const { host, root } = mount()
    await act(async () => {
      root.render(
        <ChatProcessFold
          process={processBlock}
          model={MODEL}
          activityOpen={() => false}
          activityOpenEntries={() => EMPTY}
          memoKey="k"
        />,
      )
    })
    // 折叠头（过程）在，工具输出正文不在。
    expect(host.textContent).toContain('过程')
    expect(host.textContent).not.toContain('XXXXX')
  })
})

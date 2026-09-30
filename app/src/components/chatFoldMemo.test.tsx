// @vitest-environment jsdom
// 回归测试：折叠组件必须被 memo 包住，且「props 未变的父重渲染」不能传导进去。
// 这条守的是性能事故的复发路径：ChatPage 每秒都会重渲染一次（时钟），
// 如果 ChatProcessFold / ChatActivityGroup 没有 memo，或者传进去的回调/模型身份每次都变，
// 整棵折叠子树就会跟着每秒重渲染（真机症状：万条对话里 CPU 打满、列表悬浮闪烁、点击被饿死）。
// 计数方式：把两者共同渲染的 ChatWorkFold 换成计数桩 —— memo 命中时它根本不会被重新渲染。
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const counters = vi.hoisted(() => ({ workFold: 0 }))

vi.mock('@/hooks/useUiLocale', () => ({
  useT: () => (zh: string) => zh,
}))

vi.mock('@/components/ChatWorkFold', async () => {
  const React = await import('react')
  return {
    default: (props: { onToggle?: (open: boolean) => void }) => {
      counters.workFold += 1
      if (!props.onToggle) return null
      return React.createElement('button', {
        'data-testid': 'fold-toggle',
        onClick: () => props.onToggle?.(true),
      })
    },
  }
})

import ChatActivityGroup from '@/components/ChatActivityGroup'
import ChatProcessFold from '@/components/ChatProcessFold'
import type { ChatActivityBlock, ChatProcessFoldBlock } from '@/lib/chatActivity'

const EMPTY: ReadonlySet<string> = new Set()
const NOOP = () => undefined
const MODEL = { entries: [], thinkingMs: 0, thinkingRunning: false, liveLabel: '' }

const activity = {
  kind: 'activity',
  id: 'act-1',
  running: true,
  messages: [
    { id: 't1', role: 'tool', content: '$ npm test', toolName: 'bash', status: 'running', timestamp: 1 },
  ],
} as unknown as ChatActivityBlock

const NO_TASKS: never[] = []
const OPEN_FALSE = () => false
const OPEN_ENTRIES = () => EMPTY

const processBlock = {
  kind: 'process',
  id: 'process:u1',
  blocks: [activity],
} as unknown as ChatProcessFoldBlock

beforeEach(() => { counters.workFold = 0 })
afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

const mountedRoots: Root[] = []

async function renderTwice(node: (tick: number) => ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push(root)
  await act(async () => { root.render(node(0)) })
  await act(async () => { root.render(node(1)) })
}

describe('折叠组件 memo', () => {
  it('ChatActivityGroup：props 未变的父重渲染被挡掉', async () => {
    await renderTwice(() => (
      <ChatActivityGroup
        activity={activity}
        model={MODEL}
        open={false}
        openEntryIds={EMPTY}
        subagentTasks={NO_TASKS}
        onToggleGroup={NOOP}
        onToggleEntry={NOOP}
      />
    ))
    expect(counters.workFold).toBe(1)
  })

  it('ChatProcessFold：props 未变的父重渲染被挡掉', async () => {
    await renderTwice(() => (
      <ChatProcessFold
        process={processBlock}
        model={MODEL}
        activityOpen={OPEN_FALSE}
        activityOpenEntries={OPEN_ENTRIES}
        memoKey="k"
      />
    ))
    expect(counters.workFold).toBe(1)
  })

  it('对照：props 真的变了时要重渲染（证明上一组测试有判别力）', async () => {    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    mountedRoots.push(root)
    await act(async () => {
      root.render(
        <ChatActivityGroup
          activity={activity}
          model={MODEL}
          open={false}
          openEntryIds={EMPTY}
          subagentTasks={NO_TASKS}
          onToggleGroup={NOOP}
          onToggleEntry={NOOP}
        />,
      )
    })
    await act(async () => {
      root.render(
        <ChatActivityGroup
          activity={activity}
          model={MODEL}
          open
          openEntryIds={EMPTY}
          subagentTasks={NO_TASKS}
          onToggleGroup={NOOP}
          onToggleEntry={NOOP}
        />,
      )
    })
    expect(counters.workFold).toBe(2)
  })

  // 回调签名是 (activityId, open)：折叠组自己带着 id 回调，调用方就不必在渲染循环里
  // 为每一段造一个新箭头函数（那会直接击穿 memo）。
  it('ChatActivityGroup：点开合时把 activityId 一起回传', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    mountedRoots.push(root)
    const onToggleGroup = vi.fn()
    await act(async () => {
      root.render(
        <ChatActivityGroup
          activity={activity}
          model={MODEL}
          open={false}
          openEntryIds={EMPTY}
          subagentTasks={NO_TASKS}
          onToggleGroup={onToggleGroup}
          onToggleEntry={NOOP}
        />,
      )
    })
    const toggle = host.querySelector('[data-testid="fold-toggle"]')
    expect(toggle).toBeTruthy()
    await act(async () => { (toggle as HTMLElement).click() })
    expect(onToggleGroup).toHaveBeenCalledWith('act-1', true)
  })
})

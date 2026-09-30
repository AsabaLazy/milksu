import { useEffect, useState, type ReactNode } from 'react'
import { chatFoldElapsedLabel, type ChatFoldModel } from '@/lib/chatWorkStatus'
import { detailsToggleOpen } from '@/lib/chatActivity'
import { useT } from '@/hooks/useUiLocale'

function ChatActivitySwap({ label }: { label: string }) {
  const [slot, setSlot] = useState({ current: label, leaving: '' })

  useEffect(() => {
    setSlot(previous => (
      previous.current === label ? previous : { current: label, leaving: previous.current }
    ))
  }, [label])

  useEffect(() => {
    if (!slot.leaving) return undefined
    const timer = window.setTimeout(() => {
      setSlot(previous => (previous.leaving ? { ...previous, leaving: '' } : previous))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [slot.leaving, slot.current])

  return (
    <p className="agent-process__live" role="status">
      <span className="agent-process__swap">
        {slot.leaving ? (
          <span className="agent-process__swap-leave" aria-hidden="true">{slot.leaving}</span>
        ) : null}
        <span className="agent-process__swap-enter agent-process__activity">{slot.current}</span>
      </span>
    </p>
  )
}

export default function ChatWorkFold({
  model,
  open,
  onToggle,
  children,
}: {
  model: ChatFoldModel
  open?: boolean
  onToggle?: (open: boolean) => void
  children: ReactNode
}) {
  const t = useT()
  const [now, setNow] = useState(0)
  const controlled = onToggle !== undefined
  // 收起时不挂载子内容（第五单）：真机里一个收起的大工具输出/markdown 全文有几十 KB，
  // 现状是「DOM 里都挂着、只是 <details> 按 UA 样式隐藏」⇒ 每次挂载/重渲染都付全额布局与渲染费，
  // RSS 也白白涨。这里用同一个开合信号做闸门：收起挂 null，点开那一刻才挂上。
  // 受控（open/onToggle）用 prop，非受控（ChatProcessFold）在 onToggle 里镜像原生状态。
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isOpen = controlled ? Boolean(open) : uncontrolledOpen

  useEffect(() => {
    if (!model.thinkingRunning || model.thinkingStartedAt == null) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [model.thinkingRunning, model.thinkingStartedAt])

  const totals = chatFoldElapsedLabel(model, now || Date.now())
  const running = model.thinkingRunning || Boolean(model.liveLabel)
  const statusLabel = model.liveLabel
    ? t('进行中', 'Running')
    : t('过程', 'Process')

  return (
    <div className="agent-process mb-7">
      <details
        className="agent-process__details"
        open={controlled ? open : undefined}
        onToggle={event => {
          const next = detailsToggleOpen({
            target: event.target,
            currentTarget: event.currentTarget,
          })
          // 嵌套的 <details>（工具条目）开合会冒泡上来，detailsToggleOpen 会把它们过滤成 undefined。
          if (next === undefined) return
          if (!controlled) setUncontrolledOpen(next)
          onToggle?.(next)
        }}
      >
        <summary className="agent-process__summary">
          <span
            className="agent-process__status-dot"
            data-running={running ? 'true' : 'false'}
            aria-hidden="true"
          />
          <span className="agent-process__status">{statusLabel}</span>
          {totals ? <span className="agent-process__totals">{totals}</span> : null}
        </summary>
        <div className="agent-process__body">{isOpen ? children : null}</div>
      </details>
      {model.liveLabel ? <ChatActivitySwap label={model.liveLabel} /> : null}
    </div>
  )
}

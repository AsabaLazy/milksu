import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@/components/ui'
import type { SessionSizeReport } from '@/lib/sessionSizeWarning'
import { formatSessionSize } from '@/lib/sessionSizeWarning'
import { useT } from '@/hooks/useUiLocale'

/**
 * 会话过胖提示的新形态（2026-09-30 用户拍板）：
 *
 * 旧的实现是 dock 里一条全宽横幅，平时一直占着输入框上方。现在收成一枚小指示，
 * 和 ContextUsageMeter 并排待在输入框 footer 里；点开才在**上方**弹出完整提示和按钮，
 * 不挤压输入框。
 *
 * 可点性：本组件挂在 composer 的 meta 行里，随 `.chat-composer__island` 一起命中
 * dock 的 pointer-events 白名单；展开的 PopoverContent 由 Radix portal 到 body，
 * 不受 `.chat-column__dock { pointer-events: none }` 影响。上一版横幅就是死在
 * pointer-events 上（按钮看得见按不动），所以这里刻意复用了和 ContextUsageMeter
 * 完全相同的 Popover 结构。
 */
export default function SessionSizeWarningPill({
  report,
  compacting,
  onCompactContext,
  onDismiss,
}: {
  report: SessionSizeReport
  compacting?: boolean
  onCompactContext?: () => void
  onDismiss: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const size = formatSessionSize(report.chars)

  function dismiss() {
    setOpen(false)
    onDismiss()
  }

  function compact() {
    if (!onCompactContext || compacting) return
    setOpen(false)
    onCompactContext()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="session-size-warning-pill inline-flex items-center gap-1 rounded-md text-warning hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="session-size-warning"
          aria-expanded={open}
          aria-label={t(
            `上下文过大：约 ${size}。点击查看建议。`,
            `Large context: about ${size}. Click for advice.`,
          )}
        >
          <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
          <span className="font-mono tabular-nums">{t('会话', 'Chat')}&nbsp;{size}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="context-usage-panel w-80 p-3"
        data-testid="session-size-warning-panel"
      >
        <p className="text-caption leading-5">
          {t(
            `该会话已约 ${size}，请求容易超时。建议压缩上下文，或新开一个会话继续。`,
            `This conversation is about ${size}, so requests can time out. Compact the context, or continue in a new chat.`,
          )}
        </p>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {onCompactContext && !compacting ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="session-size-compact"
              onClick={compact}
            >
              {t('压缩上下文', 'Compact')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="session-size-dismiss"
            onClick={dismiss}
          >
            {t('知道了', 'Got it')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

import { useEffect, useRef, useState } from 'react'
import { BookOpenText, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { Badge, Button } from '@/components/ui'
import MarkdownContent from '@/components/MarkdownContent'
import { invokeCommand, listenEvent } from '@/desktop'
import { useT } from '@/hooks/useUiLocale'
import { toastError } from '@/lib/appToast'
import type {
  ResearchPhase,
  ResearchRun,
  ResearchRunStatus,
  ResearchSnapshot,
  ResearchSource,
  ResearchSourceDetail,
  ResearchTask,
} from '@/types'

type ResearchRuntimeEvent = {
  sessionId?: string
  conversationId?: string
  type?: string
  toolName?: string
  content?: string
}

type SnapshotEntry = {
  conversationId: string
  snapshot: ResearchSnapshot | null
}

type ResearchDetail =
  | { conversationId: string; runId: string; kind: 'report'; content: string }
  | { conversationId: string; runId: string; kind: 'source'; source: ResearchSource; extract: string }

type DetailRequest = { conversationId: string; runId: string; key: string }
type DetailError = { conversationId: string; runId: string; message: string }

function statusLabel(status: ResearchRunStatus, t: ReturnType<typeof useT>) {
  switch (status) {
    case 'running': return t('运行中', 'Running')
    case 'completed': return t('已完成', 'Completed')
    case 'failed': return t('失败', 'Failed')
    case 'cancelled': return t('已取消', 'Cancelled')
    case 'interrupted': return t('已中断', 'Interrupted')
  }
}

function phaseLabel(phase: ResearchPhase, t: ReturnType<typeof useT>) {
  switch (phase) {
    case 'collecting': return t('收集证据', 'Collecting evidence')
    case 'waiting': return t('等待工作者', 'Waiting for workers')
    case 'synthesis_pending': return t('准备综合', 'Preparing synthesis')
    case 'synthesizing': return t('综合中', 'Synthesizing')
    case 'gap_fill_collecting': return t('补充证据', 'Filling evidence gaps')
    case 'gap_fill_waiting': return t('等待补充工作者', 'Waiting for gap-fill workers')
    case 'final_synthesis_pending': return t('准备最终综合', 'Preparing final synthesis')
    case 'finalizing': return t('最终综合', 'Final synthesis')
  }
}

function taskSummary(tasks: ResearchTask[], t: ReturnType<typeof useT>) {
  const counts = new Map<string, number>()
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
  const parts = [
    ['completed', t(`${counts.get('completed') ?? 0} 已完成`, `${counts.get('completed') ?? 0} completed`)],
    ['running', t(`${counts.get('running') ?? 0} 进行中`, `${counts.get('running') ?? 0} running`)],
    ['launching', t(`${counts.get('launching') ?? 0} 启动中`, `${counts.get('launching') ?? 0} launching`)],
    ['failed', t(`${counts.get('failed') ?? 0} 失败`, `${counts.get('failed') ?? 0} failed`)],
    ['interrupted', t(`${counts.get('interrupted') ?? 0} 中断`, `${counts.get('interrupted') ?? 0} interrupted`)],
    ['cancelled', t(`${counts.get('cancelled') ?? 0} 已取消`, `${counts.get('cancelled') ?? 0} cancelled`)],
  ].filter(([status]) => counts.has(status))
  return tasks.length
    ? `${t(`${tasks.length} 个任务`, `${tasks.length} tasks`)} · ${parts.map(([, label]) => label).join(' · ')}`
    : t('尚无工作任务', 'No worker tasks yet')
}

function sourceHost(source: ResearchSource) {
  try {
    return new URL(source.url).host
  } catch {
    return source.url
  }
}

function errorMessage(reason: unknown, t: ReturnType<typeof useT>) {
  return reason instanceof Error && reason.message.trim()
    ? reason.message
    : t('无法读取研究详情。', 'Could not read research details.')
}

export default function DeepResearchStatusCard({
  conversationId,
  onResume,
  canResume = true,
}: {
  conversationId: string
  onResume: (runId: string) => void
  canResume?: boolean
}) {
  const t = useT()
  const [entry, setEntry] = useState<SnapshotEntry | null>(null)
  const [cancellingConversationId, setCancellingConversationId] = useState('')
  const [detail, setDetail] = useState<ResearchDetail | null>(null)
  const [detailRequest, setDetailRequest] = useState<DetailRequest | null>(null)
  const [detailError, setDetailError] = useState<DetailError | null>(null)
  const conversationIdRef = useRef(conversationId)
  const refreshRef = useRef<() => void>(() => undefined)
  conversationIdRef.current = conversationId

  useEffect(() => {
    if (!conversationId) return
    let active = true
    let revision = 0
    let stopListening: (() => void) | undefined

    async function refresh() {
      const currentRevision = ++revision
      try {
        const runs = await invokeCommand<ResearchRun[]>('list_research_runs', { conversationId })
        if (!active || currentRevision !== revision) return
        const latest = runs.find(run => run.conversationId === conversationId)
        const snapshot = latest
          ? await invokeCommand<ResearchSnapshot>('get_research_run', {
              conversationId,
              runId: latest.id,
            })
          : null
        if (!active || currentRevision !== revision) return
        const validSnapshot = snapshot?.run.conversationId === conversationId
          && snapshot.run.id === latest?.id
          ? snapshot
          : null
        setEntry({ conversationId, snapshot: validSnapshot })
      } catch {
        if (!active || currentRevision !== revision) return
        setEntry(current => current?.conversationId === conversationId
          ? current
          : { conversationId, snapshot: null })
      }
    }

    const refreshCurrentConversation = () => { void refresh() }
    refreshRef.current = refreshCurrentConversation
    void refresh()

    void listenEvent<ResearchRuntimeEvent>('engine-event', event => {
      const payload = event.payload
      const eventConversationId = payload.sessionId ?? payload.conversationId
      if (eventConversationId !== conversationId) return
      if (payload.type === 'runtime.research_cancel_unconfirmed') {
        toastError(
          new Error(payload.content || t('无法确认所有研究工作者都已停止。', 'Could not confirm that all research workers stopped.')),
          t('研究停止未确认', 'Research stop unconfirmed'),
        )
        refreshCurrentConversation()
        return
      }
      if (
        payload.type === 'runtime.research_tasks'
        || payload.type === 'runtime.research_cancel_confirmed'
        || payload.type === 'engine.error'
        || payload.type === 'session.destroyed'
        || (payload.type === 'tool.completed' && payload.toolName === 'milksu_workspace')
      ) {
        refreshCurrentConversation()
      }
    }).then(stop => {
      if (active) stopListening = stop
      else stop()
    }).catch(() => undefined)

    return () => {
      active = false
      revision++
      stopListening?.()
      if (refreshRef.current === refreshCurrentConversation) {
        refreshRef.current = () => undefined
      }
    }
  }, [conversationId])

  const snapshot = entry?.conversationId === conversationId ? entry.snapshot : null
  const run = snapshot?.run
  const currentDetail = detail?.conversationId === conversationId && detail.runId === run?.id
    ? detail
    : null
  const currentDetailRequest = detailRequest?.conversationId === conversationId && detailRequest.runId === run?.id
    ? detailRequest
    : null
  const currentDetailError = detailError?.conversationId === conversationId && detailError.runId === run?.id
    ? detailError.message
    : ''

  async function readReport(currentRun: ResearchRun) {
    if (currentDetail?.kind === 'report') {
      setDetail(null)
      setDetailError(null)
      return
    }
    const request = { conversationId, runId: currentRun.id, key: 'report' }
    setDetailError(null)
    setDetailRequest(request)
    try {
      const content = await invokeCommand<string>('read_research_report', {
        conversationId,
        runId: currentRun.id,
      })
      if (conversationIdRef.current === conversationId) {
        setDetail({ ...request, kind: 'report', content })
      }
    } catch (reason) {
      if (conversationIdRef.current === conversationId) {
        setDetailError({ ...request, message: errorMessage(reason, t) })
      }
    } finally {
      setDetailRequest(current => current?.key === request.key
        && current.conversationId === request.conversationId
        && current.runId === request.runId
        ? null
        : current)
    }
  }

  async function readSource(source: ResearchSource) {
    if (currentDetail?.kind === 'source' && currentDetail.source.id === source.id) {
      setDetail(null)
      setDetailError(null)
      return
    }
    const request = { conversationId, runId: run?.id ?? '', key: `source:${source.id}` }
    if (!request.runId) return
    setDetailError(null)
    setDetailRequest(request)
    try {
      const result = await invokeCommand<ResearchSourceDetail>('read_research_source', {
        conversationId,
        sourceId: source.id,
      })
      if (conversationIdRef.current === conversationId) {
        setDetail({
          ...request,
          kind: 'source',
          source: result.source,
          extract: result.extract,
        })
      }
    } catch (reason) {
      if (conversationIdRef.current === conversationId) {
        setDetailError({ ...request, message: errorMessage(reason, t) })
      }
    } finally {
      setDetailRequest(current => current?.key === request.key
        && current.conversationId === request.conversationId
        && current.runId === request.runId
        ? null
        : current)
    }
  }

  async function cancelRun(currentRun: ResearchRun) {
    if (
      (currentRun.status !== 'running'
        && currentRun.status !== 'interrupted'
        && !(currentRun.status === 'cancelled' && currentRun.workerStopUnconfirmed))
      || cancellingConversationId === conversationId
    ) return
    setCancellingConversationId(conversationId)
    try {
      await invokeCommand<ResearchRun>('cancel_research_run', {
        conversationId,
        runId: currentRun.id,
      })
    } catch (reason) {
      if (conversationIdRef.current === conversationId) {
        toastError(reason, t('研究运行取消失败。', 'Could not cancel the research run.'))
      }
    } finally {
      setCancellingConversationId(current => current === conversationId ? '' : current)
      if (conversationIdRef.current === conversationId) refreshRef.current()
    }
  }

  if (!run || !snapshot) return null

  const reportOpen = currentDetail?.kind === 'report'
  const canCancel = run.status === 'running'
    || run.status === 'interrupted'
    || (run.status === 'cancelled' && run.workerStopUnconfirmed)
  const sourceOpen = (sourceId: string) => (
    currentDetail?.kind === 'source' && currentDetail.source.id === sourceId
  )

  return (
    <section
      className="mx-auto mb-3 w-[min(92%,48rem)] rounded-xl border border-border/70 bg-muted/30 px-3 py-2 text-caption text-foreground md:w-[min(72%,48rem)]"
      aria-label={t('深度研究状态', 'Deep Research status')}
      data-testid="deep-research-status-card"
      data-run-id={run.id}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex shrink-0 items-center gap-1.5 font-medium">
          <BookOpenText className="size-3.5 text-primary" />
          {t('深度研究', 'Deep Research')}
        </span>
        <Badge variant={run.status === 'failed' ? 'destructive' : run.status === 'running' ? 'secondary' : 'outline'}>
          {statusLabel(run.status, t)}
        </Badge>
        <Badge variant="outline">{phaseLabel(run.phase, t)}</Badge>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={run.query}>
          {run.query}
        </span>
        <span className="w-full text-muted-foreground md:ml-auto md:w-auto" data-testid="deep-research-task-summary">
          {taskSummary(snapshot.tasks, t)}
        </span>
        {canCancel ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={cancellingConversationId === conversationId}
            data-testid="deep-research-cancel"
            onClick={() => { void cancelRun(run) }}
          >
            {cancellingConversationId === conversationId
              ? <LoaderCircle className="size-3.5 animate-spin" />
              : <X className="size-3.5" />}
            {run.status === 'cancelled' ? t('重试停止', 'Retry stop') : t('取消', 'Cancel')}
          </Button>
        ) : null}
        {run.status === 'interrupted' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canResume}
            title={canResume ? undefined : t(
              '切换到 Pi Go 模式并结束当前回合后才能继续研究。',
              'Switch to Pi Go mode and wait for the current turn to finish before resuming.',
            )}
            data-testid="deep-research-resume"
            onClick={() => onResume(run.id)}
          >
            <RotateCcw className="size-3.5" />
            {t('继续研究', 'Resume')}
          </Button>
        ) : null}
        {run.status === 'completed' ? (
          <Button
            type="button"
            variant="quiet"
            size="sm"
            aria-expanded={reportOpen}
            data-testid="deep-research-report-toggle"
            disabled={Boolean(currentDetailRequest)}
            onClick={() => { void readReport(run) }}
          >
            {currentDetailRequest?.key === 'report'
              ? <LoaderCircle className="size-3.5 animate-spin" />
              : <BookOpenText className="size-3.5" />}
            {reportOpen ? t('收起报告', 'Hide report') : t('阅读报告', 'Read report')}
          </Button>
        ) : null}
      </div>

      {run.workerStopUnconfirmed ? (
        <p className="mt-1 text-destructive" role="alert" data-testid="deep-research-stop-warning">
          {t(
            '尚未确认后台研究工作者已停止；确认前不会启动新的研究运行。',
            'Background worker stop is unconfirmed. A new research run is blocked until it is confirmed.',
          )}
        </p>
      ) : null}

      {snapshot.sources.length ? (
        <div className="mt-1.5 border-t border-border/60 pt-1.5">
          <span className="text-muted-foreground">
            {t(`来源 (${snapshot.sources.length})`, `Sources (${snapshot.sources.length})`)}
          </span>
          <ul className="mt-0.5 grid max-h-24 gap-0.5 overflow-y-auto">
            {snapshot.sources.map(source => (
              <li key={source.id} className="min-w-0">
                <Button
                  type="button"
                  variant="quiet"
                  size="text"
                  className="h-auto max-w-full min-w-0 justify-start gap-1.5 px-0 py-0 text-left text-caption font-normal"
                  aria-label={t(`读取来源：${source.title}`, `Read source: ${source.title}`)}
                  aria-expanded={sourceOpen(source.id)}
                  title={source.url}
                  data-testid="deep-research-source-toggle"
                  disabled={Boolean(currentDetailRequest)}
                  onClick={() => { void readSource(source) }}
                >
                  <span className="truncate">{source.title || source.url}</span>
                  <span className="shrink-0 text-muted-foreground">·</span>
                  <span className="truncate text-muted-foreground">{sourceHost(source)}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {currentDetailRequest ? (
        <p className="mt-2 text-muted-foreground" role="status">
          {t('正在读取…', 'Reading…')}
        </p>
      ) : null}
      {currentDetailError ? (
        <p className="mt-2 text-destructive" role="alert">{currentDetailError}</p>
      ) : null}
      {currentDetail?.kind === 'report' ? (
        <div className="mt-2 max-h-96 overflow-y-auto rounded-lg border border-border/70 bg-background/45 p-3">
          <MarkdownContent content={currentDetail.content} compact className="text-caption leading-5" />
        </div>
      ) : null}
      {currentDetail?.kind === 'source' ? (
        <div className="mt-2 rounded-lg border border-border/70 bg-background/45 p-3">
          <p className="mb-1 font-medium">{currentDetail.source.title}</p>
          <p className="mb-2 break-all text-muted-foreground">{currentDetail.source.url}</p>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-sans text-caption leading-5">
            {currentDetail.extract}
          </pre>
        </div>
      ) : null}
    </section>
  )
}

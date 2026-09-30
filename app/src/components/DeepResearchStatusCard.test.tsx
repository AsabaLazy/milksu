// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ResearchRun,
  ResearchSnapshot,
  ResearchSource,
  ResearchSourceDetail,
  ResearchTask,
} from '@/types'
import { resetToastsForTests, subscribeToasts } from '@/lib/appToast'
import { applyUiLocale } from '@/lib/uiLocale'
import DeepResearchStatusCard from './DeepResearchStatusCard'

function makeRun(
  conversationId: string,
  status: ResearchRun['status'],
  query = 'Compare official release dates',
): ResearchRun {
  return {
    id: `research_${conversationId}`,
    conversationId,
    query,
    status,
    phase: status === 'running' ? 'gap_fill_collecting' : 'collecting',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  }
}

function makeSource(runId: string, id: string, title: string): ResearchSource {
  return {
    id,
    runId,
    url: `https://example.test/${id}`,
    title,
    retrievedAt: '2026-01-01T00:00:00Z',
    artifactRef: 'a'.repeat(64),
  }
}

function makeTask(runId: string, id: string, status: ResearchTask['status']): ResearchTask {
  return { id, runId, prompt: `Task ${id}`, status, workerId: id, batch: 1 }
}

function makeSnapshot(
  run: ResearchRun,
  tasks: ResearchTask[] = [],
  sources: ResearchSource[] = [],
): ResearchSnapshot {
  return { run, tasks, sources, citations: [] }
}

function installDesktopMock() {
  const runs = new Map<string, ResearchRun[]>()
  const snapshots = new Map<string, ResearchSnapshot>()
  const sourceDetails = new Map<string, ResearchSourceDetail>()
  const reports = new Map<string, string>()
  const pendingRuns = new Map<string, Promise<ResearchRun[]>>()
  const eventListeners = new Set<(value: unknown) => void>()
  const invoke = vi.fn(async (method: string, args: unknown[]) => {
    const conversationId = String(args[0] ?? '')
    const recordId = String(args[1] ?? '')
    switch (method) {
      case 'ListResearchRuns':
        return pendingRuns.get(conversationId) ?? runs.get(conversationId) ?? []
      case 'GetResearchRun':
        return snapshots.get(recordId)
      case 'ReadResearchSource':
        return sourceDetails.get(recordId)
      case 'ReadResearchReport':
        return reports.get(recordId) ?? ''
      case 'CancelResearchRun':
        return runs.get(conversationId)?.find(run => run.id === recordId)
      default:
        throw new Error(`Unexpected renderer RPC: ${method}`)
    }
  })
  const onEvent = vi.fn((_event: string, listener: (value: unknown) => void) => {
    eventListeners.add(listener)
    return () => { eventListeners.delete(listener) }
  })
  Object.defineProperty(window, 'milksu', {
    configurable: true,
    value: { invoke, onEvent },
  })
  return {
    runs,
    snapshots,
    sourceDetails,
    reports,
    pendingRuns,
    invoke,
    emit(payload: unknown) {
      for (const listener of eventListeners) listener(payload)
    },
    listenerCount: () => eventListeners.size,
  }
}

describe('DeepResearchStatusCard', () => {
  let desktop: ReturnType<typeof installDesktopMock>

  beforeEach(() => {
    applyUiLocale('en')
    desktop = installDesktopMock()
  })

  afterEach(() => {
    cleanup()
    resetToastsForTests()
    applyUiLocale('zh')
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'milksu')
  })

  it('maps the persisted snapshot, reads source details, cancels running work, and filters refresh events', async () => {
    const run = makeRun('pi-one', 'running')
    const source = makeSource(run.id, 'source-one', 'Official release notes')
    desktop.runs.set('pi-one', [run])
    desktop.snapshots.set(run.id, makeSnapshot(run, [
      makeTask(run.id, 'task-done', 'completed'),
      makeTask(run.id, 'task-running', 'running'),
      makeTask(run.id, 'task-launching', 'launching'),
      makeTask(run.id, 'task-failed', 'failed'),
    ], [source]))
    desktop.sourceDetails.set(source.id, { source, extract: 'The release date is January 2.' })

    render(<DeepResearchStatusCard conversationId="pi-one" onResume={vi.fn()} />)

    expect((await screen.findByTestId('deep-research-status-card')).getAttribute('data-run-id')).toBe(run.id)
    expect(screen.getByText('Running')).not.toBeNull()
    expect(screen.getByText('Filling evidence gaps')).not.toBeNull()
    expect(screen.getByTestId('deep-research-task-summary').textContent)
      .toContain('4 tasks · 1 completed · 1 running · 1 launching · 1 failed')
    const sourceButton = screen.getByRole('button', { name: 'Read source: Official release notes' })
    expect(sourceButton.textContent).toContain('example.test')
    expect(screen.getByTestId('deep-research-cancel')).not.toBeNull()
    expect(screen.queryByTestId('deep-research-resume')).toBeNull()

    fireEvent.click(sourceButton)
    expect(await screen.findByText('The release date is January 2.')).not.toBeNull()

    fireEvent.click(screen.getByTestId('deep-research-cancel'))
    await waitFor(() => {
      expect(desktop.invoke).toHaveBeenCalledWith('CancelResearchRun', ['pi-one', run.id])
    })

    const listCalls = () => desktop.invoke.mock.calls.filter(([method]) => method === 'ListResearchRuns').length
    await waitFor(() => expect(listCalls()).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(desktop.listenerCount()).toBe(1))
    const initialListCalls = listCalls()
    await act(async () => {
      desktop.emit({ sessionId: 'pi-other', type: 'runtime.research_tasks' })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(listCalls()).toBe(initialListCalls)

    await act(async () => {
      desktop.emit({ sessionId: 'pi-one', type: 'runtime.research_tasks' })
    })
    await waitFor(() => expect(listCalls()).toBe(initialListCalls + 1))
    await act(async () => {
      desktop.emit({ sessionId: 'pi-one', type: 'tool.completed', toolName: 'milksu_workspace' })
    })
    await waitFor(() => expect(listCalls()).toBe(initialListCalls + 2))
    await act(async () => {
      desktop.emit({ sessionId: 'pi-one', type: 'engine.error' })
    })
    await waitFor(() => expect(listCalls()).toBe(initialListCalls + 3))
  })

  it('reads a completed report with Markdown and exposes no running or resume actions', async () => {
    const run = makeRun('pi-complete', 'completed')
    desktop.runs.set('pi-complete', [run])
    desktop.snapshots.set(run.id, makeSnapshot(run))
    desktop.reports.set(run.id, '## Findings\n\nThe verified date is January 2.')

    render(<DeepResearchStatusCard conversationId="pi-complete" onResume={vi.fn()} />)

    fireEvent.click(await screen.findByTestId('deep-research-report-toggle'))
    expect(await screen.findByRole('heading', { name: 'Findings' })).not.toBeNull()
    expect(screen.getByText('The verified date is January 2.')).not.toBeNull()
    expect(screen.queryByTestId('deep-research-cancel')).toBeNull()
    expect(screen.queryByTestId('deep-research-resume')).toBeNull()
  })

  it('offers resume and cancel for an interrupted run without a Resume RPC', async () => {
    const run = makeRun('pi-interrupted', 'interrupted')
    const onResume = vi.fn()
    desktop.runs.set('pi-interrupted', [run])
    desktop.snapshots.set(run.id, makeSnapshot(run))

    render(<DeepResearchStatusCard conversationId="pi-interrupted" onResume={onResume} />)

    fireEvent.click(await screen.findByTestId('deep-research-resume'))
    expect(onResume).toHaveBeenCalledWith(run.id)
    expect(screen.getByTestId('deep-research-cancel')).not.toBeNull()
    expect(desktop.invoke.mock.calls.some(([method]) => method === 'ResumeResearchRun')).toBe(false)
  })

  it('keeps resume disabled when the current conversation cannot mutate its research run', async () => {
    const run = makeRun('pi-readonly', 'interrupted')
    const onResume = vi.fn()
    desktop.runs.set('pi-readonly', [run])
    desktop.snapshots.set(run.id, makeSnapshot(run))

    render(<DeepResearchStatusCard conversationId="pi-readonly" onResume={onResume} canResume={false} />)

    const resume = await screen.findByTestId('deep-research-resume')
    expect((resume as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(resume)
    expect(onResume).not.toHaveBeenCalled()
  })

  it('surfaces an unconfirmed worker stop for the current conversation', async () => {
    const run = makeRun('pi-stop', 'running')
    desktop.runs.set('pi-stop', [run])
    desktop.snapshots.set(run.id, makeSnapshot(run))
    const toasts: Array<{ title: string }> = []
    const unlisten = subscribeToasts(entries => {
      toasts.splice(0, toasts.length, ...entries)
    })

    render(<DeepResearchStatusCard conversationId="pi-stop" onResume={vi.fn()} />)
    await screen.findByTestId('deep-research-status-card')
    await waitFor(() => expect(desktop.listenerCount()).toBe(1))
    await act(async () => {
      desktop.emit({
        sessionId: 'pi-stop',
        type: 'runtime.research_cancel_unconfirmed',
        content: 'Could not confirm stop for Research worker worker-1',
      })
    })

    expect(toasts.some(entry => entry.title.includes('Could not confirm stop'))).toBe(true)
    unlisten()
  })

  it('keeps an unconfirmed stop visible and offers a retry after refresh', async () => {
    const run = { ...makeRun('pi-stop-persisted', 'cancelled'), workerStopUnconfirmed: true }
    desktop.runs.set('pi-stop-persisted', [run])
    desktop.snapshots.set(run.id, makeSnapshot(run))

    render(<DeepResearchStatusCard conversationId="pi-stop-persisted" onResume={vi.fn()} />)

    expect(await screen.findByTestId('deep-research-stop-warning')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Retry stop' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry stop' }))
    await waitFor(() => {
      expect(desktop.invoke).toHaveBeenCalledWith('CancelResearchRun', [
        'pi-stop-persisted',
        run.id,
      ])
    })
  })

  it('switches snapshots and ignores late results and events from the previous conversation', async () => {
    const firstRun = makeRun('pi-first', 'interrupted', 'Conversation one saved run')
    const secondRun = makeRun('pi-second', 'running', 'Conversation two active run')
    desktop.runs.set('pi-second', [secondRun])
    desktop.snapshots.set(firstRun.id, makeSnapshot(firstRun))
    desktop.snapshots.set(secondRun.id, makeSnapshot(secondRun))
    let resolveFirstRuns!: (runs: ResearchRun[]) => void
    desktop.pendingRuns.set('pi-first', new Promise(resolve => { resolveFirstRuns = resolve }))

    const { rerender } = render(
      <DeepResearchStatusCard conversationId="pi-first" onResume={vi.fn()} />,
    )
    rerender(<DeepResearchStatusCard conversationId="pi-second" onResume={vi.fn()} />)

    expect(await screen.findByText('Conversation two active run')).not.toBeNull()
    expect(screen.queryByText('Conversation one saved run')).toBeNull()
    await waitFor(() => expect(desktop.listenerCount()).toBe(1))

    await act(async () => {
      resolveFirstRuns([firstRun])
      await Promise.resolve()
    })
    expect(screen.queryByText('Conversation one saved run')).toBeNull()

    const secondConversationCalls = () => desktop.invoke.mock.calls.filter(([method, args]) => (
      method === 'ListResearchRuns' && args[0] === 'pi-second'
    )).length
    await act(async () => {
      desktop.emit({ sessionId: 'pi-first', type: 'runtime.research_tasks' })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(secondConversationCalls()).toBe(1)

    await act(async () => {
      desktop.emit({ conversationId: 'pi-second', type: 'tool.completed', toolName: 'milksu_workspace' })
    })
    await waitFor(() => expect(secondConversationCalls()).toBe(2))
  })
})

import { agentToolChip, thinkingSummary } from '@/lib/agentConversation'
import {
  buildChatActivityEntries,
  type ChatActivityEntry,
  type ChatTranscriptBlock,
} from '@/lib/chatActivity'
import { t } from '@/lib/uiLocale'
import type { Message } from '@/types'

const commandTools = new Set(['bash', 'background', 'background_output', 'bg_task', 'bg_status'])
const editTools = new Set(['edit', 'write', 'lsp_fix'])
const searchTools = new Set(['grep', 'find', 'ls'])

export interface ChatWorkCounts {
  files: number
  searches: number
  commands: number
  edits: number
  other: number
}

export interface ChatFoldModel {
  entries: ChatActivityEntry[]
  thinkingMs: number
  thinkingRunning: boolean
  thinkingStartedAt?: number
  liveLabel: string
}

function toolMessages(block: ChatTranscriptBlock): Message[] {
  if (block.kind === 'activity') return block.messages
  if (block.kind === 'process') {
    return block.blocks.flatMap(inner => (inner.kind === 'activity' ? inner.messages : []))
  }
  return []
}

interface ChatFoldTurn {
  start: number
  end: number
  workCount: number
  lastWork: string
}

// 渲染循环里每段都问一次「这一段属于哪一轮、谁是 live 锚点、这一轮有几个过程块」。
// 以前每次都要对整份转写做 findIndex + 全表扫锚点（万条级对话里单次渲染上百毫秒）。
// 这里一次扫描把答案都建好，之后 modelFor 只做 O(1) 查表。
interface ChatFoldIndex {
  blocks: readonly ChatTranscriptBlock[]
  indexById: Map<string, number>
  turnStartByIndex: number[]
  turns: Map<number, ChatFoldTurn>
  liveAnchorId: string
}

function buildChatFoldIndex(blocks: readonly ChatTranscriptBlock[]): ChatFoldIndex {
  const indexById = new Map<string, number>()
  for (let cursor = 0; cursor < blocks.length; cursor += 1) {
    const id = blocks[cursor]!.id
    if (!indexById.has(id)) indexById.set(id, cursor)
  }
  // 与旧的 turnBounds 逐字同义：从自己往前找最近的 user 块，起点取它的下一格；
  // 自己就是 user 块时起点是自己下一格。
  const turnStartByIndex: number[] = new Array(blocks.length)
  let lastUser = -1
  for (let cursor = 0; cursor < blocks.length; cursor += 1) {
    const block = blocks[cursor]!
    if (block.kind === 'message' && block.message.role === 'user') {
      turnStartByIndex[cursor] = cursor + 1
      lastUser = cursor
    } else {
      turnStartByIndex[cursor] = lastUser + 1
    }
  }
  const nextUserAtOrAfter: number[] = new Array(blocks.length + 1)
  nextUserAtOrAfter[blocks.length] = blocks.length
  for (let cursor = blocks.length - 1; cursor >= 0; cursor -= 1) {
    const block = blocks[cursor]!
    const isUser = block.kind === 'message' && block.message.role === 'user'
    nextUserAtOrAfter[cursor] = isUser ? cursor : nextUserAtOrAfter[cursor + 1]!
  }
  const turns = new Map<number, ChatFoldTurn>()
  for (let cursor = 0; cursor < blocks.length; cursor += 1) {
    const block = blocks[cursor]!
    const start = turnStartByIndex[cursor]!
    let turn = turns.get(start)
    if (!turn) {
      const isUser = block.kind === 'message' && block.message.role === 'user'
      // 终点是「这一轮里的下一个 user 块」，与旧 turnBounds 的正向扫描一致。
      turn = {
        start,
        end: isUser ? nextUserAtOrAfter[cursor + 1]! : nextUserAtOrAfter[cursor]!,
        workCount: 0,
        lastWork: '',
      }
      turns.set(start, turn)
    }
    if (block.kind === 'process' || block.kind === 'activity') {
      turn.workCount += 1
      turn.lastWork = block.id
    }
  }
  return { blocks, indexById, turnStartByIndex, turns, liveAnchorId: chatLiveAnchorId(blocks) }
}

export function chatLiveAnchorId(blocks: readonly ChatTranscriptBlock[]) {
  let id = ''
  for (const block of blocks) {
    if (block.kind === 'message' && block.message.role === 'user') id = ''
    else if (block.kind === 'process' || block.kind === 'activity') id = block.id
  }
  return id
}

function entryPath(entry: ChatActivityEntry) {
  const source = String(entry.request?.content || entry.result?.content || '')
  const line = source.split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? ''
  return line.split(' · ')[0]?.trim() || line
}

export function chatWorkCounts(entries: readonly ChatActivityEntry[]): ChatWorkCounts {
  const files = new Set<string>()
  let fileAnon = 0
  let searches = 0
  let commands = 0
  let edits = 0
  let other = 0
  for (const entry of entries) {
    const name = entry.toolName.trim().toLowerCase()
    if (name === 'read') {
      const path = entryPath(entry)
      if (path) files.add(path)
      else fileAnon += 1
      continue
    }
    if (searchTools.has(name)) {
      searches += 1
      continue
    }
    if (commandTools.has(name)) {
      commands += 1
      continue
    }
    if (editTools.has(name)) {
      edits += 1
      continue
    }
    if (name === 'subagent') continue
    other += 1
  }
  return { files: files.size + fileAnon, searches, commands, edits, other }
}

function countLabel(count: number, zh: string, one: string, many: string) {
  return t(`${count} ${zh}`, count === 1 ? one : many.replace('%d', String(count)))
}

export function chatWorkTotalsLabel(entries: readonly ChatActivityEntry[], thinkingMs = 0) {
  const counts = chatWorkCounts(entries)
  const parts: string[] = []
  if (thinkingMs >= 500) parts.push(thinkingSummary(thinkingMs))
  if (counts.files) {
    parts.push(countLabel(counts.files, t('个文件', 'files'), '1 file', '%d files'))
  }
  if (counts.searches) {
    parts.push(countLabel(counts.searches, t('次检索', 'searches'), '1 search', '%d searches'))
  }
  if (counts.commands) {
    parts.push(countLabel(counts.commands, t('条命令', 'commands'), '1 command', '%d commands'))
  }
  if (counts.edits) {
    parts.push(countLabel(counts.edits, t('处编辑', 'edits'), '1 edit', '%d edits'))
  }
  if (counts.other) {
    const alongside = parts.length > 0
    parts.push(alongside
      ? countLabel(counts.other, t('次其他调用', 'other calls'), '1 other call', '%d other calls')
      : countLabel(counts.other, t('次工具调用', 'tool calls'), '1 tool call', '%d tool calls'))
  }
  return parts.join(' · ')
}

export function chatLiveActionLabel(entry: ChatActivityEntry) {
  const name = entry.toolName.trim().toLowerCase()
  const pill = agentToolChip(entry).pill.trim()
  if (name === 'bash' || name === 'shell') return t('正在运行命令', 'Running a command')
  if (name === 'background' || name === 'bg_task') return t('正在管理后台任务', 'Managing a background task')
  if (name === 'background_output' || name === 'bg_status') return t('正在查看后台任务', 'Checking a background task')
  if (name === 'milksu_progress') return t('正在更新计划', 'Updating the plan')
  if (name === 'milksu_workspace') return t('正在操作 MilkSU', 'Operating MilkSU')
  if (name === 'read') {
    return pill ? t(`正在读 ${pill}`, `Reading ${pill}`) : t('正在读文件', 'Reading a file')
  }
  if (name === 'grep' || name === 'find' || name === 'ls') {
    return pill ? t(`正在检索 ${pill}`, `Searching ${pill}`) : t('正在检索', 'Searching')
  }
  if (name === 'edit' || name === 'write') {
    return pill ? t(`正在改 ${pill}`, `Editing ${pill}`) : t('正在改文件', 'Editing a file')
  }
  const verb = pill || name || t('工具', 'tool')
  return t(`正在调用 ${verb}`, `Running ${verb}`)
}

function ownThinkingMs(block: ChatTranscriptBlock | undefined): number {
  if (!block) return 0
  const thoughts: Message[] = []
  if (block.kind === 'message') thoughts.push(block.message)
  if (block.kind === 'process') {
    for (const inner of block.blocks) {
      if (inner.kind === 'message') thoughts.push(inner.message)
    }
  }
  return thoughts.reduce(
    (sum, message) => sum + Math.max(0, message.thinkingDurationMs ?? 0),
    0,
  )
}

function foldModel(
  index: ChatFoldIndex,
  blockId: string,
  conversationRunning: boolean,
  now: number,
): ChatFoldModel {
  const blocks = index.blocks
  const at = index.indexById.get(blockId) ?? -1
  const own = at >= 0 ? toolMessages(blocks[at]!) : []
  const ownEntries = buildChatActivityEntries(own)
  const empty: ChatFoldModel = {
    entries: ownEntries,
    thinkingMs: ownThinkingMs(at >= 0 ? blocks[at] : undefined),
    thinkingRunning: false,
    liveLabel: '',
  }
  if (at < 0) return empty
  const turn = index.turns.get(index.turnStartByIndex[at]!)
  if (!turn) return empty
  const live = conversationRunning && index.liveAnchorId === blockId
  const wide = live || (turn.lastWork === blockId && turn.workCount === 1)
  if (!wide) return empty
  const { start, end } = turn

  const messages: Message[] = []
  let thinkingMs = 0
  let thinkingRunning = false
  let thinkingStartedAt: number | undefined
  let replying = false
  const accumulateThinking = (message: Message) => {
    if (message.thinkingStatus === 'running') {
      thinkingRunning = true
      const started = Number(message.timestamp)
      thinkingStartedAt = Number.isFinite(started) ? started : now
    } else if (String(message.thinking ?? '').trim() || message.thinkingDurationMs) {
      thinkingMs += Math.max(0, message.thinkingDurationMs ?? 0)
    }
  }
  for (let cursor = start; cursor < end; cursor += 1) {
    const block = blocks[cursor]!
    if (block.kind === 'activity' || block.kind === 'process') {
      messages.push(...toolMessages(block))
      // Finished thinking now folds into 过程 blocks, so its time has to be
      // picked up from the nested message blocks as well.
      if (block.kind === 'process') {
        for (const inner of block.blocks) {
          if (inner.kind === 'message' && inner.message.role === 'assistant') {
            accumulateThinking(inner.message)
          }
        }
      }
      continue
    }
    if (block.kind !== 'message' || block.message.role !== 'assistant') continue
    accumulateThinking(block.message)
    if (block.message.status === 'running' && String(block.message.content ?? '').trim()) replying = true
  }
  const entries = buildChatActivityEntries(messages)
  const runningEntry = [...entries].reverse().find(entry => entry.running)
  let liveLabel = ''
  if (live) {
    if (runningEntry) liveLabel = chatLiveActionLabel(runningEntry)
    else if (replying) liveLabel = t('正在回复', 'Replying')
  }
  return {
    entries,
    thinkingMs,
    thinkingRunning: live && thinkingRunning,
    thinkingStartedAt: live ? thinkingStartedAt : undefined,
    liveLabel,
  }
}

/**
 * 渲染循环专用的预计算评估器：索引只建一次，之后每段查询 O(1)。
 * ChatPage 用 `useMemo([chatTranscript])` 建一份，在 visibleTranscript 循环里直接取值，
 * 避免下游此前「每段一次全表扫描」的 O(n²)。
 */
export interface ChatFoldEvaluator {
  modelFor(blockId: string, conversationRunning: boolean, now?: number): ChatFoldModel
  /**
   * 这一块的模型只由「块自身内容 + 它在哪一轮 / 是不是 live / 这一轮几个过程块」决定。
   * 块内容不变时，只要这个签名字符串也不变，`modelFor` 的结果就逐字段相同；
   * 调用方据此复用上一次的 model 对象，让下游 `memo`（ChatProcessFold → ChatWorkFold）真正命中。
   */
  modelContextKey(blockId: string, conversationRunning: boolean): string
}

export function createChatFoldEvaluator(blocks: readonly ChatTranscriptBlock[]): ChatFoldEvaluator {
  const index = buildChatFoldIndex(blocks)
  const modelContextKey = (blockId: string, conversationRunning: boolean): string => {
    const at = index.indexById.get(blockId) ?? -1
    if (at < 0) return 'absent'
    const block = blocks[at]!
    const turnStart = index.turnStartByIndex[at]!
    const turn = index.turns.get(turnStart)
    if (!turn) return `turn:none:${turnStart}`
    const live = conversationRunning && index.liveAnchorId === blockId
    const wide = live || (turn.lastWork === blockId && turn.workCount === 1)
    return [
      turn.start,
      turn.end,
      turn.workCount,
      turn.lastWork,
      live ? 1 : 0,
      wide ? 1 : 0,
      block.kind === 'activity' ? (block.running ? 1 : 0) : 0,
    ].join(':')
  }
  return {
    modelFor: (blockId, conversationRunning, now = Date.now()) => (
      foldModel(index, blockId, conversationRunning, now)
    ),
    modelContextKey,
  }
}

// 单次调用的旧签名保留（测试与非渲染路径仍可用）。它每次自建索引，
// 所以**不要在渲染循环里直接调用**——循环里请用 createChatFoldEvaluator。
export function chatFoldModel(
  blocks: readonly ChatTranscriptBlock[],
  blockId: string,
  conversationRunning: boolean,
  now = Date.now(),
): ChatFoldModel {
  return foldModel(buildChatFoldIndex(blocks), blockId, conversationRunning, now)
}

export function chatFoldElapsedLabel(model: ChatFoldModel, now = Date.now()) {
  const extra = model.thinkingRunning && model.thinkingStartedAt != null
    ? Math.max(0, now - model.thinkingStartedAt)
    : 0
  return chatWorkTotalsLabel(model.entries, model.thinkingMs + extra)
}

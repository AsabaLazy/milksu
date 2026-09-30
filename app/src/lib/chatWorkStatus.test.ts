import { describe, expect, it } from 'vitest'
import { buildChatTranscript } from '@/lib/chatActivity'
import { chatFoldModel, chatWorkTotalsLabel, createChatFoldEvaluator } from '@/lib/chatWorkStatus'
import { applyUiLocale } from '@/lib/uiLocale'
import type { Message } from '@/types'

function message(
  id: string,
  role: Message['role'],
  content: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    role,
    content,
    timestamp: 1,
    status: 'done',
    ...extra,
  }
}

describe('chatWorkStatus', () => {
  // 渲染循环用的是预计算评估器（索引建一次、每段 O(1)）；它必须与单次调用的
  // `chatFoldModel` 给出**逐字相同**的结果 —— 否则"性能修好了、显示变了"就白改了。
  it('预计算评估器与单次调用 chatFoldModel 结果一致（多轮 + 两种 running）', () => {
    applyUiLocale('zh')
    const transcript = buildChatTranscript([
      message('u1', 'user', '第一轮'),
      message('a1', 'assistant', '', { thinking: '想一下。', thinkingStatus: 'done', thinkingDurationMs: 300 }),
      message('t1', 'tool', '/repo/a.ts', { toolName: 'read' }),
      message('t2', 'tool', 'npm test', { toolName: 'bash' }),
      message('a2', 'assistant', '第一轮完成。'),
      message('u2', 'user', '第二轮'),
      message('a3', 'assistant', '', { thinking: '还在想。', thinkingStatus: 'running', status: 'running' }),
      message('t3', 'tool', 'src/x.py', { toolName: 'read', status: 'running' }),
      message('u3', 'user', '第三轮'),
      message('t4', 'tool', 'git status', { toolName: 'bash' }),
      message('a4', 'assistant', '结束。'),
    ], false)
    const evaluator = createChatFoldEvaluator(transcript)
    for (const running of [false, true]) {
      for (const block of transcript) {
        const direct = chatFoldModel(transcript, block.id, running, 1_000)
        const cached = evaluator.modelFor(block.id, running, 1_000)
        expect(JSON.stringify(cached), `block=${block.id} running=${running}`)
          .toBe(JSON.stringify(direct))
      }
    }
    expect(evaluator.modelFor('no-such-block', true, 1_000).entries).toEqual([])
  })

  it('counts a finished turn as thinking, files, and commands', () => {
    applyUiLocale('zh')
    const transcript = buildChatTranscript([
      message('u1', 'user', '完成任务'),
      message('a1', 'assistant', '', {
        thinking: '先看仓库。',
        thinkingStatus: 'done',
        thinkingDurationMs: 800,
      }),
      message('a2', 'assistant', '', {
        thinking: '再跑测试。',
        thinkingStatus: 'done',
        thinkingDurationMs: 500,
      }),
      message('t1', 'tool', '/repo/src/app.ts', { toolName: 'read' }),
      message('t2', 'tool', '/repo/src/app.ts', { toolName: 'read' }),
      message('t3', 'tool', 'npm test', { toolName: 'bash' }),
      message('a3', 'assistant', '看完了。'),
    ], false)
    const process = transcript.find(block => block.kind === 'process')
    expect(process?.kind).toBe('process')
    const model = chatFoldModel(transcript, process?.id ?? '', false)
    expect(chatWorkTotalsLabel(model.entries, model.thinkingMs)).toBe('想了 1.3s · 1 个文件 · 1 条命令')
    expect(model.liveLabel).toBe('')
  })

  it('names the running action under the turn totals', () => {
    applyUiLocale('zh')
    const transcript = buildChatTranscript([
      message('u1', 'user', '继续'),
      message('a1', 'assistant', '', {
        thinking: '先看。',
        thinkingStatus: 'done',
        thinkingDurationMs: 800,
      }),
      message('t1', 'tool', 'src/click/_termui_impl.py', { toolName: 'read', status: 'running' }),
    ], true)
    const activity = transcript.find(block => block.kind === 'activity')
    const model = chatFoldModel(transcript, activity?.id ?? '', true)
    expect(chatWorkTotalsLabel(model.entries, model.thinkingMs)).toBe('想了 0.8s · 1 个文件')
    expect(model.liveLabel).toBe('正在读 _termui_impl.py')
    applyUiLocale('en')
    expect(chatFoldModel(transcript, activity?.id ?? '', true).liveLabel).toBe('Reading _termui_impl.py')
    applyUiLocale('zh')
  })

  it('aggregates a merged work stretch into one overview', () => {
    applyUiLocale('zh')
    const transcript = buildChatTranscript([
      message('u1', 'user', '排查问题'),
      message('t1', 'tool', '/repo', { toolName: 'read' }),
      message('a1', 'assistant', '', {
        thinking: '再看测试。',
        thinkingStatus: 'done',
        thinkingDurationMs: 900,
      }),
      message('t2', 'tool', 'npm test', { toolName: 'bash' }),
      message('a2', 'assistant', '', {
        thinking: '还在想。',
        thinkingStatus: 'done',
        thinkingDurationMs: 2500,
      }),
      message('t3', 'tool', 'src/app.ts', { toolName: 'grep' }),
      message('a3', 'assistant', '查完了。'),
    ], false)
    const process = transcript.find(block => block.kind === 'process')
    expect(process?.kind).toBe('process')
    const model = chatFoldModel(transcript, process?.id ?? '', false)
    expect(chatWorkTotalsLabel(model.entries, model.thinkingMs))
      .toBe('想了 3.4s · 1 个文件 · 1 次检索 · 1 条命令')
    expect(model.liveLabel).toBe('')
  })

  it('leaves the live line silent while the model is thinking', () => {
    applyUiLocale('zh')
    const transcript = buildChatTranscript([
      message('u1', 'user', '继续'),
      message('t1', 'tool', '/repo', { toolName: 'read' }),
      message('t2', 'tool', 'pattern', { toolName: 'grep' }),
      message('a1', 'assistant', '', {
        thinking: '还在想。',
        thinkingStatus: 'running',
        status: 'running',
      }),
    ], true)
    const process = transcript.find(block => block.kind === 'process')
    const model = chatFoldModel(transcript, process?.id ?? '', true)
    expect(model.liveLabel).toBe('')
    expect(chatWorkTotalsLabel(model.entries, model.thinkingMs)).toBe('1 个文件 · 1 次检索')
  })
})

// 模型复用靠这个签名：块对象身份没变、签名也没变，才能把上一次的 model 对象还回去。
// 签名一旦漏了该变的维度（比如 live 锚点移动），折叠块就会显示旧状态。
describe('createChatFoldEvaluator.modelContextKey', () => {
  const turn = (index: number) => [
    message(`u-${index}`, 'user', `问题 ${index}`),
    message(`t-${index}`, 'assistant', '', {
      thinking: `第 ${index} 轮思考`,
      thinkingStatus: 'done',
      thinkingDurationMs: 1000,
    }),
    message(`r-${index}`, 'tool', `/repo/file-${index}.ts`, { toolName: 'read', toolCallId: `call-${index}` }),
  ]

  function processIds(messages: Message[]) {
    return buildChatTranscript(messages, true)
      .filter(block => block.kind === 'process')
      .map(block => block.id)
  }

  it('keeps an untouched early block’s key stable when the tail grows', () => {
    const before = createChatFoldEvaluator(buildChatTranscript([...turn(0), ...turn(1)], true))
    const afterMessages = [...turn(0), ...turn(1), ...turn(2)]
    const after = createChatFoldEvaluator(buildChatTranscript(afterMessages, true))
    const early = processIds([...turn(0), ...turn(1)])[0]!
    expect(after.modelContextKey(early, true)).toBe(before.modelContextKey(early, true))

    // 上一轮的 live 块会因为 live 锦点移走而变签名 —— 这正是必要的重算。
    const wasLive = processIds([...turn(0), ...turn(1)])[1]!
    expect(after.modelContextKey(wasLive, true)).not.toBe(before.modelContextKey(wasLive, true))
  })

  it('changes when the conversation stops running', () => {
    const messages = [...turn(0), ...turn(1)]
    const evaluator = createChatFoldEvaluator(buildChatTranscript(messages, true))
    const live = processIds(messages)[1]!
    expect(evaluator.modelContextKey(live, false)).not.toBe(evaluator.modelContextKey(live, true))
  })

  it('returns absent for an unknown block', () => {
    const evaluator = createChatFoldEvaluator(buildChatTranscript(turn(0), true))
    expect(evaluator.modelContextKey('nope', true)).toBe('absent')
  })
})

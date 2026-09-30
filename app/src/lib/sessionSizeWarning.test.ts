import { describe, expect, it } from 'vitest'
import type { Message } from '@/types'
import {
  MAX_DISMISSED_SESSION_SIZE_KEYS,
  SESSION_SIZE_DISMISS_STORAGE_KEY,
  SESSION_SIZE_WARNING_BYTES,
  formatSessionSize,
  messageSizeChars,
  readDismissedSessionSizeKeys,
  sessionPendingContextChars,
  sessionSizeReport,
  sessionSizeWarningKey,
  writeDismissedSessionSizeKeys,
} from './sessionSizeWarning'

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    ...overrides,
  }
}

describe('sessionSizeWarning', () => {
  it('does not warn for a small conversation', () => {
    const messages = [message({ content: 'hello' }), message({ role: 'user', content: 'hi' })]
    const report = sessionSizeReport(messages)
    expect(report.over).toBe(false)
    expect(report.chars).toBeLessThan(SESSION_SIZE_WARNING_BYTES)
  })

  it('warns once the pending context crosses the threshold', () => {
    const messages = [message({ content: 'x'.repeat(SESSION_SIZE_WARNING_BYTES) })]
    const report = sessionSizeReport(messages)
    expect(report.over).toBe(true)
    expect(report.ratio).toBeGreaterThanOrEqual(1)
  })

  it('counts thinking, tool names, approval input and attachment bytes', () => {
    const withExtras = messageSizeChars(message({
      content: 'c'.repeat(100),
      thinking: 't'.repeat(50),
      toolName: 'bash',
      toolCallId: 'call_1',
      approvalInput: 'a'.repeat(20),
    }))
    const contentOnly = messageSizeChars(message({ content: 'c'.repeat(100) }))
    expect(withExtras).toBeGreaterThan(contentOnly)

    const bytes = sessionPendingContextChars([
      message({ attachments: [{ id: 'a', name: 'n', mediaType: 'image/png', size: 5_000_000, sha256: 'x' }] }),
    ])
    expect(bytes).toBeGreaterThanOrEqual(5_000_000)
  })

  it('handles missing or empty inputs without throwing', () => {
    expect(sessionPendingContextChars(undefined)).toBe(0)
    expect(sessionPendingContextChars([])).toBe(0)
    expect(sessionSizeReport(undefined).over).toBe(false)
  })

  it('formats sizes for the banner copy', () => {
    expect(formatSessionSize(512)).toBe('512 B')
    expect(formatSessionSize(2048)).toBe('2 KB')
    expect(formatSessionSize(2 * 1024 * 1024)).toBe('2 MB')
    expect(formatSessionSize(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })

  it('re-arms the dismissal once the conversation grows another tier', () => {
    const small = sessionSizeReport([message({ content: 'x'.repeat(SESSION_SIZE_WARNING_BYTES) })])
    const bigger = sessionSizeReport([message({ content: 'x'.repeat(SESSION_SIZE_WARNING_BYTES * 3) })])
    expect(sessionSizeWarningKey('conv', small)).not.toBe(sessionSizeWarningKey('conv', bigger))
    expect(sessionSizeWarningKey('a', small)).not.toBe(sessionSizeWarningKey('b', small))
  })
})

describe('dismissed session-size warnings persist across restarts', () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial))
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value) },
    }
  }

  it('round-trips the dismissed tiers through storage', () => {
    const storage = fakeStorage()
    writeDismissedSessionSizeKeys(['conv:1', 'conv:2'], storage)
    expect(readDismissedSessionSizeKeys(storage)).toEqual(new Set(['conv:1', 'conv:2']))
  })

  it('reads an empty set when nothing was written or the payload is malformed', () => {
    expect(readDismissedSessionSizeKeys(fakeStorage()).size).toBe(0)
    expect(readDismissedSessionSizeKeys(fakeStorage({ [SESSION_SIZE_DISMISS_STORAGE_KEY]: '{oops' })).size).toBe(0)
    expect(readDismissedSessionSizeKeys(fakeStorage({ [SESSION_SIZE_DISMISS_STORAGE_KEY]: '"nope"' })).size).toBe(0)
    expect(readDismissedSessionSizeKeys(fakeStorage({ [SESSION_SIZE_DISMISS_STORAGE_KEY]: '["ok", 7, null]' })))
      .toEqual(new Set(['ok']))
  })

  it('drops non-string entries and keeps only the newest capped tiers', () => {
    const keys = Array.from({ length: MAX_DISMISSED_SESSION_SIZE_KEYS + 25 }, (_, index) => `conv:${index}`)
    const storage = fakeStorage()
    writeDismissedSessionSizeKeys(keys, storage)
    const restored = readDismissedSessionSizeKeys(storage)
    expect(restored.size).toBe(MAX_DISMISSED_SESSION_SIZE_KEYS)
    // 淘汰最旧的：最新的那档一定还在，最早的已经不在了。
    expect(restored.has(`conv:${keys.length - 1}`)).toBe(true)
    expect(restored.has('conv:0')).toBe(false)
  })

  it('degrades to an empty set when storage throws (private mode / quota)', () => {
    const throwing = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readDismissedSessionSizeKeys(throwing).size).toBe(0)
    expect(() => writeDismissedSessionSizeKeys(['conv:1'], throwing)).not.toThrow()
  })
})

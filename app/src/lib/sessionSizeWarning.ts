import type { Message } from '@/types'

/**
 * 会话过胖预警：待发上下文超过阈值时，界面给出非阻断式提示。
 *
 * 起因（2026-09-29）：旧 Dev Extend 会话（91MB）每次请求都要上传数 MB，
 * 首字节必然被拖长、请求更容易失败。预警 ≠ 阻断：读者可以选择继续用。
 *
 * 口径：沿用本仓库既有的「`JSON.stringify(...).length`」字节近似（见
 * composerDraftStore / composerQuoteStore），按字符数计；正文、思考、工具名与
 * 附件大小都算进去。阈值集中在这一处，改动只在这。
 */
export const SESSION_SIZE_WARNING_BYTES = 2 * 1024 * 1024

/** 每条消息的 JSON 结构开销（id / role / 时间戳 / 键名）粗估，避免只看正文长度。 */
const MESSAGE_STRUCTURE_OVERHEAD = 192

export interface SessionSizeReport {
  chars: number
  threshold: number
  over: boolean
  /** chars / threshold，用于「每再涨一档重新提醒一次」。 */
  ratio: number
}

export function messageSizeChars(message: Message): number {
  return (
    MESSAGE_STRUCTURE_OVERHEAD
    + (message.content?.length ?? 0)
    + (message.thinking?.length ?? 0)
    + (message.approvalInput?.length ?? 0)
    + (message.toolName?.length ?? 0)
    + (message.toolCallId?.length ?? 0)
  )
}

/** 只做 O(消息数) 的长度相加，不 stringify：万条会话也能在渲染里安全调用。 */
export function sessionPendingContextChars(messages: readonly Message[] | undefined): number {
  let chars = 0
  for (const message of messages ?? []) {
    if (!message) continue
    chars += messageSizeChars(message)
    for (const attachment of message.attachments ?? []) {
      chars += Number(attachment?.size ?? 0)
    }
  }
  return chars
}

export function sessionSizeReport(
  messages: readonly Message[] | undefined,
  threshold = SESSION_SIZE_WARNING_BYTES,
): SessionSizeReport {
  const chars = sessionPendingContextChars(messages)
  const safeThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : SESSION_SIZE_WARNING_BYTES
  return {
    chars,
    threshold: safeThreshold,
    over: chars >= safeThreshold,
    ratio: chars / safeThreshold,
  }
}

export function formatSessionSize(chars: number): string {
  const value = Number.isFinite(chars) ? Math.max(0, chars) : 0
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
  }
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${Math.round(value)} B`
}

/**
 * 关闭当前这档提示的 key：会话每再涨一个阈值档，就允许重新提醒一次
 * （读者点过「知道了」不代表更大的会话也不该提醒）。
 */
export function sessionSizeWarningKey(conversationId: string, report: SessionSizeReport): string {
  return `${conversationId}:${Math.floor(report.ratio)}`
}

/**
 * 「知道了」关掉的档位要能扛住重启：原来只存在 ChatPage 的 useState 里，重开就丢，
 * 同一档预警又冒出来。这里落盘到 localStorage，键沿用 sessionSizeWarningKey 的格式。
 * 上限只是防无限增长；键都很短（会话 id + 档位），到不了配额。
 */
export const SESSION_SIZE_DISMISS_STORAGE_KEY = 'milksu.session-size-dismissed.v1'
export const MAX_DISMISSED_SESSION_SIZE_KEYS = 200

function warningStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage ?? null
  } catch {
    // 隐私模式 / 配额：读不到就退化成「没关过」，写成纯内存态，不影响预警本身。
    return null
  }
}

function normalizeDismissedKeys(values: Iterable<string>): string[] {
  return [...values]
    .filter(value => typeof value === 'string' && value.length > 0)
    .slice(-MAX_DISMISSED_SESSION_SIZE_KEYS)
}

export function readDismissedSessionSizeKeys(
  storage: Pick<Storage, 'getItem'> | null = warningStorage(),
): Set<string> {
  try {
    const raw = storage?.getItem(SESSION_SIZE_DISMISS_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(normalizeDismissedKeys(parsed as string[]))
  } catch {
    return new Set()
  }
}

export function writeDismissedSessionSizeKeys(
  keys: Iterable<string>,
  storage: Pick<Storage, 'setItem'> | null = warningStorage(),
): void {
  try {
    storage?.setItem(SESSION_SIZE_DISMISS_STORAGE_KEY, JSON.stringify(normalizeDismissedKeys(keys)))
  } catch {
    // 落盘失败不该阻断交互：内存里的这份仍然生效。
  }
}

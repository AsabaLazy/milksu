/** Round a measured chrome box. Missing or negative heights stay at zero. */
export function chatEdgeChromePx(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 0
  return Math.round(height)
}

/** Pixel inset for the top bar and the bottom dock. */
export function applyChatEdgeChrome(
  column: HTMLElement,
  chrome: { top: number; bottom: number; frostBottom?: number },
) {
  column.style.setProperty('--chat-edge-top', `${chatEdgeChromePx(chrome.top)}px`)
  column.style.setProperty('--chat-edge-bottom', `${chatEdgeChromePx(chrome.bottom)}px`)
  column.style.setProperty(
    '--chat-edge-frost-bottom',
    `${chatEdgeChromePx(chrome.frostBottom ?? chrome.bottom)}px`,
  )
}

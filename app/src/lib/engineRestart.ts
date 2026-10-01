/**
 * 「sidecar 不响应 abort」的判据，以及「重启引擎」这个读者动作的开关。
 *
 * 场景（2026-09-29 真事，上游 #208 评审留言）：一次模型请求挂死，读者点重试。
 * 重试先发 `abort_session`，再重发 prompt。但挂死的 sidecar 已经不再读 stdin，
 * abort 只是写进了一个没人收的管道；重发的 prompt 排在挂死 prompt 之后，永远轮不到。
 * 真正的兜底是重启 sidecar：新进程没有那段挂死的历史，重发就能跑起来。
 *
 * 判据（满足任一条即算不响应）：
 *   1. 心跳已停（`engine-gone`）。心跳都断了，abort 无处投递。
 *   2. 心跳还在（`model-stalled`），但 abort 发出满 `abortResponseGraceMs` 后，
 *      这个会话再没有任何新的流事件（心跳不算进展），回合仍在跑。
 *
 * 阈值集中在 `ENGINE_RESTART_DEFAULTS`，可用 `VITE_MILKSU_ABORT_RESPONSE_GRACE_MS` 覆盖。
 * 15s 的依据：正常 abort 的回应是本地 IPC 加一次进程内取消，毫秒级；15s 已经比正常回应
 * 大三个数量级，再等只会浪费读者时间。
 *
 * 只做判定，不做动作：重启是**读者亲手点**的，这个模块不许自动重启任何东西。
 */
import type { TurnStallKind } from '@/lib/turnStall'

export interface EngineRestartConfig {
  /** abort_session 发出后多久没有新事件，就算 sidecar 不响应。 */
  abortResponseGraceMs: number
}

export const ENGINE_RESTART_DEFAULTS: EngineRestartConfig = {
  abortResponseGraceMs: 15_000,
}

/** 非法值（NaN / <= 0）一律退回默认。 */
function readPositive(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function resolveEngineRestartConfig(
  source: Record<string, unknown> | undefined = (import.meta as { env?: Record<string, unknown> } | undefined)?.env,
): EngineRestartConfig {
  return {
    abortResponseGraceMs: readPositive(
      source?.VITE_MILKSU_ABORT_RESPONSE_GRACE_MS,
      ENGINE_RESTART_DEFAULTS.abortResponseGraceMs,
    ),
  }
}

export function decideEngineRestart(input: {
  /** 这个对话现在是不是还在跑。 */
  running: boolean
  /** 看门狗给出的停滞类型；空串 = 没停滞。 */
  stallKind: TurnStallKind
  /** 最近一次 `abort_session` 发出的时刻；没发过为 0。 */
  abortSentAt: number
  /** 这个对话最后一次流事件的时刻（心跳不算进展）；没有过为 0。 */
  lastEventAt: number
  now?: number
  config?: EngineRestartConfig
}): boolean {
  const config = input.config ?? ENGINE_RESTART_DEFAULTS
  if (!input.running) return false
  // 心跳已停：进程大概率没了，abort 无从投递。这是最硬的一条判据。
  if (input.stallKind === 'engine-gone') return true
  if (input.stallKind !== 'model-stalled') return false
  if (!input.abortSentAt) return false
  const now = input.now ?? Date.now()
  if (now - input.abortSentAt < config.abortResponseGraceMs) return false
  // abort 之后有过新事件 ⇒ 进程其实还在响应，不给重启入口（那是进展，不是挂死）。
  return input.lastEventAt < input.abortSentAt
}

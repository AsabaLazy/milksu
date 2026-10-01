/**
 * 回合停滞看门狗的阈值集中处。
 *
 * 场景（2026-09-29 00:40 真事）：一次模型请求挂死，会话状态永远 running，界面一直转圈，
 * 没有超时、没有报错、也没有自愈。两种死法症状一样，都是「在跑，但引擎一个事件都不发」：
 *
 *   1. 连接死了但状态活着：底层请求已断（无 socket、无重试），回合却永不收尾；
 *   2. 流式停滞：连接还在，但长时间 0 token（模型侧卡死 / 代理挂起）。
 *
 * 把两件事分开，才能既不装活也不误伤：
 *   - **进展时钟**：最后一次引擎事件（token / thinking / 工具输出）到现在有多久。
 *     心跳不算进展——心跳只能说「进程还在」，不能把停滞时钟清零。
 *   - **心跳**：sidecar 在回合进行中每 5 秒发一次 turn.heartbeat，证明引擎进程没有
 *     被卡死 / 退出。它决定的是**措辞和可用的动作**，不是「还活着就不算停滞」：
 *     进程还在但请求静默太久，同样要报停滞（不然真事里的死连接永远报不出来）。
 *
 * 阈值都在这里，改一个地方即可。默认值取保守值（静默 18s 才停止说「模型正在回复」，
 * 120s 才判请求停滞），并用 VITE_ 环境变量允许按机器覆盖。
 *
 * 误伤防护：只要有工具在跑（tool.started 到 tool.completed 之间），看门狗一律闭嘴；
 * 排在同一个 sidecar 的另一个会话后面是「排队」，也不是停滞。这两条在 composable 里判。
 */
export interface TurnStallConfig {
  /** 距最后一次引擎事件多久算「安静」——界面不再说「模型正在回复」。 */
  quietMs: number
  /** 心跳多久没来就不再信任「引擎进程还在」。 */
  heartbeatGraceMs: number
  /** 心跳已停 + 静默达到这个时长 ⇒ 引擎进程大概率没了（engine-gone）。 */
  engineGoneMs: number
  /** 心跳还在 + 静默达到这个时长且没有工具在跑 ⇒ 这条请求停滞了（model-stalled）。 */
  modelStallMs: number
}

export const TURN_STALL_DEFAULTS: TurnStallConfig = {
  quietMs: 18_000,
  heartbeatGraceMs: 15_000,
  engineGoneMs: 45_000,
  modelStallMs: 120_000,
}

/** 一次 readPositive 的兜底：非法值（NaN / <= 0）一律退回默认。 */
function readPositive(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function resolveTurnStallConfig(
  source: Record<string, unknown> | undefined = (import.meta as { env?: Record<string, unknown> } | undefined)?.env,
): TurnStallConfig {
  return {
    quietMs: readPositive(source?.VITE_MILKSU_TURN_QUIET_MS, TURN_STALL_DEFAULTS.quietMs),
    heartbeatGraceMs: readPositive(source?.VITE_MILKSU_HEARTBEAT_GRACE_MS, TURN_STALL_DEFAULTS.heartbeatGraceMs),
    engineGoneMs: readPositive(source?.VITE_MILKSU_ENGINE_GONE_MS, TURN_STALL_DEFAULTS.engineGoneMs),
    modelStallMs: readPositive(source?.VITE_MILKSU_MODEL_STALL_MS, TURN_STALL_DEFAULTS.modelStallMs),
  }
}

/** 停滞类型：空串 = 没停滞。engine-gone 心跳已停；model-stalled 心跳还在但请求静默。 */
export type TurnStallKind = '' | 'engine-gone' | 'model-stalled'

/**
 * 纯函数判定，方便直接测：
 * - 不在跑 ⇒ 空串；
 * - 有工具在跑 / 在排队 ⇒ 空串（误伤防护，由调用方算好这两个布尔传进来）；
 * - 引擎自己报了预算告警（`engineWarned`）且心跳还在 ⇒ model-stalled，不等静默门槛：
 *   sidecar 只在请求真的超过它按体积算出的预算时才报警，这比本地计时器更权威；
 *   心跳已停则仍走 engine-gone，不能说「进程还在」；
 * - 从没有过事件、安静没到门槛 ⇒ 空串；
 * - 心跳已停且静默 ≥ engineGoneMs ⇒ engine-gone；
 * - 心跳还在且静默 ≥ modelStallMs ⇒ model-stalled；
 * - 其余（安静但没到停滞门槛）⇒ 空串（界面只说「等待中」）。
 */
export function decideTurnStall(input: {
  running: boolean
  toolRunning: boolean
  queuedBehind: boolean
  engineAlive: boolean
  /** sidecar 的 turn.stall_warning 还没被新事件清掉：请求已超过它自己的预算。 */
  engineWarned?: boolean
  /** 距最后一次引擎事件的毫秒数；从未有过事件时为 0，调用方需用 hasEvent 区分。 */
  quietMs: number
  hasEvent: boolean
  config?: TurnStallConfig
}): TurnStallKind {
  const config = input.config ?? TURN_STALL_DEFAULTS
  if (!input.running) return ''
  if (input.toolRunning || input.queuedBehind) return ''
  if (input.engineWarned && input.engineAlive) return 'model-stalled'
  if (!input.hasEvent) return ''
  if (input.quietMs < config.quietMs) return ''
  if (input.engineAlive) {
    return input.quietMs >= config.modelStallMs ? 'model-stalled' : ''
  }
  return input.quietMs >= config.engineGoneMs ? 'engine-gone' : ''
}

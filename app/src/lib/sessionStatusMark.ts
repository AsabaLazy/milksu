/**
 * 侧栏状态位的形态判定（显示层，纯函数）。
 *
 * 一行**只亮一个**标记，优先级（用户拍板 2026-09-30）：
 *   待决策 > 运行中 > 后台任务 > 红叉 > 未读
 *
 * 红叉排第四：它是"上一轮出过事"的墓碑，只有会话**一切静止**
 * （没有待决策、没有回合在跑、没有后台任务）时才亮 —— 任何"活迹象"都让它让位。
 * 这里只决定侧栏显示；`problemTurns` / `agentProblem` 状态与对话内的
 * problem-bar 横幅不受影响（横幅留到「知道了」或新回合）。
 */
export type SessionStatusMark = 'decision' | 'running' | 'background' | 'problem' | 'unread'

export interface SessionStatusMarkState {
  /** 会话里有未决的审批 / ask（在等用户拍板）。 */
  needsDecision: boolean
  /** 这一轮正在跑（assistant 正在生成）。 */
  running: boolean
  /** 会话有后台任务在跑（事实层只关心"有没有"）。 */
  hasBackgroundTask: boolean
  /** 上一轮被守卫强制终止（侧栏红叉）。 */
  problem: boolean
  /** 有未读的新消息。 */
  unread: boolean
}

export function resolveSessionStatusMark(state: SessionStatusMarkState): SessionStatusMark | null {
  if (state.needsDecision) return 'decision'
  if (state.running) return 'running'
  if (state.hasBackgroundTask) return 'background'
  if (state.problem) return 'problem'
  if (state.unread) return 'unread'
  return null
}

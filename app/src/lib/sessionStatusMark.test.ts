import { describe, expect, it } from 'vitest'
import {
  resolveSessionStatusMark,
  type SessionStatusMark,
  type SessionStatusMarkState,
} from '@/lib/sessionStatusMark'

// 优先级（用户拍板）：待决策 > 运行中 > 后台任务 > 红叉 > 未读。
const PRIORITY: Array<{ key: keyof SessionStatusMarkState; mark: SessionStatusMark }> = [
  { key: 'needsDecision', mark: 'decision' },
  { key: 'running', mark: 'running' },
  { key: 'hasBackgroundTask', mark: 'background' },
  { key: 'problem', mark: 'problem' },
  { key: 'unread', mark: 'unread' },
]

const KEYS = PRIORITY.map(entry => entry.key)

/** bit 0..4 依次代表待决策 / 运行中 / 后台任务 / 红叉 / 未读。 */
function stateFrom(bits: number): SessionStatusMarkState {
  const flag = (index: number) => Boolean(bits & (1 << index))
  return {
    needsDecision: flag(0),
    running: flag(1),
    hasBackgroundTask: flag(2),
    problem: flag(3),
    unread: flag(4),
  }
}

function expectedFrom(state: SessionStatusMarkState): SessionStatusMark | null {
  for (const entry of PRIORITY) if (state[entry.key]) return entry.mark
  return null
}

describe('resolveSessionStatusMark 优先级矩阵', () => {
  it('穷举全部 32 种组合，都只亮优先级最高的那一个', () => {
    for (let bits = 0; bits < 32; bits += 1) {
      const state = stateFrom(bits)
      expect(resolveSessionStatusMark(state), `bits=${bits} state=${JSON.stringify(state)}`).toBe(
        expectedFrom(state),
      )
    }
  })

  it('两两组合：永远是优先级高的那个赢，另一个不亮', () => {
    for (let i = 0; i < KEYS.length; i += 1) {
      for (let j = i + 1; j < KEYS.length; j += 1) {
        const state: SessionStatusMarkState = {
          needsDecision: false,
          running: false,
          hasBackgroundTask: false,
          problem: false,
          unread: false,
        }
        state[KEYS[i]] = true
        state[KEYS[j]] = true
        // 低优先级在前、高优先级在后，先命中的就是赢家。
        expect(resolveSessionStatusMark(state), `${KEYS[i]} + ${KEYS[j]}`).toBe(expectedFrom(state))
      }
    }
  })

  it('没有任何迹象时不亮状态位', () => {
    expect(resolveSessionStatusMark(stateFrom(0))).toBeNull()
  })

  it('红叉只在一切静止时亮：任一活迹象在场都把它压下去', () => {
    // 静止：只有红叉（或红叉 + 未读）→ 红叉亮。
    expect(resolveSessionStatusMark(stateFrom(0b1000))).toBe('problem')
    expect(resolveSessionStatusMark(stateFrom(0b11000))).toBe('problem')
    // 有活迹象 → 红叉让位。
    expect(resolveSessionStatusMark(stateFrom(0b1001))).toBe('decision')
    expect(resolveSessionStatusMark(stateFrom(0b1010))).toBe('running')
    expect(resolveSessionStatusMark(stateFrom(0b1100))).toBe('background')
  })
})

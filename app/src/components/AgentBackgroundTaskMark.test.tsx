// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import AgentBackgroundTaskMark from '@/components/AgentBackgroundTaskMark'

// 用户给出的形态：**同一套九格**（尺寸与运行中/待决标一致），点亮一条 **Z 形**路径 ——
// 上排三格填满 + 中间一格 + 下排三格填满（行优先索引 0,1,2 → 4 → 6,7,8），颜色**蓝色**。
describe('AgentBackgroundTaskMark', () => {
  it('keeps nine slots and lights exactly the seven on the path', () => {
    const { container } = render(<AgentBackgroundTaskMark />)
    const slots = Array.from(container.querySelectorAll('.agent-pixel > span'))
    const lit = slots
      .map((slot, index) => (slot.classList.contains('agent-pixel__cell') ? index : -1))
      .filter(index => index >= 0)
    expect(slots).toHaveLength(9)
    expect(lit).toEqual([0, 1, 2, 4, 6, 7, 8])
  })

  it('is blue on the lit cells only, and announces itself as a status', () => {
    const { container } = render(<AgentBackgroundTaskMark />)
    // 蓝色只跟着点亮的格子走：容器着色会让未点亮的格子（透明）也泛蓝 ✗（真机截图证实）。
    expect(container.querySelector('.agent-pixel--bg-task')?.classList.contains('bg-blue-400')).toBe(false)
    expect(container.querySelectorAll('.agent-pixel__cell--bg-task.bg-blue-400')).toHaveLength(7)
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBeTruthy()
    expect(container.querySelector('button')).toBeNull()
  })
})

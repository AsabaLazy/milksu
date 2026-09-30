// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import AgentDecisionMark from '@/components/AgentDecisionMark'

afterEach(cleanup)

// 用工作目录相对路径读源文件：jsdom 环境里 import.meta.url 不是 file 协议。
const rawCss = readFileSync(resolve(process.cwd(), 'src/styles/agent-conversation.css'), 'utf8')
// 先把注释剥掉：注释里出现的 `{` / `}` 会让朴素的规则解析提前截断。
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

function ruleBody(selector: string) {
  const start = css.indexOf(selector)
  if (start < 0) return ''
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return open < 0 || close < 0 ? '' : css.slice(open + 1, close)
}

describe('needs-decision mark', () => {
  it('reuses the shared 3×3 grid: eight cells around an empty centre', () => {
    const { container } = render(<AgentDecisionMark />)
    expect(container.querySelectorAll('.agent-pixel')).toHaveLength(1)
    const cells = container.querySelectorAll('.agent-pixel__cell')
    expect(cells).toHaveLength(8)
    const slots = container.querySelectorAll('.agent-pixel > *')
    expect(slots).toHaveLength(9)
    expect(slots[4]?.className).toContain('agent-pixel__cell--hole')
    expect(slots[4]?.className).not.toContain('agent-pixel__cell ')
  })

  // 待决策要「停下来等你」：基类加了运行中的 650ms 快跳之后，这里必须显式关掉，
  // 否则琥珀环会跟着跑马灯。动画按仓库惯例挂在 `prefers-reduced-motion: no-preference` 里。
  it('opts out of the running animation', () => {
    const mediaStart = css.indexOf('prefers-reduced-motion: no-preference', css.indexOf('.agent-pixel__cell'))
    expect(mediaStart).toBeGreaterThan(-1)
    const cellInMedia = css.indexOf('.agent-pixel__cell {', mediaStart)
    expect(cellInMedia).toBeGreaterThan(-1)
    const open = css.indexOf('{', cellInMedia)
    const close = css.indexOf('}', open)
    expect(css.slice(open + 1, close)).toContain('agent-pixel-on 650ms')
    const decision = ruleBody('.agent-pixel--decision .agent-pixel__cell {')
    expect(decision).toContain('animation: none')
  })

  // 中心留空必须仍然是「空」：透明、且不带会被上色规则命中的类。
  it('keeps the centre hole transparent', () => {
    const hole = ruleBody('.agent-pixel__cell--hole {')
    expect(hole).toContain('background: transparent')
    const { container } = render(<AgentDecisionMark />)
    const slots = container.querySelectorAll('.agent-pixel > *')
    expect(slots[4]?.className).toContain('agent-pixel__cell--hole')
    expect(slots[4]?.className).not.toContain('agent-pixel__cell--decision')
  })

  it('announces itself as a status with a bilingual label', () => {
    render(<AgentDecisionMark />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('需要你决定')
    render(<AgentDecisionMark label="Needs your decision" />)
    expect(screen.getAllByRole('status')[1]?.getAttribute('aria-label')).toBe('Needs your decision')
  })
})

// 「这个对话遇到了问题」：同一套 3×3 网格，但画成**红色的叉**
// （左上/右上/中心/左下/右下 = 0/2/4/6/8），其余四格留空。
describe('problem mark', () => {
  it('draws an X: five cells at the corners and the centre, four holes elsewhere', () => {
    const { container } = render(<AgentDecisionMark variant="problem" />)
    expect(container.querySelectorAll('.agent-pixel--problem')).toHaveLength(1)
    expect(container.querySelectorAll('.agent-pixel__cell')).toHaveLength(5)
    expect(container.querySelectorAll('.agent-pixel__cell--problem')).toHaveLength(5)
    expect(container.querySelectorAll('.agent-pixel__cell--hole')).toHaveLength(4)
    // 不能蹭「待决策」那套颜色：红叉和琥珀圈是两种意思。
    expect(container.querySelectorAll('.agent-pixel__cell--decision')).toHaveLength(0)
    // 必须是那五格（四角 + 中心），不是随便五格。
    const slots = container.querySelectorAll('.agent-pixel > *')
    for (const index of [0, 2, 4, 6, 8]) {
      expect(slots[index]?.className).toContain('agent-pixel__cell--problem')
    }
    for (const index of [1, 3, 5, 7]) {
      expect(slots[index]?.className).toContain('agent-pixel__cell--hole')
    }
  })

  it('is red and still (not the running marquee)', () => {
    const wrap = ruleBody('.agent-pixel--problem {')
    expect(wrap).toContain('animation: none')
    const cell = ruleBody('.agent-pixel--problem .agent-pixel__cell {')
    expect(cell).toContain('animation: none')
    expect(cell).toContain('var(--color-red-500)')
  })

  it('names the state for screen readers', () => {
    render(<AgentDecisionMark variant="problem" />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toContain('遇到了问题')
  })
})

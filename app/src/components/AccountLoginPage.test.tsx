// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockToggleWindowMaximize = vi.fn()
vi.mock('@/lib/hostPlatform', () => ({
  toggleWindowMaximize: () => mockToggleWindowMaximize(),
  attachWindowMaximizeDblClick: (target: EventTarget = window) => {
    const onDblClick = (event: Event) => {
      const el = event.target
      if (!(el instanceof Element)) return
      if (el.closest('.app-no-drag, button, input, select, textarea, a, [data-no-drag]')) return
      if (el.closest('.app-drag')) {
        mockToggleWindowMaximize()
      }
    }
    target.addEventListener('dblclick', onDblClick)
    return () => target.removeEventListener('dblclick', onDblClick)
  },
}))

import { attachWindowMaximizeDblClick } from '@/lib/hostPlatform'
import AccountLoginPage from './AccountLoginPage'

describe('AccountLoginPage window drag', () => {
  let detach: () => void

  beforeEach(() => {
    detach = attachWindowMaximizeDblClick(window)
  })

  afterEach(() => {
    detach?.()
    cleanup()
    vi.clearAllMocks()
  })

  it('renders WindowTopDragRegion and draggable background', () => {
    const { container } = render(
      <AccountLoginPage
        status={{ state: 'unauthorized' }}
        busy={false}
      />,
    )
    const main = container.querySelector('main')
    expect(main).not.toBeNull()
    expect(main?.classList.contains('app-drag')).toBe(true)

    const dragRegion = container.querySelector('.window-top-drag-region')
    expect(dragRegion).not.toBeNull()
  })

  it('triggers maximize on double-clicking background', () => {
    const { container } = render(
      <AccountLoginPage
        status={{ state: 'unauthorized' }}
        busy={false}
      />,
    )
    const main = container.querySelector('main')
    expect(main).not.toBeNull()
    fireEvent.doubleClick(main!)
    expect(mockToggleWindowMaximize).toHaveBeenCalledTimes(1)
  })

  it('does not trigger maximize when double-clicking interactive form elements', () => {
    const { container } = render(
      <AccountLoginPage
        status={{ state: 'unauthorized' }}
        busy={false}
      />,
    )
    const input = container.querySelector('#account-username')
    expect(input).not.toBeNull()
    fireEvent.doubleClick(input!)
    expect(mockToggleWindowMaximize).not.toHaveBeenCalled()
  })
})

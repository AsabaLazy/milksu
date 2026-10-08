// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockToggleWindowMaximize = vi.fn()
vi.mock('@/lib/hostPlatform', () => ({
  toggleWindowMaximize: () => mockToggleWindowMaximize(),
}))

import AccountLoginPage from './AccountLoginPage'

describe('AccountLoginPage window drag', () => {
  afterEach(() => {
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

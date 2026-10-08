// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockToggleWindowMaximize = vi.fn()
vi.mock('@/lib/hostPlatform', () => ({
  toggleWindowMaximize: () => mockToggleWindowMaximize(),
}))

import WindowTopDragRegion from './WindowTopDragRegion'

describe('WindowTopDragRegion', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders standard classes and aria-hidden', () => {
    const { container } = render(<WindowTopDragRegion className="custom-test" />)
    const element = container.firstElementChild as HTMLElement
    expect(element.classList.contains('window-top-drag-region')).toBe(true)
    expect(element.classList.contains('app-drag')).toBe(true)
    expect(element.classList.contains('custom-test')).toBe(true)
    expect(element.getAttribute('aria-hidden')).toBe('true')
  })

  it('calls toggleWindowMaximize on double click', () => {
    const { container } = render(<WindowTopDragRegion />)
    const element = container.firstElementChild as HTMLElement
    fireEvent.doubleClick(element)
    expect(mockToggleWindowMaximize).toHaveBeenCalledTimes(1)
  })

  it('respects defaultPrevented in custom onDoubleClick', () => {
    const { container } = render(
      <WindowTopDragRegion
        onDoubleClick={event => {
          event.preventDefault()
        }}
      />,
    )
    const element = container.firstElementChild as HTMLElement
    fireEvent.doubleClick(element)
    expect(mockToggleWindowMaximize).not.toHaveBeenCalled()
  })
})

import { toggleWindowMaximize } from '@/lib/hostPlatform'
import { cn } from '@/lib/cn'
import type { HTMLAttributes } from 'react'

export interface WindowTopDragRegionProps extends HTMLAttributes<HTMLDivElement> {}

export default function WindowTopDragRegion({
  className,
  onDoubleClick,
  ...props
}: WindowTopDragRegionProps) {
  return (
    <div
      className={cn('window-top-drag-region app-drag', className)}
      aria-hidden="true"
      onDoubleClick={event => {
        onDoubleClick?.(event)
        if (!event.defaultPrevented) {
          toggleWindowMaximize()
        }
      }}
      {...props}
    />
  )
}

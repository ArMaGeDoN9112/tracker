import { useLayoutEffect, useRef, type ReactNode } from 'react'

export function ChartTooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const place = () => {
      const element = ref.current!
      const { width, height } = element.getBoundingClientRect()
      element.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - width - 8))}px`
      element.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, y + 12 + height <= innerHeight - 8 ? y + 12 : y - height - 12))}px`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  })
  return <div ref={ref} className="day-chart-tooltip" aria-live="polite">{children}</div>
}

import { useEffect } from 'react'

export function useChartTooltipDismiss(onDismiss: () => void) {
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.day-chart-tooltip')) return
      onDismiss()
    }
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') onDismiss() }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('pointercancel', dismiss, true)
    document.addEventListener('wheel', dismiss, { capture: true, passive: true })
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('pointercancel', dismiss, true)
      document.removeEventListener('wheel', dismiss, true)
      document.removeEventListener('keydown', keydown)
    }
  }, [onDismiss])
}

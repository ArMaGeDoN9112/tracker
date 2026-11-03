import { type MealType, mealTypes } from './mealTypes'

const icons = {
  meal: { label: 'Еда', path: 'M4 3v6m3-6v6m3-6v6M4 7h6M7 9v12M19 3v18m0-18c-4 3-4 9 0 9' },
  breakfast: { label: mealTypes.breakfast, path: 'M3 18h18M5 15a7 7 0 0 1 14 0M12 2v3M3 6l2 2m16-2-2 2M1 13h3m16 0h3' },
  lunch: { label: mealTypes.lunch, path: 'M3 17h18M5 17a7 7 0 0 1 14 0M12 8V5m-2 0h4M4 21h16' },
  dinner: { label: mealTypes.dinner, path: 'M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11ZM17 3v4m-2-2h4' },
  snack: { label: mealTypes.snack, path: 'M4 7h11v9a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4ZM15 8h3a3 3 0 0 1 0 6h-3M7 2v2m4-2v2' },
  water: { label: 'Вода', path: 'M12 3C9 7 6 10 6 14a6 6 0 0 0 12 0c0-4-3-7-6-11ZM9 14a3 3 0 0 0 3 3' },
  bolus: { label: 'Подколка', path: 'm18 2 4 4m-3-3-5 5m-4-2 8 8m-7-7-7 7v4h4l7-7M4 18l-2 4m5-11 3 3' },
}

export function CalendarEventIcon({ kind, mealType }: { kind: 'meal' | 'water' | 'bolus'; mealType?: MealType | null }) {
  const icon = icons[kind === 'meal' && mealType ? mealType : kind]
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <title>{icon.label}</title><path d={icon.path} />
  </svg>
}

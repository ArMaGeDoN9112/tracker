import type { DiaryDay } from './DayCalendar'
import type { Day as NutritionDay } from './Nutrition'

export function calendarRecords(entries: DiaryDay['entries'], meals: NutritionDay['meals']) {
  const minutes = new Map<number, { time: number; entries: DiaryDay['entries']; meals: NutritionDay['meals'] }>()
  for (const event of [...entries, ...meals]) {
    const time = Math.floor(Date.parse(event.occurred_at) / 60_000) * 60_000
    let row = minutes.get(time)
    if (!row) {
      row = { time, entries: [], meals: [] }
      minutes.set(time, row)
    }
    if ('lines' in event) row.meals.push(event)
    else row.entries.push(event)
  }
  return [...minutes.values()].sort((a, b) => a.time - b.time)
}

import { useEffect, useRef, useState } from 'react'
import { privateFetch } from './access'
import { MealDetails, TotalsView, type Day as NutritionDay, type Totals } from './Nutrition'
import type { TemporaryPeriod } from './TemporaryBasal'
import { basalText, localMinute, moscowLabel } from './time'

type CalendarDay = { day: string; meal_count: number; totals: Totals; water_total_ml: number | null }
type DiaryDay = {
  basal: string | null; temporary_percent: number | null
  basal_changes: { occurred_at: string; basal: string | null }[]
  temporary_basals: TemporaryPeriod[]
  entries: { id: string; occurred_at: string; glucose: string | null; bolus: string; reason: string | null; comment: string; basal: string | null }[]
}
const reasons: Record<string, string> = { food: 'Еда', correction: 'Коррекция', food_and_correction: 'Еда и коррекция' }

async function read<T,>(path: string): Promise<T> {
  const response = await privateFetch(path)
  const result = await response.json()
  if (!response.ok) throw new Error(result.message)
  return result
}

function DaySummary({ active, day, generation, onClose }: { active: boolean; day: string; generation: number; onClose: () => void }) {
  const [data, setData] = useState<{ nutrition: NutritionDay; diary: DiaryDay } | null>(null)
  const [error, setError] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => {
    let cancelled = false
    setData(null); setError('')
    if (!active) return
    Promise.all([read<NutritionDay>(`/api/nutrition-day?day=${day}`), read<DiaryDay>(`/api/day?day=${day}`)])
      .then(([nutrition, diary]) => { if (!cancelled) setData({ nutrition, diary }) })
      .catch(() => { if (!cancelled) setError('Не удалось загрузить сводку дня. Перезагрузите страницу.') })
    return () => { cancelled = true }
  }, [active, day, generation])

  return <section className="calendar-details" aria-label="Подробная сводка дня">
    <div className="calendar-detail-heading"><h3 tabIndex={-1} ref={heading}>Сводка за {day}</h3><button onClick={onClose}>Закрыть сводку</button></div>
    <p className="muted">Все события и границы дня — по Москве.</p>
    {error ? <p role="alert" className="error">{error}</p> : !data ? <p role="status">Загружаем сводку дня…</p> : <>
      <h4>Питание</h4>
      {!data.nutrition.meals.length ? <p>Нет записей еды.</p> : <>
        <TotalsView totals={data.nutrition.totals} />
        {data.nutrition.meals.map(meal => <article className="meal-history" key={meal.id}><MealDetails meal={meal} /></article>)}
      </>}
      <h4>Вода</h4>
      {data.nutrition.water_total_ml === null ? <p>Нет записей воды.</p> : <>
        <p>Всего: {data.nutrition.water_total_ml} мл</p>
        <ul>{data.nutrition.water.map(event => <li key={event.id}>{moscowLabel(event.occurred_at)} · {event.volume_ml} мл</li>)}</ul>
      </>}
      <h4>Сахар и подколки</h4>
      {!data.diary.entries.length && <p>Нет записей сахара и подколок.</p>}
      {data.diary.entries.map(entry => <article className="meal-history" key={entry.id}>
        <p>{moscowLabel(entry.occurred_at)}</p>
        <p>Сахар: {entry.glucose === null ? 'не указан' : `${entry.glucose} ммоль/л`} · Подколка: {entry.bolus} ед.</p>
        {entry.reason && <p>{reasons[entry.reason]}</p>}{entry.comment && <p className="comment">{entry.comment}</p>}
        <p>База: {basalText(entry.basal)} · по расписанию</p>
      </article>)}
      <h4>База · по расписанию</h4>
      <p>На начало дня: {basalText(data.diary.basal)}; {data.diary.temporary_percent === null ? 'обычное расписание' : `временная база ${data.diary.temporary_percent}%`}.</p>
      <ul>{data.diary.basal_changes.map(change => <li key={change.occurred_at}>{moscowLabel(change.occurred_at)} · {basalText(change.basal)}</li>)}</ul>
      {data.diary.temporary_basals.map(period => <p key={period.id}>Временная база {period.percent}% · с {moscowLabel(period.starts_at)} · до {moscowLabel(period.effective_ends_at)} (не включая). Исходная длительность: {period.duration_minutes} мин.; заданное окончание: {moscowLabel(period.ends_at)}.</p>)}
    </>}
  </section>
}

export function DayCalendar({ active, day, generation, onDay }: { active: boolean; day: string; generation: number; onDay: (day: string) => void }) {
  const today = localMinute(new Date().toISOString()).slice(0, 10)
  const [month, setMonth] = useState(() => today.slice(0, 7))
  const [days, setDays] = useState<CalendarDay[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const first = `${month}-01`
  const last = new Date(`${first}T12:00:00Z`)
  last.setUTCMonth(last.getUTCMonth() + 1, 0)
  const end = last.toISOString().slice(0, 10)
  const weekday = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7

  useEffect(() => {
    let cancelled = false
    setDays(null); setError('')
    if (!active) return
    read<{ days: CalendarDay[] }>(`/api/nutrition-summary?period=custom&start=${first}&end=${end}`)
      .then(result => { if (!cancelled) setDays(result.days) })
      .catch(() => { if (!cancelled) setError('Не удалось загрузить календарь. Перезагрузите страницу.') })
    return () => { cancelled = true }
  }, [active, first, end, generation])

  function selectMonth(value: string) {
    if (!/^\d{4}-\d{2}$/.test(value) || value < '0001-01' || value > '9999-11' || Number(value.slice(5)) < 1 || Number(value.slice(5)) > 12) return
    setMonth(value); setOpen(false)
  }
  function moveMonth(offset: number) {
    const date = new Date(`${first}T12:00:00Z`)
    date.setUTCMonth(date.getUTCMonth() + offset)
    selectMonth(date.toISOString().slice(0, 7))
  }

  return <section className="day-calendar" aria-label="Календарь дней">
    <span className="eyebrow">ПО ДНЯМ · МОСКВА</span><h2>Календарь</h2>
    <div className="calendar-navigation">
      <button disabled={month === '0001-01'} onClick={() => moveMonth(-1)} aria-label="Предыдущий месяц">←</button>
      <div><label htmlFor="calendar-month">Месяц — Москва</label><input id="calendar-month" type="month" min="0001-01" max="9999-11" value={month} onChange={event => selectMonth(event.target.value)} /></div>
      <button disabled={month === '9999-11'} onClick={() => moveMonth(1)} aria-label="Следующий месяц">→</button>
    </div>
    <p className="muted calendar-legend">В каждом дне: калории, ккал · вода, мл.<br />«—» — нет записей; «?» — калории неизвестны; «*» — калории неполные.</p>
    {error ? <p role="alert" className="error">{error}</p> : !days ? <p role="status">Загружаем календарь…</p> : <>
      <div className="calendar-grid">
        {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(label => <span className="calendar-weekday" key={label}>{label}</span>)}
        {days.map((row, index) => {
          const calories = row.totals.calories
          const label = !row.meal_count ? 'нет записей еды' : `${calories.value ?? 'неизвестно'} ккал${calories.incomplete ? ', данные неполные' : ''}`
          return <button key={row.day} id={`calendar-${row.day}`} className="calendar-day" style={index === 0 ? { gridColumnStart: weekday + 1 } : undefined}
            aria-label={`Открыть сводку за ${row.day}: ${label}; ${row.water_total_ml === null ? 'нет записей воды' : `${row.water_total_ml} мл воды`}`}
            aria-pressed={open && row.day === day} aria-current={row.day === today ? 'date' : undefined}
            onClick={() => { setOpen(true); onDay(row.day) }}>
            <time dateTime={row.day}>{Number(row.day.slice(-2))}</time>
            <span className="calendar-calories">{!row.meal_count ? '—' : calories.value ?? '?'}{calories.incomplete && '*'}</span>
            <span className="calendar-water">{row.water_total_ml ?? '—'}</span>
          </button>
        })}
      </div>
      <p className="muted">Нажмите на день, чтобы увидеть все записи.</p>
    </>}
    {open && day && <DaySummary key={day} active={active} day={day} generation={generation} onClose={() => {
      setOpen(false); document.getElementById(`calendar-${day}`)?.focus()
    }} />}
  </section>
}

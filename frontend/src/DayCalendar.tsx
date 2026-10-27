import { useEffect, useRef, useState } from 'react'
import { privateFetch } from './access'
import { type Day as NutritionDay, type Totals } from './Nutrition'
import { nutrients } from './ProductCatalog'
import { BasalDayChart } from './BasalDayChart'
import type { TemporaryPeriod } from './TemporaryBasal'
import { basalText, localMinute, moscowLabel } from './time'
import type { GlucoseDay } from './GlucoseCharts'

type CalendarDay = { day: string; meal_count: number; totals: Totals; water_total_ml: number | null; glucose_average: string | null }
type DiaryDay = {
  basal: string | null; temporary_percent: number | null
  basal_changes: { occurred_at: string; basal: string | null }[]
  temporary_basals: TemporaryPeriod[]
  entries: { id: string; occurred_at: string; glucose: string | null; bolus: string; reason: string | null; comment: string; basal: string | null }[]
}
const reasons: Record<string, string> = { food: 'Еда', correction: 'Коррекция', food_and_correction: 'Еда и коррекция' }
const categories: Record<string, string> = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус' }

function SummaryTotals({ totals }: { totals: Totals }) {
  return <dl className="calendar-nutrients">{[nutrients[3], ...nutrients.slice(0, 3)].map(([key, label, unit]) => <div key={key}>
    <dt>{label}</dt><dd>{totals[key].value === null ? <span className="muted">Неизвестно</span> : <>{totals[key].value} <small>{unit}</small></>}
      {totals[key].incomplete && totals[key].value !== null && <small className="nutrient-incomplete">Неполные данные</small>}
    </dd>
  </div>)}</dl>
}

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
  const maxWater = data?.nutrition.water.reduce((maximum, event) => Math.max(maximum, event.volume_ml), 1) ?? 1
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
        <div className="calendar-day-totals"><span className="eyebrow">ИТОГО ЗА ДЕНЬ</span><SummaryTotals totals={data.nutrition.totals} /></div>
        <div className="calendar-meals">{data.nutrition.meals.map(meal => <article className="calendar-meal" key={meal.id}>
          <header><h5>{categories[meal.category ?? ''] ?? 'Приём пищи'}</h5><time dateTime={meal.occurred_at}>{localMinute(meal.occurred_at).slice(11)}</time></header>
          <ul className="calendar-foods">{meal.lines.map(line => <li key={line.id}><strong>{line.name}</strong>
            {line.quantity !== null && <span className="muted">{line.quantity} {line.unit === 'g' ? 'г' : 'мл'}</span>}
          </li>)}</ul>
          <SummaryTotals totals={meal.totals} />
        </article>)}</div>
      </>}
      <h4>Вода</h4>
      {data.nutrition.water_total_ml === null ? <p>Нет записей воды.</p> : <>
        <div className="calendar-water-summary"><p><strong>{data.nutrition.water_total_ml} мл</strong><span className="muted">Всего за день</span></p>
          <ul className="calendar-water-events">{data.nutrition.water.map(event => <li key={event.id}>
            <time dateTime={event.occurred_at}>{localMinute(event.occurred_at).slice(11)}</time>
            <span className="water-bar-track" aria-hidden="true"><span style={{ width: `${event.volume_ml / maxWater * 100}%` }} /></span>
            <strong>{event.volume_ml} мл</strong>
          </li>)}</ul>
        </div>
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
      <BasalDayChart basal={data.diary.basal} changes={data.diary.basal_changes} />
      {data.diary.temporary_basals.length > 0 && <details className="calendar-temporary"><summary>Временная база</summary>
        {data.diary.temporary_basals.map(period => <p key={period.id}>{period.percent}% · {moscowLabel(period.starts_at)} — {moscowLabel(period.effective_ends_at)} (не включая)</p>)}
      </details>}
    </>}
  </section>
}

export function DayCalendar({ active, day, generation, onDay }: { active: boolean; day: string; generation: number; onDay: (day: string) => void }) {
  const today = localMinute(new Date().toISOString()).slice(0, 10)
  const [month, setMonth] = useState(() => (day || today).slice(0, 7))
  const [days, setDays] = useState<CalendarDay[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(true)
  const first = `${month}-01`
  const last = new Date(`${first}T12:00:00Z`)
  last.setUTCMonth(last.getUTCMonth() + 1, 0)
  const end = last.toISOString().slice(0, 10)
  const weekday = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7

  useEffect(() => {
    if (active) { setMonth((day || today).slice(0, 7)); setOpen(true) }
  }, [active, day])

  useEffect(() => {
    let cancelled = false
    setDays(null); setError('')
    if (!active || month < '0001-02' || month > '9999-11') return
    const period = `period=custom&start=${first}&end=${end}`
    Promise.all([
      read<{ days: Omit<CalendarDay, 'glucose_average'>[] }>(`/api/nutrition-summary?${period}`),
      read<{ days: GlucoseDay[] }>(`/api/glucose-summary?${period}`),
    ]).then(([nutrition, glucose]) => {
      const averages = new Map(glucose.days.map(row => [row.day, row.average]))
      if (!cancelled) setDays(nutrition.days.map(row => ({ ...row, glucose_average: averages.get(row.day) ?? null })))
    })
      .catch(() => { if (!cancelled) setError('Не удалось загрузить календарь. Перезагрузите страницу.') })
    return () => { cancelled = true }
  }, [active, first, end, generation])

  function selectMonth(value: string) {
    if (!/^\d{4}-\d{2}$/.test(value) || value < '0001-02' || value > '9999-11' || Number(value.slice(5)) < 1 || Number(value.slice(5)) > 12) return
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
      <button disabled={month === '0001-02'} onClick={() => moveMonth(-1)} aria-label="Предыдущий месяц">←</button>
      <div><label htmlFor="calendar-month">Месяц — Москва</label><input id="calendar-month" type="month" min="0001-02" max="9999-11" value={month} onChange={event => selectMonth(event.target.value)} /></div>
      <button disabled={month === '9999-11'} onClick={() => moveMonth(1)} aria-label="Следующий месяц">→</button>
    </div>
    {error ? <p role="alert" className="error">{error}</p> : !days ? <p role="status">Загружаем календарь…</p> : <>
      <div className="calendar-grid">
        {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(label => <span className="calendar-weekday" key={label}>{label}</span>)}
        {days.map((row, index) => {
          const calories = row.totals.calories
          const label = !row.meal_count ? 'нет записей еды' : `${calories.value ?? 'неизвестно'} ккал${calories.incomplete ? ', данные неполные' : ''}`
          const glucose = row.glucose_average?.replace('.', ',') ?? '—'
          return <button key={row.day} id={`calendar-${row.day}`} className="calendar-day" style={index === 0 ? { gridColumnStart: weekday + 1 } : undefined}
            aria-label={`Открыть сводку за ${row.day}: ${label}; ${row.water_total_ml === null ? 'нет записей воды' : `${row.water_total_ml} мл воды`}; ${row.glucose_average === null ? 'нет измерений сахара' : `средний сахар ${glucose} ммоль/л`}`}
            aria-pressed={open && row.day === day} aria-current={row.day === today ? 'date' : undefined}
            onClick={() => { setOpen(true); onDay(row.day) }}>
            <time dateTime={row.day}>{Number(row.day.slice(-2))}</time>
            <span className="calendar-calories">{!row.meal_count ? '—' : calories.value ?? '?'}{calories.incomplete && '*'}</span>
            <span className="calendar-water">{row.water_total_ml ?? '—'}</span>
            <span className="calendar-glucose">{glucose}</span>
          </button>
        })}
      </div>
      <p className="muted">Нажмите на день, чтобы увидеть все записи.</p>
    </>}
    {active && open && day && <DaySummary key={day} active={active} day={day} generation={generation} onClose={() => {
      setOpen(false); document.getElementById(`calendar-${day}`)?.focus()
    }} />}
  </section>
}

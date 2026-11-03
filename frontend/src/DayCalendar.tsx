import { useEffect, useRef, useState, type ReactNode } from 'react'
import { privateFetch } from './access'
import { type Day as NutritionDay, type Totals } from './Nutrition'
import { nutrients } from './ProductCatalog'
import { CalendarDayChart } from './CalendarDayChart'
import type { TemporaryPeriod } from './TemporaryBasal'
import { basalText, localMinute, moscowLabel } from './time'
import type { GlucoseDay } from './GlucoseCharts'
import { calendarRecords } from './calendarRecords'

type CalendarDay = { day: string; meal_count: number; totals: Totals; water_total_ml: number | null; glucose_average: string | null }
export type DiaryDay = {
  basal: string | null; temporary_percent: number | null
  basal_changes: { occurred_at: string; basal: string | null }[]
  temporary_basals: TemporaryPeriod[]
  entries: { id: string; occurred_at: string; glucose: string | null; bolus: string; reason: string | null; comment: string; basal: string | null }[]
}

function SummaryTotals({ totals }: { totals: Totals }) {
  return <dl className="calendar-nutrients">{nutrients.slice(0, 3).map(([key, label, unit]) => <div key={key}>
    <dt>{label}</dt><dd>{totals[key].value === null ? <span className="muted">Неизвестно</span> : <>{totals[key].value} <small>{unit}</small></>}
      {totals[key].incomplete && <small className="nutrient-incomplete">Неполные данные</small>}
    </dd>
  </div>)}</dl>
}

async function read<T,>(path: string): Promise<T> {
  const response = await privateFetch(path)
  const result = await response.json()
  if (!response.ok) throw new Error(result.message)
  return result
}

function DaySummary({ active, day, generation, summary, calendar, onClose, onAnalysis, onNutrition }: { active: boolean; day: string; generation: number; summary: CalendarDay | undefined; calendar: ReactNode; onClose: () => void; onAnalysis: (day: string) => void; onNutrition: (day: string) => void }) {
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

  const records = data ? calendarRecords(data.diary.entries, data.nutrition.meals) : []

  return <section className="calendar-details" aria-label="Подробная сводка дня">
    <div className="calendar-detail-heading"><h3 tabIndex={-1} ref={heading}>Сводка за {day}</h3><button onClick={onClose}>Закрыть сводку</button></div>
    <p className="muted">Все события и границы дня — по Москве.</p>
    <div className="calendar-console">
      <aside className="calendar-summary-metrics">{data && <>
        <dl className="console-metrics">
          <div><dt>Средний сахар</dt><dd>{summary?.glucose_average?.replace('.', ',') ?? '—'}</dd><small>ммоль/л · {data.diary.entries.filter(entry => entry.glucose !== null).length} измерений</small></div>
          <div><dt>Питание</dt><dd>{data.nutrition.meals.length ? data.nutrition.totals.calories.value ?? 'Неизвестно' : '—'}</dd><small>ккал · {data.nutrition.meals.length} приёмов</small>{data.nutrition.totals.calories.incomplete && <small>Неполные данные</small>}</div>
          <div><dt>Вода</dt><dd>{data.nutrition.water_total_ml ?? '—'}</dd><small>мл за день</small></div>
          <div><dt>Подколки</dt><dd>{(data.diary.entries.reduce((sum, entry) => sum + Math.round(Number(entry.bolus) * 10), 0) / 10).toFixed(1).replace('.', ',')}</dd><small>ед. за день</small></div>
        </dl>
        <section className="input-context"><span className="eyebrow">БАЗА ПО РАСПИСАНИЮ</span><p className="context-value">{basalText(data.diary.basal)}</p><p className="muted">На начало дня</p></section>
      </>}</aside>
      <div className="calendar-summary-chart">
        {error ? <p role="alert" className="error">{error}</p> : !data ? <p role="status">Загружаем сводку дня…</p> : <>
          <CalendarDayChart key={day} day={day} meals={data.nutrition.meals} water={data.nutrition.water} diary={data.diary} />
          {data.diary.temporary_basals.length > 0 && <details className="calendar-temporary"><summary>Временная база</summary>
            {data.diary.temporary_basals.map(period => <p key={period.id}>{period.percent}% · {moscowLabel(period.starts_at)} — {moscowLabel(period.effective_ends_at)} (не включая)</p>)}
          </details>}
          <section className="calendar-records"><span className="eyebrow">СОБЫТИЯ ДНЯ</span><h4>Записи дня</h4>
            <a href={`?section=charts&day=${day}`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onAnalysis(day) } }}>Записи диабета</a>
            {!records.length ? <p className="muted">Нет записей сахара, подколок, комментариев и еды.</p> : <div className="console-table-scroll"><table><thead><tr><th>Время</th><th>Сахар, ммоль/л</th><th>Подколка, ед.</th><th>Комментарий</th><th>Еда</th></tr></thead><tbody>{records.map(record => <tr key={record.time}>
              <td>{localMinute(new Date(record.time).toISOString()).slice(11)}</td>
              <td>{record.entries.flatMap(entry => entry.glucose === null ? [] : [entry.glucose.replace('.', ',')]).join('; ') || '—'}</td>
              <td>{record.entries.map(entry => entry.bolus.replace('.', ',')).join('; ') || '—'}</td>
              <td>{record.entries.map(entry => entry.comment).filter(Boolean).join('; ') || '—'}</td>
              <td>{record.meals.map(meal => meal.lines.map(line => line.name).join(', ')).join('; ') || '—'}</td>
            </tr>)}</tbody></table></div>}
          </section>
        </>}
      </div>
      <aside className="calendar-right">{calendar}
        {data && <section className="calendar-day-totals"><span className="eyebrow">ИТОГО ЗА ДЕНЬ</span><h4>Питание в деталях</h4>
          <a href={`?section=nutrition-summary&day=${day}`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onNutrition(day) } }}>Записи питания</a>
          {!data.nutrition.meals.length ? <p>Нет записей еды.</p> : <SummaryTotals totals={data.nutrition.totals} />}
          {data.nutrition.water_total_ml === null ? <p>Нет записей воды.</p> : <p className="calendar-water-summary">Вода: <strong>{data.nutrition.water_total_ml} мл</strong></p>}
        </section>}
      </aside>
    </div>
  </section>
}

export function DayCalendar({ active, day, generation, onDay, onAnalysis, onNutrition }: { active: boolean; day: string; generation: number; onDay: (day: string) => void; onAnalysis: (day: string) => void; onNutrition: (day: string) => void }) {
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

  const calendar = <div className="calendar-month-panel">
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
      <p className="muted">Нажмите на день, чтобы увидеть сводку.</p>
    </>}
    </div>
  return <section className="day-calendar" aria-label="Календарь дней">
    {active && open && day ? <DaySummary key={day} active={active} day={day} generation={generation} summary={days?.find(row => row.day === day)} calendar={calendar} onAnalysis={onAnalysis} onNutrition={onNutrition} onClose={() => {
      setOpen(false); requestAnimationFrame(() => document.getElementById(`calendar-${day}`)?.focus())
    }} /> : calendar}
  </section>
}

import { useEffect, useId, useState, type PointerEvent } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { Day, Totals } from './Nutrition'
import { nutrients } from './ProductCatalog'
import { localMinute, moscowDayBounds } from './time'

const series = [nutrients[3], ...nutrients.slice(0, 3)]
const colors = { calories: 'var(--accent)', protein: 'var(--water)', fat: 'var(--nutrition-fat)', carbohydrate: 'var(--warning)' }
const dashes = { calories: undefined, protein: '8 3', fat: '3 3', carbohydrate: '8 3 2 3' }
const valueText = (total: Totals[keyof Totals], unit: string) => `${total.value === null ? 'Неизвестно' : `${total.value} ${unit}`}${total.incomplete ? ' · Неполные данные' : ''}`

export function NutritionDayChart({ day, meals }: { day: string; meals: Day['meals'] }) {
  const [selected, setSelected] = useState<number | null>(null)
  const id = useId()
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null) }
    document.addEventListener('keydown', dismiss)
    return () => document.removeEventListener('keydown', dismiss)
  }, [])
  const [start, end] = moscowDayBounds(day)
  const points = meals.map(meal => ({ time: Date.parse(meal.occurred_at), ...Object.fromEntries(series.map(([key]) => [key, meal.totals[key].value === null ? null : Number(meal.totals[key].value)])) }))
    .sort((a, b) => a.time - b.time)
  const times = [...new Set(points.map(point => point.time))]
  const time = selected === null ? null : times[selected]
  const matches = meals.filter(meal => Date.parse(meal.occurred_at) === time)
  const clock = (value: number) => value === end ? '24:00' : localMinute(new Date(value).toISOString()).slice(11)
  const ticks = Array.from({ length: 5 }, (_, index) => start + (end - start) * index / 4)
  const description = matches.map(meal => series.map(([key, label, unit]) => `${label}: ${valueText(meal.totals[key], unit)}`).join('; ')).join('; ')

  function select(event: PointerEvent<HTMLDivElement>) {
    if (!times.length) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left - 56) / (bounds.width - 112)))
    const target = start + fraction * (end - start)
    setSelected(times.reduce((nearest, value, index) => Math.abs(value - target) < Math.abs(times[nearest] - target) ? index : nearest, 0))
  }

  return <div className="nutrition-day-chart">
    <ul className="nutrition-legend" aria-label="Показатели питания">{series.map(([key, label, unit]) => <li key={key}>
      <svg width="28" height="12" aria-hidden="true"><line x1="0" x2="28" y1="6" y2="6" stroke={colors[key]} strokeWidth="3" strokeDasharray={dashes[key]} /></svg>{label} · {unit}
    </li>)}</ul>
    <p className="muted" id={`${id}-help`}>Наведите, коснитесь или проведите по графику. С клавиатуры: стрелки, Home и End; Escape скрывает подсказку. Точки — приёмы пищи; линии соединяют записи. Пропуски не равны нулю.</p>
    {(end - start) !== 86400000 && <p className="muted">В этот день переводились часы. Повторяющиеся часы показаны в порядке событий.</p>}
    <div className="diabetes-day-plot" role="slider" tabIndex={0} aria-label="КБЖУ по времени"
      aria-describedby={`${id}-help`} aria-disabled={!times.length}
      aria-valuemin={0} aria-valuemax={Math.max(0, times.length - 1)} aria-valuenow={selected ?? 0}
      aria-valuetext={time === null ? 'Выберите время приёма' : `${clock(time)} · ${description}`}
      onPointerMove={select} onPointerDown={event => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); select(event) }}
      onFocus={() => { if (times.length && selected === null) setSelected(0) }}
      onKeyDown={event => {
        if (!times.length) return
        if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          setSelected(event.key === 'Home' ? 0 : event.key === 'End' ? times.length - 1
            : Math.max(0, Math.min(times.length - 1, (selected ?? 0) + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1))))
        }
      }}>
      <div className="nutrition-axis-units" aria-hidden="true"><span>ккал</span><span>г</span></div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={points} accessibilityLayer={false} margin={{ top: 28, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis type="number" dataKey="time" domain={[start, end]} ticks={ticks} tickFormatter={clock} tick={{ fill: 'var(--muted)', fontSize: 12 }} interval={0} />
          <YAxis yAxisId="calories" width={48} domain={[0, 'auto']} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          <YAxis yAxisId="grams" orientation="right" width={48} domain={[0, 'auto']} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          {series.map(([key]) => <Line key={key} yAxisId={key === 'calories' ? 'calories' : 'grams'} dataKey={key} type="linear" stroke={colors[key]} strokeDasharray={dashes[key]} strokeWidth={2} dot={{ r: 4 }} activeDot={false} isAnimationActive={false} />)}
          {time !== null && <ReferenceLine yAxisId="calories" x={time} stroke="var(--text)" strokeDasharray="4 4" />}
        </LineChart>
      </ResponsiveContainer>
    </div>
    <div className="diabetes-day-tooltip" aria-live="polite">{time === null ? <p className="muted">Выберите время приёма</p>
      : <div role="tooltip" aria-label="Питание"><strong>{clock(time)}</strong>
        {matches.map((meal, index) => <div key={meal.id}>{matches.length > 1 && <strong>Приём {index + 1}</strong>}
          {series.map(([key, label, unit]) => <p key={key}>{label}: {valueText(meal.totals[key], unit)}</p>)}
        </div>)}
      </div>}</div>
  </div>
}

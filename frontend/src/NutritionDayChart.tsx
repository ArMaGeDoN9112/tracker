import { ChartTooltip } from './ChartTooltip'
import { useChartTooltipDismiss } from './useChartTooltipDismiss'
import { useId, useState, type PointerEvent } from 'react'
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { Day, Totals } from './Nutrition'
import { nutrients } from './ProductCatalog'
import { localMinute, moscowDayBounds } from './time'

const series = [nutrients[3], ...nutrients.slice(0, 3)]
const colors = { calories: 'var(--accent)', protein: 'var(--water)', fat: 'var(--nutrition-fat)', carbohydrate: 'var(--warning)' }
const valueText = (total: Totals[keyof Totals], unit: string) => `${total.value === null ? 'Неизвестно' : `${total.value} ${unit}`}${total.incomplete ? ' · Неполные данные' : ''}`

export function NutritionDayChart({ day, meals }: { day: string; meals: Day['meals'] }) {
  const [selected, setSelected] = useState<number | null>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const id = useId()
  useChartTooltipDismiss(() => setSelected(null))
  const [start, end] = moscowDayBounds(day)
  const points = meals.map(meal => ({ time: Date.parse(meal.occurred_at), ...Object.fromEntries(series.map(([key]) => [key, meal.totals[key].value === null ? null : Number(meal.totals[key].value)])) }))
    .sort((a, b) => a.time - b.time)
  const times = [...new Set(points.map(point => point.time))]
  const time = selected === null ? null : times[Math.min(selected, times.length - 1)] ?? null
  const matches = meals.filter(meal => Date.parse(meal.occurred_at) === time)
  const clock = (value: number) => value === end ? '24:00' : localMinute(new Date(value).toISOString()).slice(11)
  const ticks = Array.from({ length: 5 }, (_, index) => start + (end - start) * index / 4)
  const description = matches.map(meal => series.map(([key, label, unit]) => `${label}: ${valueText(meal.totals[key], unit)}`).join('; ')).join('; ')

  function select(event: PointerEvent<HTMLDivElement>) {
    if (!times.length) return
    setPosition({ x: event.clientX, y: event.clientY })
    const bounds = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left - 56) / (bounds.width - 72)))
    const target = start + fraction * (end - start)
    setSelected(times.reduce((nearest, value, index) => Math.abs(value - target) < Math.abs(times[nearest] - target) ? index : nearest, 0))
  }

  return <div className="nutrition-day-charts">
    <p className="muted" id={`${id}-help`}>Наведите, коснитесь или проведите по графику. С клавиатуры: стрелки, Home и End; Escape скрывает подсказку. Столбики — КБЖУ каждого приёма пищи. Пропуски не равны нулю.</p>
    {(end - start) !== 86400000 && <p className="muted">В этот день переводились часы. Повторяющиеся часы показаны в порядке событий.</p>}
    {[series.slice(0, 1), series.slice(1)].map((group, index) => <div className="nutrition-day-chart" key={index}>
      <p><strong>{index === 0 ? 'Калории' : 'БЖУ'}</strong> · {index === 0 ? 'ккал' : 'г'}</p>
      <ul className="nutrition-legend" aria-label="Показатели питания">{group.map(([key, label, unit]) => <li key={key}>
        <svg width="28" height="12" aria-hidden="true"><rect x="10" y="1" width="8" height="10" fill={colors[key]} fillOpacity={0.6} /></svg>{label} · {unit}
      </li>)}</ul>
      <div className="diabetes-day-plot" role="slider" tabIndex={0} aria-label={index === 0 ? 'Калории по времени' : 'БЖУ по времени'}
        aria-describedby={`${id}-help`} aria-disabled={!times.length}
        aria-valuemin={0} aria-valuemax={Math.max(0, times.length - 1)} aria-valuenow={selected ?? 0}
        aria-valuetext={time === null ? 'Выберите время приёма' : `${clock(time)} · ${description}`}
        onPointerLeave={event => { if (event.pointerType === 'mouse') setSelected(null) }}
        onPointerMove={select} onPointerDown={event => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); select(event) }}
        onFocus={event => {
          const bounds = event.currentTarget.getBoundingClientRect()
          setPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + 32 })
          if (times.length && selected === null) setSelected(0)
        }}
        onKeyDown={event => {
          if (!times.length) return
          if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            setSelected(event.key === 'Home' ? 0 : event.key === 'End' ? times.length - 1
              : Math.max(0, Math.min(times.length - 1, (selected ?? 0) + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1))))
          }
        }}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={points} accessibilityLayer={false} barGap={4} margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis type="number" dataKey="time" domain={[start, end]} ticks={ticks} tickFormatter={clock} tick={{ fill: 'var(--muted)', fontSize: 12 }} interval={0} />
            <YAxis width={48} domain={[0, 'auto']} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
            {group.map(([key]) => <Bar key={key} dataKey={key} barSize={8} fill={colors[key]} fillOpacity={0.55} stroke="none" radius={[2, 2, 0, 0]} isAnimationActive={false} />)}
            {time !== null && <ReferenceLine x={time} stroke="var(--text)" strokeDasharray="4 4" />}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>)}
    {time !== null && <ChartTooltip {...position}>
      {[series.slice(0, 1), series.slice(1)].map((group, index) => <div key={index} role="tooltip" aria-label={index === 0 ? 'Калории' : 'БЖУ'}>
        <strong>{clock(time)} · {index === 0 ? 'Калории' : 'БЖУ'}</strong>
        {matches.map((meal, index) => <div key={meal.id}>{matches.length > 1 && <strong>Приём {index + 1}</strong>}
          {group.map(([key, label, unit]) => <p key={key}>{label}: {valueText(meal.totals[key], unit)}</p>)}
        </div>)}
      </div>)}
    </ChartTooltip>}
  </div>
}

import { useId, useState, type PointerEvent } from 'react'
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { ChartTooltip } from './ChartTooltip'
import type { DiaryDay } from './DayCalendar'
import type { Day } from './Nutrition'
import { nutrients } from './ProductCatalog'
import { basalText, localMinute, moscowDayBounds } from './time'

const metrics = [
  { key: 'calories', label: 'Калории', unit: 'ккал', axis: 'calories', color: 'var(--accent)', dash: undefined },
  { key: 'protein', label: 'Белки', unit: 'г', axis: 'grams', color: 'var(--water)', dash: '8 3' },
  { key: 'fat', label: 'Жиры', unit: 'г', axis: 'grams', color: 'var(--nutrition-fat)', dash: '3 3' },
  { key: 'carbohydrate', label: 'Углеводы', unit: 'г', axis: 'grams', color: 'var(--warning)', dash: '8 3 2 3' },
  { key: 'glucose', label: 'Сахар', unit: 'ммоль/л', axis: 'glucose', color: 'var(--calendar-glucose)', dash: undefined },
  { key: 'bolus', label: 'Подколки', unit: 'ед.', axis: 'bolus', color: 'var(--calendar-bolus)', dash: '6 3' },
  { key: 'basal', label: 'База', unit: 'ед/ч', axis: 'basal', color: 'var(--muted)', dash: '2 3' },
] as const
type Metric = typeof metrics[number]['key']
type Point = { time: number; value: number | null }

export function CalendarDayChart({ day, meals, diary }: { day: string; meals: Day['meals']; diary: DiaryDay }) {
  const [visible, setVisible] = useState<Metric[]>(metrics.map(metric => metric.key))
  const [selected, setSelected] = useState<number | null>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const id = useId()
  const [start, end] = moscowDayBounds(day)
  const clock = (value: number) => value === end ? '24:00' : localMinute(new Date(value).toISOString()).slice(11)
  const segments = [{ time: start, basal: diary.basal }, ...diary.basal_changes.map(change => ({ time: Date.parse(change.occurred_at), basal: change.basal }))]
    .sort((a, b) => a.time - b.time)
    .map((point, index, points) => ({ ...point, end: points[index + 1]?.time ?? end }))
    .filter(point => point.end > point.time)
  const data: Record<Metric, Point[]> = {
    ...Object.fromEntries(nutrients.map(([key]) => [key, meals.map(meal => ({ time: Date.parse(meal.occurred_at), value: meal.totals[key].value === null ? null : Number(meal.totals[key].value) })).sort((a, b) => a.time - b.time)])) as Record<typeof nutrients[number][0], Point[]>,
    glucose: diary.entries.filter(entry => entry.glucose !== null).map(entry => ({ time: Date.parse(entry.occurred_at), value: Number(entry.glucose) })).sort((a, b) => a.time - b.time),
    bolus: diary.entries.map(entry => ({ time: Date.parse(entry.occurred_at), value: Number(entry.bolus) })).sort((a, b) => a.time - b.time),
    basal: segments.flatMap(point => [{ time: point.time, value: point.basal === null ? null : Number(point.basal) }, { time: point.end, value: point.basal === null ? null : Number(point.basal) }]),
  }
  const axes = [...new Set(metrics.filter(metric => visible.includes(metric.key)).map(metric => metric.axis))]
  const bars = [
    ...meals.map(meal => ({ time: Date.parse(meal.occurred_at), bolus: null, ...Object.fromEntries(nutrients.map(([key]) => [key, meal.totals[key].value === null ? null : Number(meal.totals[key].value)])) })),
    ...diary.entries.map(entry => ({ time: Date.parse(entry.occurred_at), calories: null, protein: null, fat: null, carbohydrate: null, bolus: Number(entry.bolus) })),
  ].sort((a, b) => a.time - b.time)
  const maximum = (axis: typeof metrics[number]['axis']) => axis === 'glucose' ? 30 : (axis === 'basal' ? 3 : 1) * Math.max(1, ...metrics.filter(metric => metric.axis === axis && visible.includes(metric.key)).flatMap(metric => data[metric.key].map(point => point.value ?? 0)))
  const times = [...new Set([start, end - 1, ...metrics.filter(metric => visible.includes(metric.key)).flatMap(metric => data[metric.key].map(point => point.time))])].filter(time => time < end).sort((a, b) => a - b)
  const ticks = Array.from({ length: 5 }, (_, index) => start + (end - start) * index / 4)
  const activeBasal = segments.find(point => selected !== null && point.time <= selected && selected < point.end)
  const selectedMeals = meals.filter(meal => Date.parse(meal.occurred_at) === selected)
  const selectedEntries = diary.entries.filter(entry => Date.parse(entry.occurred_at) === selected)

  function select(event: PointerEvent<HTMLDivElement>) {
    if (!visible.length) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const width = bounds.width - 32
    const target = start + Math.max(0, Math.min(1, (event.clientX - bounds.left - 16) / width)) * (end - start - 1)
    const nearest = times.reduce((nearest, time) => Math.abs(time - target) < Math.abs(nearest - target) ? time : nearest)
    setSelected(Math.abs(nearest - target) <= (end - start) * 12 / width ? nearest : Math.round(target))
    setPosition({ x: event.clientX, y: event.clientY })
  }

  return <section className="calendar-day-chart" aria-label="Общий график дня"
    onPointerLeave={event => { if (event.pointerType === 'mouse') setSelected(null) }}
    onKeyDown={event => { if (event.key === 'Escape') setSelected(null) }}>
    <h4>График дня</h4>
    <fieldset className="calendar-chart-options"><legend>Показатели на графике</legend>
      {metrics.map(metric => <label key={metric.key}><input type="checkbox" checked={visible.includes(metric.key)} onChange={event => {
        setVisible(event.target.checked ? [...visible, metric.key] : visible.filter(key => key !== metric.key))
        setSelected(null)
      }} />
        <svg width="24" height="12" aria-hidden="true">{metric.key === 'glucose' || metric.key === 'basal'
          ? <line x1="0" x2="24" y1="6" y2="6" stroke={metric.color} strokeWidth="3" strokeDasharray={metric.dash} />
          : <rect x="8" y="1" width="8" height="10" fill={metric.color} fillOpacity={0.6} />}</svg>
        {metric.label}
      </label>)}
    </fieldset>
    <p className="muted" id={`${id}-help`}>Общая шкала времени — Москва. КБЖУ и подколки — столбики, сахар — точки с плавной линией, база — ступени. У показателей отдельные шкалы; БЖУ — на общей шкале в граммах. Точные значения — в подсказке рядом с курсором. Наведите, коснитесь или используйте стрелки, Home, End; Escape скрывает подсказку. Между измерениями сахар неизвестен; пропуски не равны нулю.</p>
    <ul className="calendar-chart-scales" aria-label="Шкалы показателей">{axes.map(axis => <li key={axis}>{metrics.filter(metric => metric.axis === axis && visible.includes(metric.key)).map(metric => metric.label).join(', ')}: 0–{maximum(axis)} {metrics.find(metric => metric.axis === axis)!.unit}</li>)}</ul>
    {end - start !== 86400000 && <p className="muted">В этот день переводились часы. Повторяющиеся часы показаны в порядке событий.</p>}
    {!diary.entries.length && <p className="muted">Нет записей сахара и подколок.</p>}
    {!visible.length ? <p role="status">Выберите хотя бы один показатель.</p> : <div className="diabetes-day-plot" role="slider" tabIndex={0} aria-label="Показатели дня по времени" aria-describedby={`${id}-help`}
      aria-valuemin={start} aria-valuemax={end - 1} aria-valuenow={selected ?? start} aria-valuetext={selected === null ? 'Выберите время' : clock(selected)}
      onPointerMove={select} onPointerDown={event => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); select(event) }}
      onFocus={event => { const bounds = event.currentTarget.getBoundingClientRect(); setPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + 32 }); setSelected(time => time ?? start) }}
      onKeyDown={event => {
        if (event.key === 'Escape') setSelected(null)
        if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const index = times.reduce((nearest, time, index) => Math.abs(time - (selected ?? start)) < Math.abs(times[nearest] - (selected ?? start)) ? index : nearest, 0)
          setSelected(event.key === 'Home' ? start : event.key === 'End' ? end - 1 : times[Math.max(0, Math.min(times.length - 1, index + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1)))])
        }
      }}>
      <ResponsiveContainer width="100%" height={360}>
        <ComposedChart data={bars} accessibilityLayer={false} barGap={4} margin={{ top: 16, right: 16, bottom: 8, left: 16 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis type="number" dataKey="time" domain={[start, end]} ticks={ticks} tickFormatter={clock} interval={0} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          {axes.map(axis => <YAxis key={axis} yAxisId={axis} hide domain={[0, maximum(axis)]} allowDataOverflow={axis === 'glucose'} />)}
          {metrics.filter(metric => visible.includes(metric.key) && metric.key !== 'glucose' && metric.key !== 'basal').map(metric => <Bar key={metric.key} name={metric.label} dataKey={metric.key} yAxisId={metric.axis} barSize={6} fill={metric.color} fillOpacity={0.55} stroke="none" radius={[2, 2, 0, 0]} isAnimationActive={false} />)}
          {metrics.filter(metric => visible.includes(metric.key) && (metric.key === 'glucose' || metric.key === 'basal')).map(metric => <Line key={metric.key} name={metric.label} data={data[metric.key]} dataKey="value" yAxisId={metric.axis} type={metric.key === 'basal' ? 'stepAfter' : 'monotoneX'} stroke={metric.color} strokeDasharray={metric.dash} strokeWidth={2} dot={metric.key === 'basal' ? false : { r: 4 }} activeDot={false} connectNulls={false} isAnimationActive={false} />)}
          {selected !== null && <ReferenceLine yAxisId={axes[0]} x={selected} stroke="var(--text)" strokeDasharray="4 4" />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>}
    {selected !== null && <ChartTooltip {...position}><div role="tooltip" aria-label="Показатели дня"><strong>{clock(selected)}</strong>
      {metrics.filter(metric => visible.includes(metric.key)).map(metric => <div key={metric.key}>
        <strong>{metric.label} · {metric.unit}</strong>
        {metric.key === 'basal' ? <p>{activeBasal ? `${clock(activeBasal.time)}–${clock(activeBasal.end)} · ${basalText(activeBasal.basal)}` : 'Неизвестно'}</p>
          : metric.key === 'glucose' || metric.key === 'bolus' ? (selectedEntries.length ? selectedEntries.map((entry, index) => <p key={entry.id}>{selectedEntries.length > 1 && `Запись ${index + 1}: `}{entry[metric.key] === null ? 'Сахар не указан' : `${entry[metric.key]!.replace('.', ',')} ${metric.unit}`}</p>) : <p>Нет записи в этот момент</p>)
            : selectedMeals.length ? selectedMeals.map((meal, index) => <p key={meal.id}>{selectedMeals.length > 1 && `Приём ${index + 1}: `}{meal.totals[metric.key].value === null ? 'Неизвестно' : `${meal.totals[metric.key].value} ${metric.unit}`}{meal.totals[metric.key].incomplete && ' · Неполные данные'}</p>) : <p>Нет приёма пищи в этот момент</p>}
      </div>)}
    </div></ChartTooltip>}
  </section>
}

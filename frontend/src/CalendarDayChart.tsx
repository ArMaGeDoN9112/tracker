import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { ChartTooltip } from './ChartTooltip'
import { CalendarEventIcon } from './CalendarEventIcon'
import { useChartTooltipDismiss } from './useChartTooltipDismiss'
import type { DiaryDay } from './DayCalendar'
import type { Day } from './Nutrition'
import { nutrients } from './ProductCatalog'
import { type MealType, mealTypes } from './mealTypes'
import { basalText, localMinute, moscowDayBounds } from './time'

const metrics = [
  { key: 'glucose', label: 'Сахар', unit: 'ммоль/л', axis: 'glucose', color: 'var(--calendar-glucose)', dash: undefined },
  { key: 'bolus', label: 'Подколки', unit: 'ед.', axis: 'bolus', color: 'var(--calendar-bolus)', dash: '6 3' },
  { key: 'basal', label: 'База', unit: 'ед/ч', axis: 'basal', color: 'var(--muted)', dash: '2 3' },
] as const
type Metric = typeof metrics[number]['key']
type Point = { time: number; value: number | null }
type CalendarEvent = { id: string; time: number; kind: 'meal' | 'water' | 'bolus'; label: string; mealType?: MealType | null }

export function CalendarDayChart({ day, meals, water, diary }: { day: string; meals: Day['meals']; water: Day['water']; diary: DiaryDay }) {
  const [visible, setVisible] = useState<Metric[]>(metrics.map(metric => metric.key))
  const [showMeals, setShowMeals] = useState(true)
  const [showWater, setShowWater] = useState(true)
  const section = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(0, entry.contentRect.width - 32)))
    observer.observe(section.current!)
    return () => observer.disconnect()
  }, [])
  const [selected, setSelected] = useState<number | null>(null)
  useChartTooltipDismiss(() => setSelected(null))
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [start, end] = moscowDayBounds(day)
  const clock = (value: number) => value === end ? '24:00' : localMinute(new Date(value).toISOString()).slice(11)
  const segments = [{ time: start, basal: diary.basal }, ...diary.basal_changes.map(change => ({ time: Date.parse(change.occurred_at), basal: change.basal }))]
    .sort((a, b) => a.time - b.time)
    .map((point, index, points) => ({ ...point, end: points[index + 1]?.time ?? end }))
    .filter(point => point.end > point.time)
  const data: Record<Metric, Point[]> = {
    glucose: diary.entries.filter(entry => entry.glucose !== null).map(entry => ({ time: Date.parse(entry.occurred_at), value: Number(entry.glucose) })).sort((a, b) => a.time - b.time),
    bolus: diary.entries.map(entry => ({ time: Date.parse(entry.occurred_at), value: Number(entry.bolus) })).sort((a, b) => a.time - b.time),
    basal: segments.flatMap(point => [{ time: point.time, value: point.basal === null ? null : Number(point.basal) }, { time: point.end, value: point.basal === null ? null : Number(point.basal) }]),
  }
  const axes = [...new Set(metrics.filter(metric => visible.includes(metric.key)).map(metric => metric.axis))]
  const bars = diary.entries.map(entry => ({ time: Date.parse(entry.occurred_at), bolus: Number(entry.bolus) })).sort((a, b) => a.time - b.time)
  const maximum = (axis: typeof metrics[number]['axis']) => axis === 'glucose' ? 30 : (axis === 'basal' ? 3 : 1) * Math.max(1, ...metrics.filter(metric => metric.axis === axis && visible.includes(metric.key)).flatMap(metric => data[metric.key].map(point => point.value ?? 0)))
  const events: CalendarEvent[] = [
    ...(showMeals ? meals.map(meal => ({ id: `meal-${meal.id}`, time: Date.parse(meal.occurred_at), kind: 'meal' as const, label: `${meal.meal_type ? mealTypes[meal.meal_type] : 'Еда'}: ${meal.lines.map(line => line.name).join(', ') || 'Приём пищи'}`, mealType: meal.meal_type })) : []),
    ...(showWater ? water.map(record => ({ id: `water-${record.id}`, time: Date.parse(record.occurred_at), kind: 'water' as const, label: `Вода: ${record.volume_ml} мл` })) : []),
    ...(visible.includes('bolus') ? diary.entries.filter(entry => Number(entry.bolus) > 0).map(entry => ({ id: `bolus-${entry.id}`, time: Date.parse(entry.occurred_at), kind: 'bolus' as const, label: `Подколка: ${entry.bolus.replace('.', ',')} ед.` })) : []),
  ].sort((a, b) => a.time - b.time)
  const snapTimes = [...new Set([...events.map(event => event.time), ...(visible.includes('glucose') ? data.glucose.map(point => point.time) : [])])]
  const times = [...new Set([start, end - 1, ...snapTimes, ...(visible.includes('basal') ? data.basal.map(point => point.time) : [])])].filter(time => time < end).sort((a, b) => a - b)
  const ticks = Array.from({ length: 5 }, (_, index) => start + (end - start) * index / 4)
  const activeBasal = segments.find(point => selected !== null && point.time <= selected && selected < point.end)
  const selectedMeals = showMeals ? meals.filter(meal => Date.parse(meal.occurred_at) === selected) : []
  const selectedEntries = diary.entries.filter(entry => Date.parse(entry.occurred_at) === selected)
  const selectedWater = showWater ? water.filter(record => Date.parse(record.occurred_at) === selected) : []
  const cardWidth = Math.min(width, 44)
  const rowEnds: number[] = []
  const cards = events.map(event => {
    const anchor = Math.max(0, Math.min(width, (event.time - start) / (end - start) * width))
    const left = Math.max(0, Math.min(width - cardWidth, anchor - cardWidth / 2))
    let row = rowEnds.findIndex(end => end + 8 <= left)
    if (row === -1) row = rowEnds.length
    rowEnds[row] = left + cardWidth
    return { event, anchor, left, row }
  })

  function selectEvent(event: CalendarEvent, element: HTMLElement) {
    const bounds = element.getBoundingClientRect()
    setSelected(event.time)
    setPosition({ x: bounds.left, y: bounds.bottom })
  }

  function select(event: PointerEvent<HTMLDivElement>) {
    if (!visible.length && !showMeals && !showWater) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const width = bounds.width - 32
    const target = start + Math.max(0, Math.min(1, (event.clientX - bounds.left - 16) / width)) * (end - start - 1)
    const nearest = snapTimes.reduce((nearest, time) => Math.abs(time - target) < Math.abs(nearest - target) ? time : nearest, snapTimes[0] ?? target)
    setSelected(Math.abs(nearest - target) <= (end - start) * 12 / width ? nearest : Math.round(target))
    setPosition({ x: event.clientX, y: event.clientY })
  }

  return <section ref={section} className="calendar-day-chart" aria-label="Общий график дня"
    onPointerLeave={event => { if (event.pointerType === 'mouse') setSelected(null) }}
    onKeyDown={event => { if (event.key === 'Escape') setSelected(null) }}>
    <h4>График дня</h4>
    <fieldset className="calendar-chart-options"><legend>Показатели на графике</legend>
      <label><input type="checkbox" checked={showMeals} onChange={event => { setShowMeals(event.target.checked); setSelected(null) }} /><svg width="24" height="12" aria-hidden="true"><circle cx="12" cy="6" r="4" fill="var(--accent)" /></svg>Еда</label>
      <label><input type="checkbox" checked={showWater} onChange={event => { setShowWater(event.target.checked); setSelected(null) }} /><span className="calendar-water-icon"><CalendarEventIcon kind="water" /></span>Вода</label>
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
    <ul className="calendar-chart-scales" aria-label="Шкалы показателей">{axes.map(axis => <li key={axis}>{metrics.filter(metric => metric.axis === axis && visible.includes(metric.key)).map(metric => metric.label).join(', ')}: 0–{maximum(axis)} {metrics.find(metric => metric.axis === axis)!.unit}</li>)}</ul>
    {end - start !== 86400000 && <p className="muted">В этот день переводились часы. Повторяющиеся часы показаны в порядке событий.</p>}
    {!diary.entries.length && <p className="muted">Нет записей сахара и подколок.</p>}
    {!visible.length && !showMeals && !showWater ? <p role="status">Выберите хотя бы один показатель.</p> : <div className="diabetes-day-plot" role="slider" tabIndex={0} aria-label="Показатели дня по времени"
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
          <XAxis type="number" dataKey="time" domain={[start, end]} allowDataOverflow ticks={ticks} tickFormatter={clock} interval={0} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          {axes.map(axis => <YAxis key={axis} yAxisId={axis} hide domain={[0, maximum(axis)]} allowDataOverflow={axis === 'glucose'} />)}
          {metrics.filter(metric => visible.includes(metric.key) && metric.key !== 'glucose' && metric.key !== 'basal').map(metric => <Bar key={metric.key} name={metric.label} dataKey={metric.key} yAxisId={metric.axis} barSize={6} fill={metric.color} fillOpacity={0.55} stroke="none" radius={[2, 2, 0, 0]} isAnimationActive={false} />)}
          {metrics.filter(metric => visible.includes(metric.key) && (metric.key === 'glucose' || metric.key === 'basal')).map(metric => <Line key={metric.key} name={metric.label} data={data[metric.key]} dataKey="value" yAxisId={metric.axis} type={metric.key === 'basal' ? 'stepAfter' : 'monotoneX'} stroke={metric.color} strokeDasharray={metric.dash} strokeWidth={2} dot={metric.key === 'basal' ? false : { r: 4 }} activeDot={false} connectNulls={false} isAnimationActive={false} />)}
          {!axes.length && <YAxis yAxisId="time" hide domain={[0, 1]} allowDataOverflow />}
          {selected !== null && <ReferenceLine yAxisId={axes[0] ?? 'time'} x={selected} stroke="var(--text)" strokeDasharray="4 4" />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>}
    {(showMeals || showWater || visible.includes('bolus')) && <div className="calendar-events">
      <h5>События дня</h5>
      {!events.length ? <p className="muted">Нет событий выбранных типов.</p> : <ul className="calendar-event-track" aria-label="События дня по времени">
        {cards.map(({ event: item, anchor, left, row }) => <li key={item.id}>
          <span className={`calendar-event-stem calendar-event-${item.kind}`} aria-hidden="true" style={{ left: anchor, gridRow: `1 / span ${row + 1}` }} />
          <button type="button" className={`calendar-event-card calendar-event-${item.kind}`} aria-label={`${clock(item.time)} · ${item.label}`} aria-pressed={selected === item.time} style={{ marginLeft: left, gridRow: row + 1, width: cardWidth }}
            onPointerEnter={event => { if (event.pointerType === 'mouse') selectEvent(item, event.currentTarget) }}
            onFocus={event => selectEvent(item, event.currentTarget)} onClick={event => selectEvent(item, event.currentTarget)}>
            <CalendarEventIcon kind={item.kind} mealType={item.mealType} />
          </button>
        </li>)}
      </ul>}
    </div>}
    {selected !== null && <ChartTooltip {...position}><div className="calendar-tooltip" role="tooltip" aria-label="Показатели дня">
      <div className="calendar-tooltip-time"><span>Время · Москва</span><strong>{clock(selected)}</strong></div>
      {selectedMeals.map((meal, index) => <div key={meal.id} className="calendar-tooltip-block calendar-event-meal">
        <strong className="calendar-tooltip-heading">{meal.meal_type ? mealTypes[meal.meal_type] : selectedMeals.length > 1 ? `Приём ${index + 1}` : 'Еда'}</strong>
        <ul className="calendar-tooltip-foods" aria-label="Состав приёма пищи">{meal.lines.map(line => <li key={line.id}>
          <span>{line.name}</span>{line.quantity !== null && line.unit !== null && <span className="calendar-tooltip-quantity"> · {line.quantity.replace('.', ',')} {line.unit === 'g' ? 'г' : 'мл'}</span>}
        </li>)}</ul>
        <div className="calendar-tooltip-totals"><span className="calendar-tooltip-caption">Итого за приём</span>
          <dl>{[nutrients[3], ...nutrients.slice(0, 3)].map(([key, label, unit]) => <div key={key}>
            <dt>{label}: </dt><dd>{meal.totals[key].value === null ? 'Неизвестно' : `${meal.totals[key].value!.replace('.', ',')} ${unit}`}
              {meal.totals[key].incomplete && <span className="calendar-tooltip-warning"> · Неполные данные</span>}
            </dd>
          </div>)}</dl>
        </div>
      </div>)}
      {selectedWater.length > 0 && <div className="calendar-tooltip-block calendar-event-water">
        <strong className="calendar-tooltip-heading">Вода</strong>{selectedWater.map((record, index) => <p key={record.id} className="calendar-tooltip-reading">
          <span>{selectedWater.length > 1 ? `Запись ${index + 1}` : 'Объём'}</span><strong>{record.volume_ml} мл</strong>
        </p>)}
      </div>}
      {metrics.filter(metric => visible.includes(metric.key)).map(metric => <div key={metric.key} className={`calendar-tooltip-block calendar-tooltip-${metric.key}`}>
        <strong className="calendar-tooltip-heading">{metric.label}</strong>
        {metric.key === 'basal' ? activeBasal ? <p className="calendar-tooltip-rate"><strong>{basalText(activeBasal.basal)}</strong><span>Период: {clock(activeBasal.time)}–{clock(activeBasal.end)}</span></p> : <p className="muted">Неизвестно</p>
          : selectedEntries.length ? selectedEntries.map((entry, index) => <p key={entry.id} className="calendar-tooltip-reading">
            {selectedEntries.length > 1 && <span>Запись {index + 1}</span>}
            {entry[metric.key] === null ? <span className="muted">Сахар не указан</span> : <strong>{entry[metric.key]!.replace('.', ',')} {metric.unit}</strong>}
          </p>) : <p className="muted">Нет записи в этот момент</p>}
      </div>)}
    </div></ChartTooltip>}
  </section>
}

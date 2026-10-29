import { ChartTooltip } from './ChartTooltip'
import { activeInsulinPoints, fiaspRemaining } from './activeInsulin'
import { useChartTooltipDismiss } from './useChartTooltipDismiss'
import { useMemo, useState, type PointerEvent } from 'react'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, Rectangle, ReferenceLine, ResponsiveContainer, XAxis, YAxis, type BarShapeProps } from 'recharts'
import { localMinute, moscowDayBounds } from './time'

type Entry = { id: string; occurred_at: string; glucose: string | null; bolus: string }

export function DiabetesDayCharts({ day, entries, previousEntries }: { day: string; entries: Entry[]; previousEntries: Entry[] }) {
  const [time, setTime] = useState<number | null>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  useChartTooltipDismiss(() => setTime(null))
  const { start, end, points, glucose, active, doses, times } = useMemo(() => {
    const [start, end] = moscowDayBounds(day)
    const points = entries.map(entry => ({ ...entry, time: Date.parse(entry.occurred_at), units: Number(entry.bolus) }))
      .sort((a, b) => a.time - b.time)
    const doses = [...previousEntries, ...entries].filter(entry => Number(entry.bolus) > 0)
      .map(entry => ({ time: Date.parse(entry.occurred_at), units: Number(entry.bolus) }))
    return { start, end, points, doses,
      glucose: points.filter(point => point.glucose !== null).map(point => ({ time: point.time, value: Number(point.glucose) })),
      active: activeInsulinPoints([...previousEntries, ...entries], start, end),
      times: [...new Set([start, ...points.map(point => point.time), end])].sort((a, b) => a - b),
    }
  }, [day, entries, previousEntries])
  const matches = points.filter(point => point.time === time)
  const remaining = time === null ? 0 : doses.reduce((sum, dose) => sum + dose.units * fiaspRemaining((time - dose.time) / 60000), 0)
  const clock = (value: number) => value === end ? '24:00' : localMinute(new Date(value).toISOString()).slice(11)
  const activeText = `${remaining.toFixed(2).replace('.', ',')} ед.`
  const ticks = Array.from({ length: 5 }, (_, index) => start + (end - start) * index / 4)

  function select(event: PointerEvent<HTMLDivElement>) {
    setPosition({ x: event.clientX, y: event.clientY })
    const bounds = event.currentTarget.getBoundingClientRect()
    const width = bounds.width - 112
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left - 56) / width))
    const target = start + fraction * (end - start)
    const nearest = times.reduce((nearest, value) => Math.abs(value - target) < Math.abs(nearest - target) ? value : nearest)
    setTime(Math.abs(nearest - target) <= (end - start) * 12 / width ? nearest : Math.round(target))
  }

  return <section className="diabetes-day-chart" aria-label="Сахар, подколки и активный Фиасп">
    <p><strong>Сахар и инсулин</strong></p>
    <p className="muted">Активный Фиасп: расчёт по подколкам · без базы · модель Loop, хвост 6 ч 10 мин</p>
    {!entries.length && <p>Нет записей сахара и подколок.</p>}
    {(end - start) !== 86400000 && <p className="muted">В этот день переводились часы. Повторяющиеся часы показаны в порядке событий.</p>}
    <div className="diabetes-day-plot" role="slider" tabIndex={0} aria-label="Сахар и инсулин по времени"
      aria-valuemin={start} aria-valuemax={end} aria-valuenow={time ?? start}
      aria-valuetext={time === null ? 'Выберите время' : `${clock(time)} · ${matches.map(point => `Сахар ${point.glucose === null ? 'не указан' : `${point.glucose.replace('.', ',')} ммоль/л`}, подколка ${point.bolus.replace('.', ',')} ед.`).join('; ')} · Активный Фиасп ${activeText}`}
      onPointerLeave={event => { if (event.pointerType === 'mouse') setTime(null) }}
      onPointerMove={select} onPointerDown={event => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); select(event) }}
      onFocus={event => {
        const bounds = event.currentTarget.getBoundingClientRect()
        setPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + 32 })
        setTime(value => value ?? start)
      }}
      onKeyDown={event => {
        if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const index = times.reduce((nearest, value, index) => Math.abs(value - (time ?? start)) < Math.abs(times[nearest] - (time ?? start)) ? index : nearest, 0)
          setTime(event.key === 'Home' ? start : event.key === 'End' ? end
            : times[Math.max(0, Math.min(times.length - 1, index + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1)))])
        }
      }}>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={points} accessibilityLayer={false} margin={{ top: 16, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis type="number" dataKey="time" domain={[start, end]} allowDataOverflow ticks={ticks} tickFormatter={clock} tick={{ fill: 'var(--muted)', fontSize: 12 }} interval={0} />
          <YAxis yAxisId="glucose" width={48} domain={[0, 30]} allowDataOverflow tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          <YAxis yAxisId="insulin" orientation="right" width={48} domain={[0, 'auto']} tick={{ fill: 'var(--muted)', fontSize: 12 }} tickFormatter={value => String(value).replace('.', ',')} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar yAxisId="insulin" dataKey="units" name="Подколки · ед. (справа)" barSize={8} fill="var(--warning)" fillOpacity={0.55} stroke="none" isAnimationActive={false}
            // Dense IOB samples must not shrink the dose bars to subpixel widths.
            shape={(props: BarShapeProps) => <Rectangle x={props.x + (props.width - 8) / 2} y={props.y} width={8} height={props.height} fill="var(--warning)" fillOpacity={0.55} radius={[2, 2, 0, 0]} />} />
          <Line yAxisId="glucose" data={glucose} dataKey="value" name="Сахар · ммоль/л (слева)" type="monotoneX" stroke="var(--accent)" strokeWidth={2} dot={{ r: 4 }} activeDot={false} isAnimationActive={false} />
          <Line yAxisId="insulin" data={active} dataKey="value" name="Активный Фиасп · ед. (справа)" type="linear" stroke="var(--water)" strokeWidth={2} strokeDasharray="5 3" dot={false} activeDot={false} isAnimationActive={false} />
          {time !== null && <ReferenceLine yAxisId="glucose" x={time} stroke="var(--text)" strokeDasharray="4 4" />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    {time !== null && <ChartTooltip {...position}>
      {(['glucose', 'bolus'] as const).map(key => <div key={key} role="tooltip" aria-label={key === 'glucose' ? 'Сахар' : 'Подколки'}>
        <strong>{clock(time)} · {key === 'glucose' ? 'Сахар' : 'Подколки'}</strong>
        {matches.length ? matches.map((point, index) => <p key={point.id}>{matches.length > 1 && `Запись ${index + 1}: `}{point[key] === null ? 'Сахар не указан' : `${point[key]!.replace('.', ',')} ${key === 'glucose' ? 'ммоль/л' : 'ед.'}`}</p>) : <p>Нет записи в этот момент</p>}
      </div>)}
      <div role="tooltip" aria-label="Активный Фиасп"><strong>{clock(time)} · Активный Фиасп</strong><p>{activeText} · расчёт</p></div>
    </ChartTooltip>}
  </section>
}

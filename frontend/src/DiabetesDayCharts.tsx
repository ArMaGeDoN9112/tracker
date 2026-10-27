import { useEffect, useId, useState, type PointerEvent } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { localMinute, moscowDayBounds } from './time'

type Entry = { id: string; occurred_at: string; glucose: string | null; bolus: string }

export function DiabetesDayCharts({ day, entries }: { day: string; entries: Entry[] }) {
  const [selected, setSelected] = useState<number | null>(null)
  const id = useId()
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null) }
    document.addEventListener('keydown', dismiss)
    return () => document.removeEventListener('keydown', dismiss)
  }, [])
  const [start, end] = moscowDayBounds(day)
  const points = entries.map(entry => ({ ...entry, time: Date.parse(entry.occurred_at) }))
    .sort((a, b) => a.time - b.time)
  const times = [...new Set(points.map(point => point.time))]
  const time = selected === null ? null : times[selected]
  const matches = points.filter(point => point.time === time)
  const clock = (value: number) => value === end ? '24:00' : localMinute(new Date(value).toISOString()).slice(11)
  const ticks = Array.from({ length: 5 }, (_, index) => start + (end - start) * index / 4)

  function select(event: PointerEvent<HTMLDivElement>) {
    if (!times.length) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left - 56) / (bounds.width - 72)))
    const target = start + fraction * (end - start)
    setSelected(times.reduce((nearest, value, index) => Math.abs(value - target) < Math.abs(times[nearest] - target) ? index : nearest, 0))
  }

  return <div className="diabetes-day-charts">
    <p className="muted" id={`${id}-help`}>Наведите, коснитесь или проведите по графику. С клавиатуры: стрелки, Home и End; Escape скрывает подсказки. Линии соединяют записи, значения между ними не измерены.</p>
    {!entries.length && <p>Нет записей сахара и подколок.</p>}
    {(end - start) !== 86400000 && <p className="muted">В этот день переводились часы. Повторяющиеся часы показаны в порядке событий.</p>}
    {(['glucose', 'bolus'] as const).map(key => {
      const label = key === 'glucose' ? 'Сахар' : 'Подколки'
      const unit = key === 'glucose' ? 'ммоль/л' : 'ед.'
      const values = points.filter(point => point[key] !== null).map(point => ({ time: point.time, value: Number(point[key]) }))
      return <div className="diabetes-day-chart" key={key}>
        <p><strong>{label}</strong> · {unit}</p>
        <div className="diabetes-day-plot" role="slider" tabIndex={0} aria-label={`${label} · ${unit}`}
          aria-describedby={`${id}-help`} aria-disabled={!times.length}
          aria-valuemin={0} aria-valuemax={Math.max(0, times.length - 1)} aria-valuenow={selected ?? 0}
          aria-valuetext={time === null ? 'Выберите время события' : `${clock(time)} · ${matches.map(point => point[key] === null ? 'не указан' : `${point[key]!.replace('.', ',')} ${unit}`).join('; ')}`}
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
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={values} accessibilityLayer={false} margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis type="number" dataKey="time" domain={[start, end]} ticks={ticks} tickFormatter={clock} tick={{ fill: 'var(--muted)', fontSize: 12 }} interval={0} />
              <YAxis width={48} domain={[0, 'auto']} tick={{ fill: 'var(--muted)', fontSize: 12 }} tickFormatter={value => String(value).replace('.', ',')} />
              <Line dataKey="value" type="linear" stroke={key === 'glucose' ? 'var(--accent)' : 'var(--warning)'} strokeWidth={2} dot={{ r: 4 }} activeDot={false} isAnimationActive={false} />
              {time !== null && <ReferenceLine x={time} stroke="var(--text)" strokeDasharray="4 4" />}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="diabetes-day-tooltip" aria-live="polite">
          {time === null ? <p className="muted">{values.length ? 'Выберите время события' : `Нет ${key === 'glucose' ? 'измерений сахара' : 'записей подколок'}.`}</p>
            : <div role="tooltip" aria-label={label}>
              <strong>{clock(time)}</strong>
              {matches.map((point, index) => <p key={point.id}>{matches.length > 1 && `Запись ${index + 1}: `}{point[key] === null ? 'Сахар не указан' : `${point[key]!.replace('.', ',')} ${unit}`}</p>)}
            </div>}
        </div>
      </div>
    })}
  </div>
}
